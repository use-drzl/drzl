/**
 * `bigint({ mode: 'string' })` bounded by the input syntax its server really accepts, end to end:
 * real drizzle v1 tables through the real analyzer and the real valibot generator, with the emitted
 * output run against values.
 *
 * The defect, measured against a real Postgres through PGlite with the parity gate's own
 * MATRIX_POOL: the emitted schema was a bare string, and on 14 of the 36 values it accepted an
 * insert Postgres refuses, with `drizzle-orm` agreeing with Postgres on every one of them. The 14
 * are the whole of `PG_REFUSES` below.
 *
 * The two servers disagree in both directions, so there are two patterns and not one. Postgres
 * stores `'0x1f'` as 31 and `'1_000'` as 1000 and refuses `'12.5'`; MySQL 8.4.11 refuses both of
 * the first two and stores `'12.5'` as 13, rounded. Each list below is what that server answered.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as v from 'valibot';
import { SchemaAnalyzer } from '@drzl/analyzer';
import { ValibotGenerator } from '../src/index';

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

/** Values a real Postgres stores in a `bigint` column, so the schema must take every one. */
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

const show = (v: string) => (v.length > 20 ? `${v.length} chars` : JSON.stringify(v));

let pg: Record<string, any>;
let my: Record<string, any>;

beforeAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
  await fs.mkdir(DIR, { recursive: true });
  for (const source of [PG_SCHEMA, MY_SCHEMA]) {
    const file = path.join(DIR, `${source.includes('pgTable') ? 'pg' : 'my'}.mjs`);
    await fs.writeFile(file, source, 'utf8');
    const analysis = await new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({});
    expect(
      analysis.tables[0],
      `no table analyzed: ${JSON.stringify(analysis.issues)}`
    ).toBeTruthy();
    await new ValibotGenerator(analysis).generate({ outDir: DIR } as never);
  }
  const pgFile = path.join(DIR, `pgt-${process.pid}.ts`);
  await fs.rename(path.join(DIR, 'pgt.valibot.ts'), pgFile);
  pg = await import(pgFile);
  const myFile = path.join(DIR, `myt-${process.pid}.ts`);
  await fs.rename(path.join(DIR, 'myt.valibot.ts'), myFile);
  my = await import(myFile);
}, 120_000);

afterAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
});

const ok = (schema: any, value: unknown) => v.safeParse(schema, value).success;
const pgSelect = (x: string) => ok(pg.SelectpgtSchema.entries.b, x);
const pgInsert = (x: string) => ok(pg.InsertpgtSchema.entries.b, x);
const mySelect = (x: string) => ok(my.SelectmytSchema.entries.b, x);
const myInsert = (x: string) => ok(my.InsertmytSchema.entries.b, x);
const myUnsigned = (x: string) => ok(my.SelectmytSchema.entries.u, x);

describe('the Postgres column, against what PGlite answered', () => {
  it('takes every value the server stores', () => {
    for (const v of PG_ADMITS) expect(pgSelect(v), `Postgres stores ${show(v)}`).toBe(true);
  });

  it('refuses all 14 the server rejects, on the insert schema the gate grades', () => {
    for (const v of PG_REFUSES) expect(pgInsert(v), `Postgres refuses ${show(v)}`).toBe(false);
  });

  it('refuses them on select too, since none is a value the column can return', () => {
    for (const v of PG_REFUSES) expect(pgSelect(v)).toBe(false);
  });

  it('takes every value the read path hands back, which is plain digits', () => {
    // The `bigint:string` codec casts to text and registers no normalize, so a row written as
    // '0x1f' comes back '31' and one written as '007' comes back '7'. Measured through
    // drizzle-orm 1.0.0-rc.4 on PGlite.
    for (const v of RETURNED) expect(pgSelect(v)).toBe(true);
  });

  it('leaves the magnitude unstated, which is the one half of the fact this does not carry', () => {
    // Asserted rather than left implicit, so stating it later reports itself here rather than
    // going in silently. Postgres refuses both of these and this schema takes them: the exact
    // bound is a per-digit ladder whose branch count exhausts ArkType's type-level budget, so
    // carrying it would emit an arktype module that does not compile. See COLUMN_FORMATS.
    expect(pgSelect('9223372036854775808')).toBe(true);
    expect(pgSelect('-9223372036854775809')).toBe(true);
  });
});

describe('the MySQL column, against what MySQL 8.4.11 answered', () => {
  it('takes every value the server stores, fractions included, because MySQL rounds them', () => {
    for (const v of MY_ADMITS) expect(mySelect(v), `MySQL stores ${show(v)}`).toBe(true);
  });

  it('refuses what MySQL refuses, including the two spellings Postgres accepts', () => {
    for (const v of MY_REFUSES) expect(myInsert(v), `MySQL refuses ${show(v)}`).toBe(false);
  });

  it('takes the unsigned ceiling MySQL really stores, where drizzle-orm refuses it', () => {
    // Measured: a `bigint unsigned` stores 18446744073709551615 and hands it back, and
    // `drizzle-orm` at 1.0.0-rc.4 caps the same column at the signed int64 maximum, so its select
    // schema rejects a row the driver returns. That is an intended divergence.
    expect(myUnsigned('18446744073709551615')).toBe(true);
    expect(myUnsigned('9223372036854775808')).toBe(true);
  });
});
