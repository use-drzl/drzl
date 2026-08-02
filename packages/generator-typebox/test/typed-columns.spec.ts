/**
 * `typedColumns` in the TypeBox generator.
 *
 * `.$type<T>()` is a compile-time cast on any column: `text().$type<'admin' | 'member'>()` is an
 * ordinary string to anything reading the column at runtime, so `drizzle-orm/typebox` and DRZL
 * alike emitted a plain `Type.String()` and the narrowing was lost.
 *
 * `Type.Unsafe<T>(schema)` is TypeBox's own primitive for this: it wraps an existing schema, so
 * every check it carries still runs and only the inferred type is replaced. That is why this
 * generator can do what the ArkType one cannot, since ArkType emits one string per field and a
 * TypeScript type reference has nowhere to live inside a string DSL.
 */
import { describe, it, expect } from 'vitest';
import { TypeBoxGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { Value } from '@sinclair/typebox/value';
import { promises as fs } from 'node:fs';
import path from 'node:path';

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

async function emit(columns: Column[], opts: Record<string, unknown>): Promise<string> {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks: [] }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = await fs.mkdtemp(path.join(__dirname, '.tmp-typedcols-'));
  await new TypeBoxGenerator(analysis).generate({
    outDir: dir,
    schemaPath: path.join(dir, '..', 'db', 'schema.ts'),
    ...opts,
  } as never);
  const src = await fs.readFile(path.join(dir, 't.typebox.ts'), 'utf8');
  await fs.rm(dir, { recursive: true, force: true });
  return src;
}

async function schemasFor(columns: Column[], opts: Record<string, unknown>) {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks: [] }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-typedcols-run');
  await fs.mkdir(dir, { recursive: true });
  await new TypeBoxGenerator(analysis).generate({ outDir: dir, ...opts } as never);
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.typebox.ts'), file);
  return await import(file);
}

describe('off by default', () => {
  it('adds nothing when neither option is set', async () => {
    // A uuid format, not a length cap: a cap is intersected onto the object now, which would put
    // `Type.Unsafe` in the file for reasons that have nothing to do with this option.
    const src = await emit([col('role', { format: 'uuid' })], {});
    expect(src).not.toContain('Type.Unsafe');
    expect(src).not.toContain('import type { t }');
  });

  it('is not turned on by typedJson, which covers only the untyped columns', async () => {
    const src = await emit([col('role', { format: 'uuid' })], { typedJson: true });
    expect(src).not.toContain('Type.Unsafe');
  });
});

describe('with typedColumns', () => {
  it('wraps the schema rather than replacing it', async () => {
    const src = await emit([col('role', { format: 'uuid' })], { typedColumns: true });
    // Prettier wraps this across lines, so the source is flattened before matching.
    const flat = src.replace(/\s+/g, ' ');
    expect(flat).toMatch(
      /Type\.Unsafe<\(typeof t\.\$inferSelect\)\[['"]role['"]\]>\( ?Type\.String\(\{ pattern: /
    );
  });

  it('keeps every runtime check the wrapped schema carried', async () => {
    // This is the whole point of `Type.Unsafe` over substitution: the checks still run.
    const m = await schemasFor([col('role', { format: 'uuid' })], {
      typedColumns: true,
      schemaPath: path.join(__dirname, '..', 'db', 'schema.ts'),
    });
    const s = m.SelecttSchema;
    expect(Value.Check(s, { role: '00000000-0000-0000-0000-000000000000' }), 'a uuid').toBe(true);
    expect(Value.Check(s, { role: 'nope' }), 'not a uuid').toBe(false);
    expect(Value.Check(s, { role: 5 }), 'wrong type').toBe(false);
  });

  it('still substitutes for a column with no runtime type', async () => {
    // A json column has nothing worth checking, so the reference replaces the schema outright
    // rather than wrapping a `Type.Unknown()` that says nothing.
    const src = await emit([col('doc', { tsType: 'any', shape: { kind: 'json' } })], {
      typedColumns: true,
    });
    expect(src).toMatch(
      /Type\.Unsafe<\(typeof t\.\$inferSelect\)\[['"]doc['"]\]>\(Type\.Unknown\(\)\)/
    );
  });

  it('implies typedJson, since both need the schema imported back', async () => {
    const src = await emit([col('doc', { tsType: 'any', shape: { kind: 'json' } })], {
      typedColumns: true,
    });
    expect(src).toMatch(/import type \{ t \} from/);
  });
});
