/**
 * `applyDefaults` over every shape a Drizzle default comes in, end to end: a real Drizzle table,
 * the real analyzer, the real generator, and the emitted module *imported and run*.
 *
 * Importing is the point. ArkType checks a default against its own type when the module loads,
 * so a default it cannot hold is not a wrong verdict on a row, it is a `ParseError` that takes
 * the whole file and everything importing it with it. Measured before the fix, on arktype 2.2.3
 * and drizzle-orm 0.45.2, five of the shapes below threw at import and one killed the generator
 * itself:
 *
 *   varchar(2).default('GB')      ParseError: Defaultable definitions like 'number = 0' are only
 *                                 valid as properties in an object or tuple
 *   varchar(2).default(null)      the same
 *   jsonb().default({a:1})        ParseError: '{"a"' is unresolvable
 *   text().array().default(['a']) ParseError: Expected an expression before '["a"]'
 *   timestamp().default(date)     ParseError: Default for x must be a Date (was string), under
 *                                 coerceDates: 'none'
 *   doublePrecision().default(Infinity)
 *                                 ParseError: Default for x must be a number (was null), because
 *                                 `JSON.stringify` turns Infinity into null
 *   bigint().default(7n)          TypeError: Do not know how to serialize a BigInt, thrown by the
 *                                 generator before any file was written
 *
 * and one more was silent: a bigint column's range narrow was dropped from the insert schema
 * whenever a default was applied, so insert accepted `2n ** 70n` while update and select refused
 * it. The full measurement is in `.superpowers/sdd/2026-08-03-top-100/arktype-applydefaults-report.md`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer, type Analysis } from '@drzl/analyzer';
import { ArkTypeGenerator } from '../src/index';
import { type } from 'arktype';

const dir = path.join(__dirname, '.tmp-default-shapes');

/**
 * One table per shape, so a module that will not load takes only its own shape down with it
 * rather than hiding every other assertion behind the first failure.
 *
 * `.mjs` rather than `.ts`: the fixture is loaded by the analyzer, never compiled, and a `.ts`
 * file here would be pulled into this package's `tsc` run.
 */
const SOURCE = `
import { sql } from 'drizzle-orm';
import {
  pgTable, pgEnum, text, varchar, integer, smallint, bigint, doublePrecision,
  timestamp, boolean, jsonb,
} from 'drizzle-orm/pg-core';

export const mood = pgEnum('mood', ['sad', 'ok', 'happy']);
const T = (name, col) => pgTable(name, { name: text('name').notNull(), x: col });

export const litString = T('lit_string', text('x').notNull().default('hello'));
export const litVarchar = T('lit_varchar', varchar('x', { length: 2 }).notNull().default('GB'));
export const litEnum = T('lit_enum', mood('x').notNull().default('ok'));
export const litFalse = T('lit_false', boolean('x').notNull().default(false));
export const defNow = T('def_now', timestamp('x').notNull().defaultNow());
export const defFn = T('def_fn', text('x').notNull().$defaultFn(() => 'generated'));
export const defSql = T('def_sql', text('x').notNull().default(sql\`'eu'\`));
export const nullDefault = T('null_default', text('x').default(null));
export const nullDefaultVarchar = T('null_default_varchar', varchar('x', { length: 2 }).default(null));
export const boundedInt = T('bounded_int', smallint('x').notNull().default(3));
export const infiniteNum = T('infinite_num', doublePrecision('x').notNull().default(Infinity));
export const jsonDefault = T('json_default', jsonb('x').notNull().default({ a: 1 }));
export const arrayDefault = T('array_default', text('x').array().notNull().default(['a']));
export const dateDefault = T('date_default', timestamp('x').notNull().default(new Date('2020-01-01T00:00:00.000Z')));
export const bigintDefault = T('bigint_default', bigint('x', { mode: 'bigint' }).notNull().default(7n));
export const bigintNullDefault = T('bigint_null_default', bigint('x', { mode: 'bigint' }).default(null));
export const plainInt = T('plain_int', integer('x').notNull());
`;

let analysis: Analysis;
let seq = 0;

