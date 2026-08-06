/**
 * `NaN` and the two infinities on a Postgres number column, which the analysis used to say nothing
 * about.
 *
 * Postgres stores all three in `real` and `double precision` and hands them back on SELECT, so a
 * schema that refuses them refuses rows the column itself returns. That is a read-path defect and
 * no application can avoid the read path. A range cannot express it in either direction: a
 * `>=`/`<=` pair refuses `Infinity` whatever the numbers are, and `NaN` compares false against
 * both ends. So the fact is stated on the column and the generators render it as a union.
 *
 * Measured against PostgreSQL 18.3 through PGlite, on the bound-parameter path a validator guards:
 *
 *   real, double precision      NaN, Infinity and -Infinity all stored and returned unchanged
 *   numeric, no typmod          the same three, faithfully
 *   numeric(10,2)               NaN faithful; either infinity refused, 22003 numeric field overflow
 *   integer, bigint             all three refused
 *
 * The `numeric` split is why this file asserts `allowsInfinity: false` on the number mode rather
 * than leaving it open: the analyzer does not read precision or scale at all, so it cannot tell an
 * unconstrained `numeric` from a `numeric(10,2)`. Admitting the infinities would make the schema
 * promise what the server refuses for the commoner declaration, which is the worse of the two
 * errors.
 *
 * SQLite and MySQL are deliberately untouched here and are asserted to be untouched. SQLite stores
 * both infinities faithfully and silently turns `NaN` into NULL, which is a different fact needing
 * a different fix; MySQL refuses every one of the three on a `float`/`double` and silently stores
 * `0.00` in a `decimal`.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer, describeV1Column } from '../src/index';

const dir = path.resolve(__dirname, 'fixtures');

/** A column as drizzle v1 presents one, which is what the codec path reads. */
const v1col = (dataType: string, codec?: string) => ({ dataType, codec, dimensions: 0 });

async function columnsOf(name: string, source: string) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.mjs`);
  await fs.writeFile(file, source, 'utf8');
  const analysis = await new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({});
  const t = analysis.tables[0];
  expect(t, `no table was analyzed; issues: ${JSON.stringify(analysis.issues)}`).toBeTruthy();
  return Object.fromEntries(t!.columns.map((c) => [c.name, c]));
}

/** The same Postgres table, written against each major. */
const PG_SOURCE = (pkg: string) => `
  import { pgTable, real, doublePrecision, numeric, integer, bigint } from '${pkg}/pg-core';
  export const t = pgTable('t', {
    r: real(),
    d: doublePrecision(),
    n: numeric({ precision: 10, scale: 2, mode: 'number' }),
    ns: numeric({ precision: 10, scale: 2 }),
    i: integer(),
    b: bigint({ mode: 'number' }),
  });
