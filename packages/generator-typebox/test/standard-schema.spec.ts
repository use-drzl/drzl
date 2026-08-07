/**
 * The Standard Schema wrapper, checked by running it.
 *
 * TypeBox is the one validator DRZL emits that carries no `~standard` key. Measured on
 * `@sinclair/typebox` 0.34.52: a bare `Type.Object()` has own keys `type,required,properties` and
 * one symbol, and the package exports nothing matching `/standard/i` from its root or its `value`
 * subpath. zod 4.4.3, valibot 1.4.2 and arktype 2.2.3 all carry one; effect 3.22.1 does not on a
 * bare `Schema.Struct` and does on `Schema.standardSchemaV1(T)`. So TypeBox is the gap, and it is
 * the reason both the tRPC and the oRPC generators exclude it.
 *
 * Everything here asserts on behaviour rather than on emitted text: the module is written, then
 * imported, then handed values. A text assertion would pass on a wrapper that reports an empty
 * `issues` array, which reads to a consumer as a rejection with no reason.
 */
import { describe, it, expect } from 'vitest';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TypeBoxGenerator } from '../src/index';
import { Value } from '@sinclair/typebox/value';

const col = (name: string, over: Partial<Column> = {}): Column =>
  ({
    name,
    tsType: 'string',
    dbType: 'TEXT',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

let seq = 0;

async function emit(
  columns: Column[],
  opts: Record<string, unknown> = {},
  checks: { name?: string; expression?: string }[] = []
) {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-standard', `run-${process.pid}-${seq++}`);
  await fs.mkdir(dir, { recursive: true });
  await new TypeBoxGenerator(analysis).generate({
    outDir: dir,
    // `ts` rather than the default `js` so vitest resolves the sibling helper without a plugin.
    // The `js` form is what a consumer gets and is asserted on its own below.
    importExtension: 'ts',
    ...opts,
  } as never);
  return {
    dir,
    module: path.join(dir, 't.typebox.ts'),
    helper: path.join(dir, 'standard-schema.ts'),
    index: path.join(dir, 'index.ts'),
  };
}

async function load(columns: Column[], opts: Record<string, unknown> = {}, checks = []) {
  const out = await emit(columns, { standardSchema: true, ...opts }, checks);
  return { ...out, mod: (await import(out.module)) as Record<string, any> };
}

/** The `~standard` props, however they were attached. */
const std = (schema: unknown) => (schema as Record<string, any>)['~standard'];

const COLS = [
  col('id', { tsType: 'number', dbType: 'INTEGER', integer: true } as never),
  col('name'),
];

describe('off by default', () => {
  it('writes no helper module and attaches nothing', async () => {
    const out = await emit(COLS);
    await expect(fs.access(out.helper)).rejects.toThrow();
    const mod = await import(out.module);
    expect('~standard' in mod.SelecttSchema).toBe(false);
  });
});

describe('standardSchema: true', () => {
  it('writes the helper module once for the directory', async () => {
    const out = await emit(COLS, { standardSchema: true });
    await expect(fs.access(out.helper)).resolves.toBeUndefined();
    const helper = await fs.readFile(out.helper, 'utf8');
    expect(helper).toContain('export function toStandardSchema');
  });

  it('attaches a v1 `~standard` naming DRZL as the vendor', async () => {
    const { mod } = await load(COLS);
    for (const name of ['InserttSchema', 'UpdatetSchema', 'SelecttSchema']) {
      const s = std(mod[name]);
      expect(s, name).toBeTruthy();
      expect(s.version, name).toBe(1);
      // DRZL implements this, not TypeBox. A tool keying on `typebox` must not match, because a
      // first-party TypeBox implementation would report different issues than these.
      expect(s.vendor, name).toBe('drzl/typebox');
      expect(typeof s.validate, name).toBe('function');
    }
  });

  it('accepts a good value and returns it', () => {
    return load(COLS).then(({ mod }) => {
      const r = std(mod.SelecttSchema).validate({ id: 1, name: 'a' });
      expect(r).not.toBeInstanceOf(Promise);
      expect(r.issues).toBeUndefined();
      expect(r.value).toEqual({ id: 1, name: 'a' });
    });
  });

  it('refuses a bad one with a message and a path array', async () => {
    const { mod } = await load(COLS);
    const r = std(mod.SelecttSchema).validate({ id: 'x', name: 'a' });
    expect(r.value).toBeUndefined();
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.issues[0]).toEqual({ message: 'Expected integer', path: ['id'] });
  });

  it('never reports a failure with no issues', async () => {
    const { mod } = await load(COLS);
    for (const bad of [null, undefined, 42, 'x', [], { id: 1 }, { id: 1, name: 2 }]) {
      const r = std(mod.SelecttSchema).validate(bad);
      expect(r.issues, JSON.stringify(bad)).toBeTruthy();
      expect(r.issues.length, JSON.stringify(bad)).toBeGreaterThan(0);
      for (const issue of r.issues) expect(typeof issue.message).toBe('string');
    }
  });

  it('leaves the schema a TypeBox schema', async () => {
    const { mod } = await load(COLS);
    expect(Value.Check(mod.SelecttSchema, { id: 1, name: 'a' })).toBe(true);
    expect(Value.Check(mod.SelecttSchema, { id: 1.5, name: 'a' })).toBe(false);
  });

  it('leaves the JSON Schema document byte-identical', async () => {
    const plain = await emit(COLS);
    const wrapped = await load(COLS);
    const before = await import(plain.module);
    expect(JSON.stringify(wrapped.mod.SelecttSchema)).toBe(JSON.stringify(before.SelecttSchema));
    expect(Object.keys(wrapped.mod.SelecttSchema)).toEqual(Object.keys(before.SelecttSchema));
  });
});

describe('the path a consumer gets', () => {
  it('reports an array index as a number, as zod, valibot and arktype all do', async () => {
    const { mod } = await load([
      // The analyzer keeps an array on its element's type and counts the dimensions separately,
      // exactly as Drizzle does, so this is a `text[]`.
      col('tags', { tsType: 'string', dbType: 'TEXT', arrayDimensions: 1 } as never),
    ]);
    const r = std(mod.SelecttSchema).validate({ tags: ['a', 3] });
    expect(r.issues[0].path).toEqual(['tags', 1]);
  });

  it('unescapes a JSON Pointer', async () => {
    const { mod } = await load([col('a/b', { tsType: 'number', dbType: 'INTEGER' } as never)]);
    const r = std(mod.SelecttSchema).validate({ 'a/b': 'no' });
    expect(r.issues[0].path).toEqual(['a/b']);
  });

  it('is empty when the whole value is wrong', async () => {
    const { mod } = await load(COLS);
    const r = std(mod.SelecttSchema).validate(42);
    expect(r.issues[0].path).toEqual([]);
  });
});

describe('a constraint TypeBox states as a registered kind', () => {
  it('reports what the constraint says, not "Expected kind"', async () => {
    const { mod } = await load([col('code', { maxLength: 3 } as never)]);
    const r = std(mod.SelecttSchema).validate({ code: 'abcd' });
    const messages = r.issues.map((i: { message: string }) => i.message);
    expect(messages.some((m: string) => m.includes('3'))).toBe(true);
    expect(messages.every((m: string) => !m.includes('Expected kind'))).toBe(true);
  });

  /**
   * `Value.Check` stops an intersection at its first failing branch and `Value.Errors` does not,
   * so a predicate beside `Type.String()` is reached with whatever was passed. `[...123]` throws,
   * and a real tRPC route answered `v is not iterable` with a 400 rather than naming the type it
   * wanted. Both halves are pinned: the predicate no longer throws, and the wrapper survives one
   * that does.
   */
  it('does not throw when the value is not even the right type', async () => {
    const { mod } = await load([col('code', { maxLength: 3 } as never)]);
    const r = std(mod.SelecttSchema).validate({ code: 123 });
    expect(r.issues.map((i: { message: string }) => i.message)).toContain('Expected string');
    expect(
      r.issues.every((i: { message: string }) => !/not iterable|undefined/.test(i.message))
    ).toBe(true);
  });

  it('keeps what it collected when a predicate throws anyway', async () => {
    const { helper } = await emit(COLS, { standardSchema: true });
    const { toStandardSchema } = await import(helper);
    const { Type, Kind, TypeRegistry } = await import('@sinclair/typebox');
    TypeRegistry.Set('DrzlRowCheck', (s: any, v: any) => s.assert(v));
    const hostile = toStandardSchema(
      Type.Object({
        a: Type.Intersect([
          Type.String(),
          Type.Unsafe<unknown>({
            [Kind]: 'DrzlRowCheck',
            description: 'throws on anything but a string',
            assert: (v: any) => (v as string).length < 3,
          }),
        ]),
      })
    );
    const r = hostile['~standard'].validate({ a: null });
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.issues[0].message).toBe('Expected string');
  });
});