beforeAll(async () => {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'shapes.schema.mjs');
  await fs.writeFile(file, SOURCE, 'utf8');
  analysis = await new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({});
  expect(analysis.tables.length, JSON.stringify(analysis.issues)).toBeGreaterThan(0);
});

/** The emitted module for one table, imported. A per-call directory: the module cache is global. */
async function emit(
  tsName: string,
  opts: Record<string, unknown> = {}
): Promise<Record<string, any>> {
  const table = analysis.tables.find((t) => t.tsName === tsName);
  expect(table, `no table ${tsName}; got ${analysis.tables.map((t) => t.tsName).join(', ')}`).toBeTruthy();
  const outDir = path.join(dir, `out-${tsName}-${process.pid}-${seq++}`);
  await new ArkTypeGenerator({ ...analysis, tables: [table!] }).generate({
    outDir,
    applyDefaults: true,
    ...opts,
  } as never);
  return await import(path.join(outDir, `${tsName}.arktype.ts`));
}

const schemas = (m: Record<string, any>) => ({
  insert: m[Object.keys(m).find((k) => k.startsWith('Insert') && k.endsWith('Schema'))!],
  update: m[Object.keys(m).find((k) => k.startsWith('Update') && k.endsWith('Schema'))!],
  select: m[Object.keys(m).find((k) => k.startsWith('Select') && k.endsWith('Schema'))!],
});

/** The parsed row, or the error summary as a string. Never a thrown value: both are outcomes. */
const run = (schema: any, input: unknown): any => {
  const out = schema(input);
  return out instanceof type.errors ? `ERR: ${out.summary}` : out;
};

describe('a literal default is reproduced', () => {
  it('on an unbounded string', async () => {
    const { insert } = schemas(await emit('litString'));
    expect(run(insert, { name: 'a' })).toEqual({ name: 'a', x: 'hello' });
    expect(run(insert, { name: 'a', x: 'other' })).toEqual({ name: 'a', x: 'other' });
  });

  it('on an enum column', async () => {
    const { insert } = schemas(await emit('litEnum'));
    expect(run(insert, { name: 'a' })).toEqual({ name: 'a', x: 'ok' });
  });

  it('on a boolean, including the falsy value', async () => {
    const { insert } = schemas(await emit('litFalse'));
    expect(run(insert, { name: 'a' })).toEqual({ name: 'a', x: false });
  });

  it('on a bounded numeric column, without losing the bound', async () => {
    const { insert } = schemas(await emit('boundedInt'));
    expect(run(insert, { name: 'a' })).toEqual({ name: 'a', x: 3 });
    expect(run(insert, { name: 'a', x: 99999 })).toContain('ERR');
    expect(run(insert, { name: 'a', x: 1.5 })).toContain('ERR');
  });

  it('on a capped string column, without losing the cap', async () => {
    // The module used to throw at import: the cap forces the field to hold a Type instance, and
    // `type("string = 'GB'")` is not a type ArkType will build.
    const { insert } = schemas(await emit('litVarchar'));
    expect(run(insert, { name: 'a' })).toEqual({ name: 'a', x: 'GB' });
    expect(run(insert, { name: 'a', x: 'TOOLONG' })).toContain('ERR');
    // Two characters, four UTF-16 units: the cap counts characters, and applying a default must
    // not have quietly swapped it for `string <= 2`.
    expect(run(insert, { name: 'a', x: '👍👍' })).toEqual({ name: 'a', x: '👍👍' });
  });
});

describe('a default the schema cannot reproduce leaves the key optional', () => {
  it('defaultNow()', async () => {
    const { insert } = schemas(await emit('defNow'));
    expect(run(insert, { name: 'a' })).toEqual({ name: 'a' });
  });

  it('a raw sql default', async () => {
    const { insert } = schemas(await emit('defSql'));
    expect(run(insert, { name: 'a' })).toEqual({ name: 'a' });
  });

  it('a $defaultFn', async () => {
    const { insert } = schemas(await emit('defFn'));
    expect(run(insert, { name: 'a' })).toEqual({ name: 'a' });
  });

  it('a value JSON.stringify would change: Infinity is not null', async () => {
    // `JSON.stringify(Infinity)` is the string "null", so the emitted default was `= null` on a
    // non-nullable number: ParseError at import, and had it loaded it would have written the
    // wrong value.
    const { insert } = schemas(await emit('infiniteNum'));
    expect(run(insert, { name: 'a' })).toEqual({ name: 'a' });
    expect(run(insert, { name: 'a', x: 1.5 })).toEqual({ name: 'a', x: 1.5 });
  });
});

