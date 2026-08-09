/**
 * `bigint({ mode: 'string' })` bounded by the input syntax its server really accepts, end to end:
 * real drizzle v1 tables through the real analyzer and the real zod generator, with the emitted
 * modules imported and run.
 *
 * The defect, measured against a real Postgres through PGlite with the parity gate's own
 * MATRIX_POOL: the emitted schema was a bare `z.string()`, and on 14 of the 36 values it accepted
 * an insert Postgres refuses, with `drizzle-orm/zod` agreeing with Postgres on every one of them.
 * The 14 are the whole of `PG_REFUSES` below.
 *
 * The two servers disagree in both directions, so there are two patterns and not one. Postgres
 * stores `'0x1f'` as 31 and `'1_000'` as 1000 and refuses `'12.5'`; MySQL 8.4.11 refuses both of
 * the first two and stores `'12.5'` as 13, rounded. Each list below is what that server answered.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer } from '@drzl/analyzer';
import { ZodGenerator } from '../src/index';

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

let pg: Record<string, any>;
let my: Record<string, any>;

beforeAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
  await fs.mkdir(DIR, { recursive: true });
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
    await new ZodGenerator(analysis).generate({ outDir: DIR } as never);
  }
  const pgFile = path.join(DIR, `pgt-${process.pid}.ts`);
  await fs.rename(path.join(DIR, 'pgt.zod.ts'), pgFile);
  pg = await import(pgFile);
  const myFile = path.join(DIR, `myt-${process.pid}.ts`);
  await fs.rename(path.join(DIR, 'myt.zod.ts'), myFile);
  my = await import(myFile);
}, 120_000);

afterAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
});

const ok = (schema: any, v: unknown) => schema.safeParse(v).success;
const show = (v: string) => (v.length > 20 ? `${v.length} chars` : JSON.stringify(v));

describe('the Postgres column, against what PGlite answered', () => {
  it('takes every value the server stores', () => {
    for (const v of PG_ADMITS) {
      expect(ok(pg.SelectpgtSchema.shape.b, v), `Postgres stores ${show(v)}`).toBe(true);
    }
  });

  it('refuses all 14 the server rejects, on the insert schema the gate grades', () => {
    for (const v of PG_REFUSES) {
      expect(ok(pg.InsertpgtSchema.shape.b, v), `Postgres refuses ${show(v)}`).toBe(false);
    }
  });

  it('refuses them on select too, since neither is a value the column can return', () => {
    for (const v of PG_REFUSES) expect(ok(pg.SelectpgtSchema.shape.b, v)).toBe(false);
  });

  it('takes every value the read path hands back, which is plain digits', () => {
    // The `bigint:string` codec casts to text and registers no normalize, so a row written as
    // '0x1f' comes back '31' and one written as '007' comes back '7'. Measured through
    // drizzle-orm 1.0.0-rc.4 on PGlite.
    for (const v of [
      '1',
      '-1',
      '0',
      '31',
      '7',
      '1000',
      '9223372036854775807',
      '-9223372036854775808',
    ]) {
      expect(ok(pg.SelectpgtSchema.shape.b, v)).toBe(true);
    }
  });

  it('still refuses the wire types this column never carries', () => {
    expect(ok(pg.SelectpgtSchema.shape.b, 123n)).toBe(false);
    expect(ok(pg.SelectpgtSchema.shape.b, 123)).toBe(false);
  });

  it('leaves the magnitude unstated, which is the one half of the fact this does not carry', () => {
    // Asserted rather than left implicit, so stating it later reports itself here rather than
    // going in silently. Postgres refuses both of these and this schema takes them: the exact
    // bound is a per-digit ladder whose branch count exhausts ArkType's type-level budget, so
    // carrying it would emit an arktype module that does not compile. See COLUMN_FORMATS.
    expect(ok(pg.SelectpgtSchema.shape.b, '9223372036854775808')).toBe(true);
    expect(ok(pg.SelectpgtSchema.shape.b, '-9223372036854775809')).toBe(true);
  });
});

describe('the MySQL column, against what MySQL 8.4.11 answered', () => {
  it('takes every value the server stores, fractions included, because MySQL rounds them', () => {
    for (const v of MY_ADMITS) {
      expect(ok(my.SelectmytSchema.shape.b, v), `MySQL stores ${show(v)}`).toBe(true);
    }
  });

  it('refuses what MySQL refuses, including the two spellings Postgres accepts', () => {
    for (const v of MY_REFUSES) {
      expect(ok(my.InsertmytSchema.shape.b, v), `MySQL refuses ${show(v)}`).toBe(false);
    }
  });

  it('takes the unsigned ceiling MySQL really stores, where drizzle-orm/zod refuses it', () => {
    // Measured: a `bigint unsigned` stores 18446744073709551615 and hands it back, and
    // `drizzle-orm/zod` at 1.0.0-rc.4 caps the same column at the signed int64 maximum, so its
    // select schema rejects a row the driver returns. That is an intended divergence.
    expect(ok(my.SelectmytSchema.shape.u, '18446744073709551615')).toBe(true);
    expect(ok(my.SelectmytSchema.shape.u, '9223372036854775808')).toBe(true);
  });
});