describe('a constraint inside a union, which is what a nullable column emits', () => {
  it('reports the branch failure rather than "Expected union value"', async () => {
    const { mod } = await load([col('code', { maxLength: 3, nullable: true } as never)]);
    const r = std(mod.SelecttSchema).validate({ code: 'abcd' });
    // The first issue is the one tRPC turns into the error message, so ordering is the assertion.
    expect(r.issues[0]).toEqual({ message: 'at most 3 characters', path: ['code'] });
    expect(r.issues.every((i: { message: string }) => i.message !== 'Expected union value')).toBe(
      true
    );
  });

  it('still takes null', async () => {
    const { mod } = await load([col('code', { maxLength: 3, nullable: true } as never)]);
    expect(std(mod.SelecttSchema).validate({ code: null }).issues).toBeUndefined();
  });
});

describe('the emitted cap predicate', () => {
  it('is total, so Value.Errors can walk it', async () => {
    const { mod } = await load([col('code', { maxLength: 3 } as never)]);
    const { Value } = await import('@sinclair/typebox/value');
    for (const bad of [123, null, undefined, {}, [], true]) {
      expect(() => [...Value.Errors(mod.SelecttSchema, { code: bad })], String(bad)).not.toThrow();
    }
  });

  it('still refuses an over-long string and takes a short one', async () => {
    const { mod } = await load([col('code', { maxLength: 3 } as never)]);
    const { Value } = await import('@sinclair/typebox/value');
    expect(Value.Check(mod.SelecttSchema, { code: 'abc' })).toBe(true);
    expect(Value.Check(mod.SelecttSchema, { code: 'abcd' })).toBe(false);
    expect(Value.Check(mod.SelecttSchema, { code: 123 })).toBe(false);
  });
});

