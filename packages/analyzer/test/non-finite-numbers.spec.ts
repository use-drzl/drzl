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

/**
 * A stand-in constructor carrying only drizzle's entity kind, for the dialects that state no codec.
 *
 * Read off real 1.0.0-rc.4 columns: `singlestoreTable({ d: double() })` stamps
 * `dataType: 'number double'` with no codec at all and `drizzle:entityKind` of `SingleStoreDouble`,
 * where the MySQL column beside it states codec `double`.
 */
const entityKind = (kind: string) => ({ [Symbol.for('drizzle:entityKind')]: kind }) as never;

async function analysisOf(name: string, source: string) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.mjs`);
  await fs.writeFile(file, source, 'utf8');
  const analysis = await new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({});
  expect(
    analysis.tables[0],
    `no table was analyzed; issues: ${JSON.stringify(analysis.issues)}`
  ).toBeTruthy();
  return analysis;
}

async function columnsOf(name: string, source: string) {
  const analysis = await analysisOf(name, source);
  return Object.fromEntries(analysis.tables[0]!.columns.map((c) => [c.name, c]));
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

  it('splits the two on a postgres numeric in number mode, by the declared precision', () => {
    // The split the header of this file records and the analyzer could not act on: an
    // unconstrained `numeric` stores and returns both infinities, and a `numeric(10,2)` answers
    // `22003 numeric field overflow` for either, while both take `NaN`. This used to be a flat
    // `allowsInfinity: false` because nothing here read precision, which is exactly the reason the
    // narrower of the two answers was chosen and is exactly the reason that is now gone:
    // `declaredDecimalRange` reads it, and the two declarations are no longer the same column.
    expect(describeV1Column(v1col('number', 'numeric:number'))).toMatchObject({
      dbType: 'NUMERIC',
      allowsNaN: true,
      allowsInfinity: true,
    });
    expect(
      describeV1Column({ ...v1col('number', 'numeric:number'), precision: 10, scale: 2 })
    ).toMatchObject({
      dbType: 'NUMERIC',
      allowsNaN: true,
      allowsInfinity: false,
      min: '-99999999.99',
      max: '99999999.99',
    });
  });

  it('states the refusal on a mysql float, double and real, and says nothing about a decimal', () => {
    // `false` rather than absent, and the difference is the whole of this: absent means nobody
    // asked, and the two libraries whose bare number takes an infinity then took one on a column
    // the server refuses it on. Measured on MySQL 8.4.11 in STRICT_TRANS_TABLES on the binary
    // prepared path, which is the one that puts the real IEEE double on the wire: all three columns
    // answer ER_WARN_DATA_OUT_OF_RANGE for Infinity, -Infinity and NaN alike.
    for (const c of [
      v1col('number float', 'float'),
      v1col('number double', 'double'),
      v1col('number double', 'real'),
    ]) {
      expect(describeV1Column(c), JSON.stringify(c)).toMatchObject({
        allowsNaN: false,
        allowsInfinity: false,
      });
    }
    // The decimal families stay out of it. On the same prepared path MySQL silently stored 0.00 for
    // all three, where the text path answers `Incorrect decimal value`, and "refuses" is only half
    // true of a column that accepted the row.
    const dec = describeV1Column(v1col('number', 'decimal:number'))!;
    expect(dec.allowsNaN).toBeUndefined();
    expect(dec.allowsInfinity).toBeUndefined();
  });

  it('states it for singlestore too, off the class name, since it declares no codec', () => {
    // SingleStore is MySQL wire-compatible and unmeasured, and takes MySQL's answer here exactly as
    // it already takes MySQL's float32 bound. It states no codec at all on 1.0.0-rc.4, so the class
    // name is the marker, which is the third marker this function already uses for mssql and
    // cockroach.
    for (const kind of ['SingleStoreFloat', 'SingleStoreDouble', 'SingleStoreReal']) {
      const c = { ...v1col('number double'), constructor: entityKind(kind) };
      expect(describeV1Column(c), kind).toMatchObject({ allowsNaN: false, allowsInfinity: false });
    }
  });

  it('says nothing about sqlite, cockroach or mssql, which state no codec either', () => {
    // Every one of these reaches the float/double arm with no codec at all on 1.0.0-rc.4. SQLite is
    // the one that really does store an infinity, and it turns NaN into NULL, so it needs its own
    // answer rather than Postgres's or MySQL's; cockroach and mssql were never asked.
    for (const c of [v1col('number float'), v1col('number double')]) {
      const out = describeV1Column(c)!;
      expect(out.allowsNaN, JSON.stringify(c)).toBeUndefined();
      expect(out.allowsInfinity, JSON.stringify(c)).toBeUndefined();
    }
    for (const kind of ['SQLiteReal', 'CockroachDoublePrecision', 'MsSqlFloat']) {
      const c = { ...v1col('number double'), constructor: entityKind(kind) };
      const out = describeV1Column(c)!;
      expect(out.allowsNaN, kind).toBeUndefined();
      expect(out.allowsInfinity, kind).toBeUndefined();
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

  it('states the mysql and singlestore refusal, and leaves their decimal alone', async () => {
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
    for (const name of ['f', 'd', 'r']) {
      expect(my[name], name).toMatchObject({ allowsNaN: false, allowsInfinity: false });
    }
    expect(my.n.allowsNaN, 'decimal').toBeUndefined();
    expect(my.n.allowsInfinity, 'decimal').toBeUndefined();

    const ss = await columnsOf(
      'singlestore-non-finite-0.4x',
      `
      import { singlestoreTable, float, double, real } from 'drizzle-orm/singlestore-core';
      export const t = singlestoreTable('t', { f: float(), d: double(), r: real() });
      `
    );
    for (const name of ['f', 'd', 'r']) {
      expect(ss[name], name).toMatchObject({ allowsNaN: false, allowsInfinity: false });
    }
  });

  it('leaves sqlite alone', async () => {
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

  it('give the same answer for the same mysql and singlestore tables', async () => {
    // The same trap on the other side of the fact. The two paths reach it differently here: 0.4x by
    // the class name, v1 by MySQL's own `float`/`double`/`real` codec, and SingleStore by its class
    // name on both majors because it declares no codec at all.
    const SOURCE = (pkg: string) => `
      import { mysqlTable, float, double, real, decimal } from '${pkg}/mysql-core';
      import { singlestoreTable, double as ssDouble } from '${pkg}/singlestore-core';
      export const t = mysqlTable('t', {
        f: float(), d: double(), r: real(),
        n: decimal({ precision: 10, scale: 2, mode: 'number' }),
      });
      export const u = singlestoreTable('u', { d: ssDouble() });
    `;
    const flags = (a: any) =>
      Object.fromEntries(
        a.tables.flatMap((t: any) =>
          t.columns.map((c: any) => [`${t.name}.${c.name}`, [c.allowsNaN, c.allowsInfinity]])
        )
      );
    const old = flags(await analysisOf('mysql-non-finite-cross-0.4x', SOURCE('drizzle-orm')));
    const next = flags(await analysisOf('mysql-non-finite-cross-v1', SOURCE('drizzle-orm-v1')));
    expect(old['t.d'], '0.4x reached the double column').toEqual([false, false]);
    expect(next['u.d'], 'v1 reached the singlestore column').toEqual([false, false]);
    expect(next).toEqual(old);
  });
});