`;

describe('the codec path, which drizzle v1 takes', () => {
  it('admits all three on a postgres real and double precision', () => {
    // `float4` and `float8` are Postgres's codec spellings and no other dialect states them, which
    // is the same discriminator this arm already uses to pick the 4 byte magnitude bound.
    expect(describeV1Column(v1col('number float', 'float4'))).toMatchObject({
      dbType: 'REAL',
      allowsNaN: true,
      allowsInfinity: true,
    });
    expect(describeV1Column(v1col('number double', 'float8'))).toMatchObject({
      dbType: 'DOUBLE',
      allowsNaN: true,
      allowsInfinity: true,
    });
  });

  it('admits NaN alone on a postgres numeric in number mode', () => {
    expect(describeV1Column(v1col('number', 'numeric:number'))).toMatchObject({
      dbType: 'NUMERIC',
      allowsNaN: true,
      allowsInfinity: false,
    });
  });

  it('says nothing about a mysql float, double or decimal', () => {
    // MySQL refuses NaN and both infinities on a `float`/`double`, and silently stores 0.00 in a
    // `decimal`, so none of the three is a value the column hands back.
    for (const c of [
      v1col('number float', 'float'),
      v1col('number double', 'double'),
      v1col('number double', 'real'),
      v1col('number', 'decimal:number'),
    ]) {
      const out = describeV1Column(c)!;
      expect(out.allowsNaN, JSON.stringify(c)).toBeUndefined();
      expect(out.allowsInfinity, JSON.stringify(c)).toBeUndefined();
    }
  });

  it('says nothing about sqlite, singlestore, cockroach or mssql, which state no codec', () => {
    // Every one of these reaches the float/double arm with no codec at all on 1.0.0-rc.4. SQLite is
    // the one that really does store an infinity, and it turns NaN into NULL, so it needs its own
    // answer rather than Postgres's.
    for (const c of [v1col('number float'), v1col('number double')]) {
      const out = describeV1Column(c)!;
      expect(out.allowsNaN, JSON.stringify(c)).toBeUndefined();
      expect(out.allowsInfinity, JSON.stringify(c)).toBeUndefined();
    }
    // A bare `number` with no codec is what a 0.4x column looks like, so this path declines it
    // outright and the class-name table answers instead. SQLite's `numeric({ mode: 'number' })` is
    // exactly that on v1, which is why the SQLite half of this is asserted through the real
    // analyzer below rather than only here.
    expect(describeV1Column(v1col('number'))).toBeNull();
  });

  it('leaves every integer width alone, on postgres too', () => {
    // Postgres refuses all three for `integer` and `bigint`, so an integer column changes in no way.
    for (const c of [
      v1col('number int32', 'int'),
      v1col('number int53', 'bigint:number'),
      v1col('bigint int64', 'bigint'),
    ]) {
      const out = describeV1Column(c)!;
      expect(out.allowsNaN, JSON.stringify(c)).toBeUndefined();
      expect(out.allowsInfinity, JSON.stringify(c)).toBeUndefined();
    }
  });

  it('leaves the string mode of numeric alone, which already states the fact as a pattern', () => {
    // `COLUMN_FORMATS.numeric` accepts `NaN` and `Infinity` as text and agrees with Postgres on 43
    // probes. That column is a string and carries no number flags.
    const out = describeV1Column(v1col('string numeric', 'numeric'))!;
    expect(out.tsType).toBe('string');
    expect(out.allowsNaN).toBeUndefined();
    expect(out.allowsInfinity).toBeUndefined();
  });
});

describe('the class-name path, which drizzle 0.4x takes', () => {
  it('admits all three on a real and a double precision, NaN alone on a numeric', async () => {
    const cols = await columnsOf('pg-non-finite-0.4x', PG_SOURCE('drizzle-orm'));
    expect(cols.r).toMatchObject({ dbType: 'REAL', allowsNaN: true, allowsInfinity: true });
    expect(cols.d).toMatchObject({ dbType: 'DOUBLE', allowsNaN: true, allowsInfinity: true });
    expect(cols.n).toMatchObject({ allowsNaN: true, allowsInfinity: false });
  });

  it('leaves the integers and the string mode of numeric alone', async () => {
    const cols = await columnsOf('pg-non-finite-ints-0.4x', PG_SOURCE('drizzle-orm'));
    for (const name of ['i', 'b', 'ns']) {
      expect(cols[name].allowsNaN, name).toBeUndefined();
      expect(cols[name].allowsInfinity, name).toBeUndefined();
    }
  });

  it('leaves mysql and sqlite alone', async () => {
    const my = await columnsOf(
      'mysql-non-finite-0.4x',
      `
      import { mysqlTable, float, double, real, decimal } from 'drizzle-orm/mysql-core';
      export const t = mysqlTable('t', {
        f: float(), d: double(), r: real(),
        n: decimal({ precision: 10, scale: 2, mode: 'number' }),
      });
      `
    );
    for (const name of ['f', 'd', 'r', 'n']) {
      expect(my[name].allowsNaN, name).toBeUndefined();
      expect(my[name].allowsInfinity, name).toBeUndefined();
    }
    const sq = await columnsOf(
      'sqlite-non-finite-0.4x',
      `
      import { sqliteTable, real, numeric } from 'drizzle-orm/sqlite-core';
      export const t = sqliteTable('t', { r: real(), n: numeric({ mode: 'number' }) });
      `
    );
    // SQLite really does return both infinities and really does turn NaN into NULL. Both are filed
    // separately; nothing here may state either of them, because a half-right answer on this column
    // is what the round-trip gate would then pin as correct.
    for (const name of ['r', 'n']) {
      expect(sq[name].allowsNaN, name).toBeUndefined();
      expect(sq[name].allowsInfinity, name).toBeUndefined();
    }
  });
});

describe('the two majors', () => {
  it('give the same answer for the same postgres table', async () => {
    // The classic failure in this file is a fact stated on one path and not the other, which shows
    // up as a schema that changes when the user upgrades drizzle. The cross-major diff in
    // verify-packed.sh catches it there; this catches it here.
    const old = await columnsOf('pg-non-finite-cross-0.4x', PG_SOURCE('drizzle-orm'));
    const next = await columnsOf('pg-non-finite-cross-v1', PG_SOURCE('drizzle-orm-v1'));
    const flags = (cols: Record<string, { allowsNaN?: boolean; allowsInfinity?: boolean }>) =>
      Object.fromEntries(
        Object.entries(cols).map(([k, c]) => [k, [c.allowsNaN, c.allowsInfinity]])
      );
    // A verification that can succeed by matching nothing is not one: both sides have to have
    // reached the columns before agreeing about them means anything.
    expect(Object.keys(next), 'the v1 fixture analysed').toEqual(Object.keys(old));
    expect(flags(next).r, 'v1 reached the real column').toEqual([true, true]);
    expect(flags(next)).toEqual(flags(old));
  });
});