describe('the emitted module', () => {
  it('imports the helper with the configured extension form', async () => {
    const js = await emit(COLS, { standardSchema: true, importExtension: 'js' });
    expect(await fs.readFile(js.module, 'utf8')).toContain("from './standard-schema.js'");
    const none = await emit(COLS, { standardSchema: true, importExtension: 'none' });
    expect(await fs.readFile(none.module, 'utf8')).toContain("from './standard-schema'");
  });

  it('is named in the barrel', async () => {
    const out = await emit(COLS, { standardSchema: true, importExtension: 'js' });
    expect(await fs.readFile(out.index, 'utf8')).toContain("export * from './standard-schema.js'");
  });

  it('imports the helper only when the option is on', async () => {
    const off = await emit(COLS);
    expect(await fs.readFile(off.module, 'utf8')).not.toContain('standard-schema');
    expect(await fs.readFile(off.index, 'utf8')).not.toContain('standard-schema');
  });
});

describe('nested relation schemas', () => {
  it('carry a `~standard` too', async () => {
    const analysis: Analysis = {
      dialect: 'postgres',
      tables: [
        {
          name: 'users',
          tsName: 'users',
          columns: [col('id', { tsType: 'number', dbType: 'INTEGER', integer: true } as never)],
          unique: [],
          indexes: [],
          checks: [],
        },
        {
          name: 'posts',
          tsName: 'posts',
          columns: [
            col('id', { tsType: 'number', dbType: 'INTEGER', integer: true } as never),
            col('userId', { tsType: 'number', dbType: 'INTEGER', integer: true } as never),
          ],
          unique: [],
          indexes: [],
          checks: [],
          foreignKeys: [{ columns: ['userId'], foreignTable: 'users', foreignColumns: ['id'] }],
        },
      ] as never,
      enums: [],
      relations: [
        { kind: 'one', from: 'posts', to: 'users' },
        { kind: 'many', from: 'users', to: 'posts' },
      ] as never,
      issues: [],
    };
    const dir = path.join(__dirname, '.tmp-standard', `nested-${process.pid}-${seq++}`);
    await fs.mkdir(dir, { recursive: true });
    await new TypeBoxGenerator(analysis).generate({
      outDir: dir,
      importExtension: 'ts',
      standardSchema: true,
      nestedSchemas: true,
    } as never);
    const mod = await import(path.join(dir, 'users.typebox.ts'));
    const nested = Object.keys(mod).filter((k) => k.startsWith('Nested'));
    expect(nested.length).toBeGreaterThan(0);
    for (const name of nested) {
      if (typeof mod[name] !== 'object') continue;
      expect(std(mod[name]), name).toBeTruthy();
      expect(std(mod[name]).version, name).toBe(1);
    }
  });
});