describe('a default whose value the string DSL cannot carry', () => {
  it('null on a nullable column', async () => {
    const { insert } = schemas(await emit('nullDefault'));
    expect(run(insert, { name: 'a' })).toEqual({ name: 'a', x: null });
  });

  it('null on a nullable capped column', async () => {
    const { insert } = schemas(await emit('nullDefaultVarchar'));
    expect(run(insert, { name: 'a' })).toEqual({ name: 'a', x: null });
    expect(run(insert, { name: 'a', x: 'TOOLONG' })).toContain('ERR');
  });

  it('a json object', async () => {
    const { insert } = schemas(await emit('jsonDefault'));
    expect(run(insert, { name: 'a' })).toEqual({ name: 'a', x: { a: 1 } });
  });

  it('a json object is fresh per parse, not one shared instance', async () => {
    const { insert } = schemas(await emit('jsonDefault'));
    const first = run(insert, { name: 'a' });
    first.x.a = 99;
    expect(run(insert, { name: 'a' })).toEqual({ name: 'a', x: { a: 1 } });
  });

  it('an array', async () => {
    const { insert } = schemas(await emit('arrayDefault'));
    expect(run(insert, { name: 'a' })).toEqual({ name: 'a', x: ['a'] });
  });

  it('a bigint', async () => {
    // `JSON.stringify(7n)` throws, which killed the generator before it wrote anything.
    const { insert } = schemas(await emit('bigintDefault'));
    expect(run(insert, { name: 'a' })).toEqual({ name: 'a', x: 7n });
  });

  it('a Date, under every coerceDates setting', async () => {
    const iso = '2020-01-01T00:00:00.000Z';
    for (const coerceDates of ['input', 'none', 'all'] as const) {
      const { insert } = schemas(await emit('dateDefault', { coerceDates }));
      const row = run(insert, { name: 'a' });
      expect(row, `coerceDates: ${coerceDates}`).toMatchObject({ name: 'a' });
      // A Date, not the ISO string: the select schema types this column as a Date, and under
      // `coerceDates: 'none'` so does the insert schema, which refused a string outright.
      expect(row.x, `coerceDates: ${coerceDates}`).toBeInstanceOf(Date);
      expect((row.x as Date).toISOString(), `coerceDates: ${coerceDates}`).toBe(iso);
    }
  });
});

describe('applying a default does not drop a constraint', () => {
  it('a bigint column keeps its range in the insert schema too', async () => {
    // The range rides a narrow, because ArkType's DSL cannot state a bigint bound at all. That
    // narrow was dropped whenever a default was applied, so the same value got three different
    // verdicts from the three schemas of one column.
    const m = await emit('bigintNullDefault');
    const { insert, update, select } = schemas(m);
    const tooBig = 2n ** 70n;
    expect(run(insert, { name: 'a' })).toEqual({ name: 'a', x: null });
    expect(run(insert, { name: 'a', x: tooBig })).toContain('ERR');
    expect(run(update, { name: 'a', x: tooBig })).toContain('ERR');
    expect(run(select, { name: 'a', x: tooBig })).toContain('ERR');
    expect(run(insert, { name: 'a', x: 7n })).toEqual({ name: 'a', x: 7n });
  });
});

describe('with applyDefaults off', () => {
  it('every defaulted key is merely optional and nothing is filled in', async () => {
    for (const t of ['litString', 'litVarchar', 'jsonDefault', 'bigintDefault', 'dateDefault']) {
      const { insert } = schemas(await emit(t, { applyDefaults: false }));
      expect(run(insert, { name: 'a' }), t).toEqual({ name: 'a' });
    }
  });

  it('a column with no default at all stays required', async () => {
    const { insert } = schemas(await emit('plainInt'));
    expect(run(insert, { name: 'a' })).toContain('ERR');
  });
});
