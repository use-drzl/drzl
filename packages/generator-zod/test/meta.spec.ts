/**
 * `meta`: the facts the analyzer knows and a zod schema cannot state.
 *
 * Two things are being proved here, and both are read off a real emitted module rather than out of
 * its source text.
 *
 * **The metadata survives the wrappers.** This is the whole design problem. `.meta()` returns a
 * clone that carries the entry, so `.refine()`, `.min()` and `.describe()` keep it; but
 * `.nullable()`, `.optional()`, `.default()`, `z.array()` and `.pipe()` build a *new* schema
 * around the old one, and the new one has no entry at all. Measured on zod 4.4.3:
 * `z.string().meta({ x: 1 }).nullable().meta()` is `undefined`, and the value is only reachable
 * through `.def.innerType`, which is an internal a consumer has no business walking. DRZL wraps
 * every nullable column and every field of an update schema, so attaching before the wrapper
 * loses the metadata for most of the output. The generator therefore attaches last, after every
 * wrapper, which is also the position that puts it beside `anyOf` in the JSON Schema rather than
 * inside one arm of it.
 *
 * **It reaches JSON Schema.** `z.toJSONSchema` copies arbitrary meta keys through, and it drops
 * every `.refine()` in silence. So a declared width, which DRZL enforces as a refinement, is
 * absent from the JSON Schema of an emitted module and nothing says so. `maxLength` in the
 * metadata is the same word JSON Schema uses, so it puts that constraint back where a validator
 * will act on it.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Analysis, Column, Relation, Table } from '@drzl/analyzer';
import { ZodGenerator } from '../src/index';

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

const table = (name: string, cols: Column[], over: Partial<Table> = {}): Table =>
  ({ name, tsName: name, columns: cols, unique: [], indexes: [], checks: [], ...over }) as Table;

const users = table(
  'user_accounts',
  [
    col('id', {
      tsType: 'number',
      dbType: 'INTEGER',
      sqlType: 'serial',
      integer: true,
      isGenerated: true,
      hasDefault: true,
    }),
    col('name', { sqlType: 'varchar(40)', maxLength: 40 }),
    col('bio', { sqlType: 'text', nullable: true }),
    col('country', { sqlType: 'char(2)', maxLength: 2, hasDefault: true, defaultValue: 'GB' }),
    col('tags', { sqlType: 'text[]', arrayDimensions: 1 }),
    col('age', { tsType: 'number', dbType: 'INTEGER', sqlType: 'integer', nullable: true }),
  ],
  {
    primaryKey: { columns: ['id'] },
    unique: [{ columns: ['name'] }],
    checks: [
      { name: 'adult', expression: 'age >= 18' },
      { name: 'weird', expression: 'my_fn(name) > now()' },
    ],
  }
);

const posts = table(
  'posts',
  [
    col('id', { tsType: 'number', dbType: 'INTEGER', sqlType: 'serial', isGenerated: true }),
    col('userId', { tsType: 'number', dbType: 'INTEGER', sqlType: 'integer' }),
    col('title', { sqlType: 'varchar(80)', maxLength: 80 }),
  ],
  {
    primaryKey: { columns: ['id'] },
    foreignKeys: [{ columns: ['userId'], foreignTable: 'user_accounts', foreignColumns: ['id'] }],
  }
);

const RELATIONS: Relation[] = [
  { kind: 'many', from: 'user_accounts', to: 'posts' },
  { kind: 'one', from: 'posts', to: 'user_accounts' },
];

const analysis = (): Analysis => ({
  dialect: 'postgres',
  tables: [users, posts],
  enums: [],
  relations: RELATIONS,
  issues: [],
});

let seq = 0;

async function emit(opts: Record<string, unknown>, which = 'user_accounts') {
  const dir = path.join(__dirname, '.tmp-meta', `run-${process.pid}-${seq++}`);
  await fs.mkdir(dir, { recursive: true });
  await new ZodGenerator(analysis()).generate({ outDir: dir, ...opts } as never);
  const file = path.join(dir, `${which}.zod.ts`);
  return { mod: await import(file), text: await fs.readFile(file, 'utf8') };
}

describe('off by default', () => {
  it('emits no metadata at all and no extra bytes', async () => {
    const plain = await emit({});
    expect(plain.text).not.toContain('.meta(');
    const off = await emit({ meta: false });
    expect(off.text).toBe(plain.text);
  });
});

describe('a field', () => {
  it('carries the SQL type, which nothing in the schema states', async () => {
    const { mod } = await emit({ meta: true });
    expect(mod.Selectuser_accountsSchema.shape.name.meta()).toMatchObject({
      sqlType: 'varchar(40)',
    });
  });

  it('is readable through .nullable(), which is where the naive attachment loses it', async () => {
    const { mod } = await emit({ meta: true });
    const bio = mod.Selectuser_accountsSchema.shape.bio;
    // Precisely the position that returns undefined when `.meta()` is applied before the wrapper.
    expect(bio.meta()).toMatchObject({ sqlType: 'text' });
    // And the wrapper still does its job.
    expect(bio.safeParse(null).success).toBe(true);
  });

  it('is readable through .optional() on an insert schema', async () => {
    const { mod } = await emit({ meta: true });
    const country = mod.Insertuser_accountsSchema.shape.country;
    expect(country.meta()).toMatchObject({ sqlType: 'char(2)', hasDefault: true, maxLength: 2 });
    expect(mod.Insertuser_accountsSchema.safeParse({ name: 'a', tags: [] }).success).toBe(true);
  });

  it('is readable through .optional() on every field of an update schema', async () => {
    const { mod } = await emit({ meta: true });
    for (const key of ['name', 'bio', 'country']) {
      expect(mod.Updateuser_accountsSchema.shape[key].meta(), key).toBeTruthy();
    }
  });

  it('is readable through .default(), which applyDefaults adds outside everything', async () => {
    const { mod } = await emit({ meta: true, applyDefaults: true });
    const country = mod.Insertuser_accountsSchema.shape.country;
    expect(country.meta()).toMatchObject({ sqlType: 'char(2)' });
    expect(country.parse(undefined)).toBe('GB');
  });

  it('is readable on an array column, where it describes the column and not the element', async () => {
    const { mod } = await emit({ meta: true });
    expect(mod.Selectuser_accountsSchema.shape.tags.meta()).toMatchObject({ sqlType: 'text[]' });
  });

  it('separates a database default from a nullable column', async () => {
    const { mod } = await emit({ meta: true });
    const shape = mod.Selectuser_accountsSchema.shape;
    expect(shape.country.meta().hasDefault).toBe(true);
    // Both are `.optional()` on insert; only one has a default.
    expect(shape.bio.meta().hasDefault).toBeUndefined();
  });

  it('marks the generated column, which the write schemas simply omit', async () => {
    const { mod } = await emit({ meta: true });
    expect(mod.Selectuser_accountsSchema.shape.id.meta()).toMatchObject({ generated: true });
    expect(Object.keys(mod.Insertuser_accountsSchema.shape)).not.toContain('id');
  });

  it('names the CHECK it enforces, in the spelling the failure message uses', async () => {
    const { mod } = await emit({ meta: true });
    expect(mod.Selectuser_accountsSchema.shape.age.meta().checks).toEqual(['adult: age >= 18']);
  });

  it('says nothing about nullability, which the schema already says', async () => {
    const { mod } = await emit({ meta: true });
    expect(Object.keys(mod.Selectuser_accountsSchema.shape.bio.meta())).not.toContain('nullable');
  });
});

describe('the table schema', () => {
  it('carries the SQL name, the dialect, the mode and the key', async () => {
    const { mod } = await emit({ meta: true });
    expect(mod.Selectuser_accountsSchema.meta()).toMatchObject({
      table: 'user_accounts',
      dialect: 'postgres',
      mode: 'select',
      primaryKey: ['id'],
      unique: [['name']],
    });
    expect(mod.Insertuser_accountsSchema.meta().mode).toBe('insert');
    expect(mod.Updateuser_accountsSchema.meta().mode).toBe('update');
  });

  it('names the CHECK it declined, which appears nowhere else in the module', async () => {
    const { mod, text } = await emit({ meta: true });
    expect(mod.Selectuser_accountsSchema.meta().unenforcedChecks).toEqual([
      'weird: my_fn(name) > now()',
    ]);
    // The point: without this the constraint is in the database and in no part of the output.
    const withoutMeta = (await emit({})).text;
    expect(withoutMeta).not.toContain('my_fn');
    expect(text).toContain('my_fn');
  });

  it('survives the row refinement that a row-level CHECK adds after the object', async () => {
    const rows = table(
      'spans',
      [
        col('lo', { tsType: 'number', sqlType: 'integer' }),
        col('hi', { tsType: 'number', sqlType: 'integer' }),
      ],
      { checks: [{ name: 'order', expression: 'lo < hi' }] }
    );
    const dir = path.join(__dirname, '.tmp-meta', `rows-${process.pid}-${seq++}`);
    await fs.mkdir(dir, { recursive: true });
    await new ZodGenerator({
      dialect: 'postgres',
      tables: [rows],
      enums: [],
      relations: [],
      issues: [],
    } as Analysis).generate({ outDir: dir, meta: true } as never);
    const mod = await import(path.join(dir, 'spans.zod.ts'));
    expect(mod.SelectspansSchema.meta()).toMatchObject({ checks: ['order: lo < hi'] });
    // The refinement is still enforced, so the metadata is not sitting on a schema that lost it.
    expect(mod.SelectspansSchema.safeParse({ lo: 2, hi: 1 }).success).toBe(false);
  });
});

describe('a nested schema', () => {
  it('is readable on the object inside the relation array', async () => {
    const { mod } = await emit({ meta: true, nestedSchemas: true });
    const posts = mod.NestedSelectuser_accountsSchema.shape.posts;
    // `z.array(child).optional()`: two wrappers between the caller and the child object.
    const child = posts.def.innerType.element;
    expect(child.meta()).toMatchObject({ table: 'posts', mode: 'select' });
    expect(child.shape.title.meta()).toMatchObject({ sqlType: 'varchar(80)' });
  });
});

describe('the JSON Schema it produces', () => {
  it('puts the metadata of a nullable column on the property, not inside a union arm', async () => {
    const { mod } = await emit({ meta: true });
    const doc: any = z.toJSONSchema(mod.Selectuser_accountsSchema);
    const bio = doc.properties.bio;
    expect(bio.sqlType).toBe('text');
    // How zod spells "nullable" in JSON Schema moved in 4.5: `anyOf: [{ type: 'string' },
    // { type: 'null' }]` became `type: ['string', 'null']`. Either way the null must be there, and
    // the metadata must sit on the property rather than inside an arm, which is the claim this
    // test exists for. Written to hold on both spellings so a zod bump cannot turn it into a
    // TypeError on a missing `anyOf`, which is what it was.
    const arms: any[] = bio.anyOf ?? [];
    const admitsNull =
      arms.some((a) => a.type === 'null') || (Array.isArray(bio.type) && bio.type.includes('null'));
    expect(admitsNull, 'the nullable column admits null in its JSON Schema').toBe(true);
    expect(arms.some((a) => 'sqlType' in a)).toBe(false);
  });

  it('carries the table facts at the document root', async () => {
    const { mod } = await emit({ meta: true });
    const doc: any = z.toJSONSchema(mod.Selectuser_accountsSchema);
    expect(doc).toMatchObject({ table: 'user_accounts', primaryKey: ['id'] });
  });

  it('restores the width that toJSONSchema drops with the refinement carrying it', async () => {
    const withMeta: any = z.toJSONSchema(
      (await emit({ meta: true })).mod.Selectuser_accountsSchema
    );
    const without: any = z.toJSONSchema((await emit({})).mod.Selectuser_accountsSchema);
    // The refinement enforcing `varchar(40)` is dropped in silence, so the plain document says the
    // column is an unbounded string.
    expect(without.properties.name.maxLength).toBeUndefined();
    expect(withMeta.properties.name.maxLength).toBe(40);
  });
});

describe('the description', () => {
  it('is absent unless asked for', async () => {
    const { mod } = await emit({ meta: true });
    expect(mod.Selectuser_accountsSchema.shape.name.meta().description).toBeUndefined();
    expect(mod.Selectuser_accountsSchema.meta().description).toBeUndefined();
  });

  it('states what the schema enforces and cannot show, where an OpenAPI reader looks', async () => {
    const { mod } = await emit({ meta: { description: true } });
    const doc: any = z.toJSONSchema(mod.Selectuser_accountsSchema);
    expect(doc.properties.name.description).toBe('at most 40 characters');
    expect(doc.properties.age.description).toBe('CHECK adult: age >= 18');
    expect(doc.description).toContain('not enforced by this schema');
  });
});

describe('the schemas themselves', () => {
  it('parse identically with the metadata on and off', async () => {
    const on = (await emit({ meta: true })).mod.Selectuser_accountsSchema;
    const off = (await emit({})).mod.Selectuser_accountsSchema;
    const rows = [
      { id: 1, name: 'ada', bio: null, country: 'GB', tags: ['a'], age: 30 },
      { id: 1, name: 'ada', bio: 'hi', country: 'GB', tags: [], age: null },
      { id: 1, name: 'x'.repeat(41), bio: null, country: 'GB', tags: [], age: 30 },
      { id: 1, name: 'ada', bio: null, country: 'GB', tags: [], age: 5 },
      { id: 1, name: 'ada', bio: null, country: 'GB', tags: 'nope', age: 30 },
    ];
    for (const row of rows) {
      expect(on.safeParse(row).success, JSON.stringify(row)).toBe(off.safeParse(row).success);
    }
  });
});
