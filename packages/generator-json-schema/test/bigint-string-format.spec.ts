/**
 * `bigint({ mode: 'string' })` bounded by the input syntax its server really accepts: real drizzle
 * v1 tables through the real analyzer, the resulting documents compiled by ajv in strict mode and
 * run against values.
 *
 * The defect, measured against a real Postgres through PGlite with the parity gate's own
 * MATRIX_POOL: the document said `{"type":"string"}` and nothing else, so on 14 of the 36 values
 * it accepted an insert Postgres refuses, with `drizzle-orm` agreeing with Postgres on every one
 * of them. The 14 are the whole of `PG_REFUSES` below.
 *
 * This is the format that carries the fact natively: `pattern` is a keyword every draft has, so
 * the statement here is the same string the four validation generators compile to a RegExp,
 * rather than an approximation of it. Not to be confused with the `bigint`-wire arm beside it,
 * which is a *bigint*-typed column serialised as a digit string; this one is a column whose
 * TypeScript type is already `string`, and the pattern is what the server will parse.
 *
 * The two servers disagree in both directions, so there are two patterns and not one. Postgres
 * stores `'0x1f'` as 31 and `'1_000'` as 1000 and refuses `'12.5'`; MySQL 8.4.11 refuses both of
 * the first two and stores `'12.5'` as 13, rounded.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { SchemaAnalyzer, type Table } from '@drzl/analyzer';
import { tableSchemas } from '../src/index';

const DIR = path.join(__dirname, '.tmp-bigint-string-format');

const PG_SCHEMA = `
  import { pgTable, bigint } from 'drizzle-orm-v1/pg-core';
  export const pgt = pgTable('pgt', { b: bigint('b', { mode: 'string' }).notNull() });
`;
const MY_SCHEMA = `
  import { mysqlTable, bigint } from 'drizzle-orm-v1/mysql-core';
  export const myt = mysqlTable('myt', {
    b: bigint('b', { mode: 'string' }).notNull(),
    u: bigint('u', { mode: 'string', unsigned: true }).notNull(),
  });
`;

/** Values a real Postgres stores in a `bigint` column, so the document must take every one. */
const PG_ADMITS = [
  '1',
  '-1',
  '0',
  '007',
  '+1',
  '  1  ',
  '1_000',
  '0x1f',
  '0X1F',
  '0xdead_beef',
  '0o17',
  '0b1010',
  '0101',
  '010',
  '9223372036854775807',
  '-9223372036854775808',
];
/** The 14 values Postgres refuses that the bare string accepted. */
const PG_REFUSES = [
  '',
  'hello',
  'x'.repeat(300),
  '\u{1F44D}\u{1F44D}\u{1F44D}',
  '\u{1F44D}'.repeat(5),
  '12.5',
  '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  'not-a-uuid',
  'happy',
  'zzz',
  '2020-01-01',
  '12:00:00',
  '10.0.0.1',
  '999.999.999.999',
];
/** Values MySQL 8.4.11 stores in a `bigint` column, rounding the fractional ones. */
const MY_ADMITS = [
  '1',
  '-1',
  '0',
  '007',
  '+1',
  '  1  ',
  '12.5',
  '1.5',
  '1e3',
  '.5',
  '1.',
  '9223372036854775807',
  '-9223372036854775808',
];
/** Values MySQL refuses outright, by "Incorrect integer value" or "Data truncated". */
const MY_REFUSES = [
  '',
  'hello',
  '1_000',
  '0x1f',
  '0b1010',
  'NaN',
  'Infinity',
  'not-a-uuid',
  '2020-01-01',
  '12:00:00',
  '10.0.0.1',
  '999.999.999.999',
  '\u{1F44D}\u{1F44D}\u{1F44D}',
];
/** What the read path hands back: the codec casts to text, so a stored row is plain digits. */
const RETURNED = ['1', '-1', '0', '31', '7', '1000', '9223372036854775807', '-9223372036854775808'];

let pgTable_: Table;
let myTable: Table;

beforeAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
  await fs.mkdir(DIR, { recursive: true });
  const analysed: Table[] = [];
  for (const [name, source] of [
    ['pg', PG_SCHEMA],
    ['my', MY_SCHEMA],
  ] as const) {
    const file = path.join(DIR, `${name}.mjs`);
    await fs.writeFile(file, source, 'utf8');
    const analysis = await new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({});
    expect(
      analysis.tables[0],
      `no table analyzed: ${JSON.stringify(analysis.issues)}`
    ).toBeTruthy();
    analysed.push(analysis.tables[0]);
  }
  [pgTable_, myTable] = analysed;
  await fs.rm(DIR, { recursive: true, force: true });
}, 120_000);

function compile(schema: unknown) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv as never);
  return ajv.compile(schema as never);
}

const show = (v: string) => (v.length > 20 ? `${v.length} chars` : JSON.stringify(v));

describe('the Postgres document, against what PGlite answered', () => {
  it('states the syntax as a pattern rather than leaving the string bare', () => {
    const s = tableSchemas(pgTable_).select as any;
    expect(s.properties.b.type).toBe('string');
    expect(typeof s.properties.b.pattern, 'a bare string is the defect').toBe('string');
  });

  it('takes every value the server stores, under ajv strict mode', () => {
    const ok = compile(tableSchemas(pgTable_).select);
    for (const v of [...PG_ADMITS, ...RETURNED]) {
      expect(ok({ b: v }), `Postgres stores ${show(v)}`).toBe(true);
    }
  });

  it('refuses all 14 the server rejects, on the insert document the gate grades', () => {
    const ok = compile(tableSchemas(pgTable_).insert);
    for (const v of PG_REFUSES) expect(ok({ b: v }), `Postgres refuses ${show(v)}`).toBe(false);
  });

  it('leaves the magnitude unstated, which is the one half of the fact this does not carry', () => {
    // Asserted rather than left implicit, so stating it later reports itself here rather than
    // going in silently. Postgres refuses both of these and this document takes them: the exact
    // bound is a per-digit ladder whose branch count exhausts ArkType's type-level budget, so
    // carrying it would emit an arktype module that does not compile. See COLUMN_FORMATS.
    const ok = compile(tableSchemas(pgTable_).select);
    expect(ok({ b: '9223372036854775808' })).toBe(true);
    expect(ok({ b: '-9223372036854775809' })).toBe(true);
  });
});

describe('the MySQL document, against what MySQL 8.4.11 answered', () => {
  it('takes every value the server stores, fractions included, because MySQL rounds them', () => {
    const ok = compile(tableSchemas(myTable).select);
    for (const v of MY_ADMITS) expect(ok({ b: v, u: '1' }), `MySQL stores ${show(v)}`).toBe(true);
  });

  it('refuses what MySQL refuses, including the two spellings Postgres accepts', () => {
    const ok = compile(tableSchemas(myTable).insert);
    for (const v of MY_REFUSES)
      expect(ok({ b: v, u: '1' }), `MySQL refuses ${show(v)}`).toBe(false);
  });

  it('takes the unsigned ceiling MySQL really stores, where drizzle-orm refuses it', () => {
    // Measured: a `bigint unsigned` stores 18446744073709551615 and hands it back, and
    // `drizzle-orm` at 1.0.0-rc.4 caps the same column at the signed int64 maximum, so its select
    // schema rejects a row the driver returns. That is an intended divergence.
    const ok = compile(tableSchemas(myTable).select);
    expect(ok({ b: '1', u: '18446744073709551615' })).toBe(true);
    expect(ok({ b: '1', u: '9223372036854775808' })).toBe(true);
  });
});
