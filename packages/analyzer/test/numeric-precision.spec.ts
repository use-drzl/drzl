/**
 * A `numeric(p, s)` column bounded by what the database enforces rather than by what a JS number
 * can carry, on both drizzle majors, and the two other modes of the same builder.
 *
 * The declaration always carried the numbers. `numeric(10,2)` holds eight integer digits, and the
 * analysis read neither `precision` nor `scale`, so the emitted schema bounded the column at
 * +/-9007199254740991: 2^53 where the column stops at 10^8, which is a factor of ninety million.
 * Both majors state both numbers on the column object, measured below.
 *
 * ## What the databases actually accept
 *
 * PostgreSQL 18.3 through PGlite and MySQL 8.4.11 in Docker, both on the bound-parameter path a
 * validator guards, and the two agree value for value:
 *
 *   column          value                                pg              mysql
 *   numeric(10,2)   1234.56                              accepts         accepts
 *   numeric(10,2)   99999999.99                          accepts         accepts
 *   numeric(10,2)   99999999.994                         accepts, 99999999.99 stored (both)
 *   numeric(10,2)   99999999.995                         refuses         refuses
 *   numeric(10,2)   100000000                            refuses         refuses
 *   numeric(10,2)   2147483648                           refuses         refuses
 *   numeric(10,2)   9007199254740991                     refuses         refuses
 *   numeric(20,0)   99999999999999999999                 accepts         accepts
 *   numeric(20,0)   100000000000000000000                refuses         refuses
 *   numeric(5,3)    99.999 / 100                         accepts/refuses accepts/refuses
 *   numeric(10)     9999999999 / 10000000000             accepts/refuses
 *   numeric(2,5)    0.00001 / 0.001                      accepts/refuses
 *   numeric         9007199254740991, 1e40               accepts both
 *
 * Postgres answers `22003 numeric field overflow` on every refusal and MySQL
 * `ER_WARN_DATA_OUT_OF_RANGE Out of range value for column`. So the database is the arbiter here
 * and it is stricter than `drizzle-zod`, which reads neither number: DRZL being out of step with
 * both drizzle majors' own validators is the correct outcome rather than a divergence to fix.
 *
 * The bound is therefore the largest value the column can hold, `(10^p - 1)` shifted right by `s`
 * decimal places, which is the value written out in full by every case below. One measured
 * divergence remains and is deliberate: Postgres and MySQL both round to the scale *before* they
 * check the integer digits, so both accept 99999999.994 into a `numeric(10,2)` and store
 * 99999999.99, and the emitted schema refuses it. The accepted set is open at the top, so no
 * inclusive bound expresses it; the one chosen is exactly the set of values the column can hold and
 * hand back, and the band it turns away is the band the server would have rounded away.
 *
 * ## The two other modes
 *
 * `mode: 'bigint'` is declared `numeric(20,0)`, which holds every integer up to twenty nines.
 * Measured above: the column takes 18446744073709551615, well past a signed 64 bit integer. Drizzle
 * v1 stamps `dataType: 'bigint int64'` on it, so it reached the analyzer's int64 arm and was bounded
 * at +/-9223372036854775807 and labelled a BIGINT column, and the schema then refused values the
 * column stores and returns.
 *
 * `mode: 'string'` is untouched. Its value is a string carrying arbitrary precision and its check is
 * a pattern; see `COLUMN_FORMATS.numeric` in `@drzl/validation-core`.
 *
 * ## Infinity
 *
 * Postgres takes `NaN` into a `numeric` of any width, and takes either infinity only into one
 * carrying no precision: measured, an unconstrained `numeric` stores and returns `Infinity` and
 * `-Infinity` while a `numeric(10,2)` answers `22003 numeric field overflow` for both. The number
 * mode used to state `allowsInfinity: false` for every declaration, and the recorded reason was
 * that nothing read precision, so the two were indistinguishable. They are distinguishable now and
 * each says what its own server does.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer } from '../src/index';

const dir = path.resolve(__dirname, 'fixtures');

async function columnsOf(name: string, source: string) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.mjs`);
  await fs.writeFile(file, source, 'utf8');
  const analysis = await new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({});
  const t = analysis.tables[0];
  expect(t, `no table was analyzed; issues: ${JSON.stringify(analysis.issues)}`).toBeTruthy();
  return Object.fromEntries(t!.columns.map((c) => [c.name, c]));
}

/** The same table written against each major, so one source cannot describe only one of them. */
const MAJORS: [string, string][] = [
  ['0.4x', 'drizzle-orm'],
  ['v1', 'drizzle-orm-v1'],
];

/** `numeric(10,2)` holds eight integer digits and two fractional ones, and stops here. */
const N_10_2 = '99999999.99';
/** `numeric(20,0)`, which is how `mode: 'bigint'` is declared. Twenty nines. */
const N_20_0 = '99999999999999999999';
/** What a JS number holds every integer of, and the bound where no precision is declared. */
const SAFE = '9007199254740991';

const PG = (pkg: string) => `
  import { pgTable, numeric } from '${pkg}/pg-core';
  export const t = pgTable('t', {
    n_num: numeric('n_num', { precision: 10, scale: 2, mode: 'number' }),
    n_num_free: numeric('n_num_free', { mode: 'number' }),
    n_num_p: numeric('n_num_p', { precision: 10, mode: 'number' }),
    n_num_s: numeric('n_num_s', { scale: 2, mode: 'number' }),
    n_num_wide: numeric('n_num_wide', { precision: 2, scale: 5, mode: 'number' }),
    n_big: numeric('n_big', { precision: 20, scale: 0, mode: 'bigint' }),
    n_big_free: numeric('n_big_free', { mode: 'bigint' }),
    n_str: numeric('n_str', { precision: 10, scale: 2 }),
  });
`;

const MYSQL = (pkg: string) => `
  import { mysqlTable, decimal } from '${pkg}/mysql-core';
  export const t = mysqlTable('t', {
    d_num: decimal('d_num', { precision: 10, scale: 2, mode: 'number' }),
    d_num_free: decimal('d_num_free', { mode: 'number' }),
    d_big: decimal('d_big', { precision: 20, scale: 0, mode: 'bigint' }),
  });
`;

const SINGLESTORE = (pkg: string) => `
  import { singlestoreTable, decimal } from '${pkg}/singlestore-core';
  export const t = singlestoreTable('t', {
    d_num: decimal('d_num', { precision: 10, scale: 2, mode: 'number' }),
    d_big: decimal('d_big', { precision: 20, scale: 0, mode: 'bigint' }),
  });
`;

const SQLITE = (pkg: string) => `
  import { sqliteTable, numeric } from '${pkg}/sqlite-core';
  export const t = sqliteTable('t', {
    s_num: numeric('s_num', { mode: 'number' }),
    s_big: numeric('s_big', { mode: 'bigint' }),
  });
`;

describe.each(MAJORS)('postgres numeric on drizzle %s', (major, pkg) => {
  it('bounds the number mode by the precision the column declares', async () => {
    // Addendum AK. `numeric(10,2)` admitted 2^53 where the column stops at 10^8.
    const c = await columnsOf(`numeric-precision-pg-${major}`, PG(pkg));
    expect(c.n_num).toMatchObject({
      tsType: 'number',
      dbType: 'NUMERIC',
      integer: false,
      min: `-${N_10_2}`,
      max: N_10_2,
    });
  });

  it('keeps the safe-integer bound where the declaration states no precision', async () => {
    const c = await columnsOf(`numeric-precision-pg-${major}`, PG(pkg));
    expect(c.n_num_free).toMatchObject({ integer: false, min: `-${SAFE}`, max: SAFE });
    // `scale` alone renders a bare `numeric`: drizzle emits no typmod at all without a precision,
    // so there is no constraint on the column to read. Measured on both majors through
    // `getSQLType()`.
    expect(c.n_num_s).toMatchObject({ min: `-${SAFE}`, max: SAFE });
  });

  it('reads a precision with no scale as the scale-zero column Postgres makes of it', async () => {
    // `numeric(10)` is `numeric(10,0)` to the server, measured through `format_type`: it accepts
    // 9999999999 and refuses 10000000000, and stores 0.1 as 0.
    const c = await columnsOf(`numeric-precision-pg-${major}`, PG(pkg));
    expect(c.n_num_p).toMatchObject({ min: '-9999999999', max: '9999999999' });
  });

  it('handles a scale wider than the precision, which Postgres allows', async () => {
    // `numeric(2,5)` holds two significant digits five places to the right of the point. Measured:
    // 0.00001 accepted, 0.001 refused.
    const c = await columnsOf(`numeric-precision-pg-${major}`, PG(pkg));
    expect(c.n_num_wide).toMatchObject({ min: '-0.00099', max: '0.00099' });
  });

  it('bounds the bigint mode by the same precision, and calls it a NUMERIC column', async () => {
    // Addendum AL. v1 stamps `bigint int64` on this column, so it took the int64 arm: bounded at
    // +/-9223372036854775807 and labelled BIGINT, on a column measured to accept
    // 18446744073709551615 and 99999999999999999999.
    const c = await columnsOf(`numeric-precision-pg-${major}`, PG(pkg));
    expect(c.n_big).toMatchObject({
      tsType: 'bigint',
      dbType: 'NUMERIC',
      integer: true,
      min: `-${N_20_0}`,
      max: N_20_0,
    });
  });

  it('states no bound on a bigint mode that declares no precision', async () => {
    const c = await columnsOf(`numeric-precision-pg-${major}`, PG(pkg));
    expect(c.n_big_free).toMatchObject({ tsType: 'bigint', dbType: 'NUMERIC', integer: true });
    expect(c.n_big_free.min).toBeUndefined();
    expect(c.n_big_free.max).toBeUndefined();
  });

  it('admits the infinities only where the column carries no precision', async () => {
    // Measured through PGlite: an unconstrained `numeric` stores and returns both infinities, and
    // a `numeric(10,2)` answers 22003 for either. `NaN` goes into both.
    const c = await columnsOf(`numeric-precision-pg-${major}`, PG(pkg));
    expect(c.n_num).toMatchObject({ allowsNaN: true, allowsInfinity: false });
    expect(c.n_num_free).toMatchObject({ allowsNaN: true, allowsInfinity: true });
    expect(c.n_num_p).toMatchObject({ allowsNaN: true, allowsInfinity: false });
    expect(c.n_num_s).toMatchObject({ allowsNaN: true, allowsInfinity: true });
  });

  it('leaves the string mode alone', async () => {
    // Its value carries arbitrary precision as text and its check is a pattern, so a numeric range
    // does not apply to it in either direction.
    const c = await columnsOf(`numeric-precision-pg-${major}`, PG(pkg));
    expect(c.n_str).toMatchObject({ tsType: 'string', dbType: 'NUMERIC' });
    expect(c.n_str.min).toBeUndefined();
    expect(c.n_str.max).toBeUndefined();
    expect(c.n_str.allowsNaN).toBeUndefined();
  });
});

describe.each(MAJORS)('mysql decimal on drizzle %s', (major, pkg) => {
  it('bounds the number mode by the precision, on the path that had no bound at all', async () => {
    const c = await columnsOf(`numeric-precision-mysql-${major}`, MYSQL(pkg));
    expect(c.d_num).toMatchObject({
      tsType: 'number',
      dbType: 'NUMERIC',
      integer: false,
      min: `-${N_10_2}`,
      max: N_10_2,
    });
  });

  it('bounds the bigint mode by the precision, and calls it a NUMERIC column', async () => {
    // The priority case of addendum AL. `decimal(20,0)` accepts twenty nines, measured on MySQL
    // 8.4.11, and v1 bounded the column at the signed 64 bit range through its `bigint int64`
    // dataType while calling it a BIGINT.
    const c = await columnsOf(`numeric-precision-mysql-${major}`, MYSQL(pkg));
    expect(c.d_big).toMatchObject({
      tsType: 'bigint',
      dbType: 'NUMERIC',
      integer: true,
      min: `-${N_20_0}`,
      max: N_20_0,
    });
  });

  it('states no non-finite value on any of them', async () => {
    // MySQL refuses all three outright: `Incorrect decimal value: 'NaN'`, measured on the same
    // server. Only Postgres stores them.
    const c = await columnsOf(`numeric-precision-mysql-${major}`, MYSQL(pkg));
    for (const n of ['d_num', 'd_num_free', 'd_big']) {
      expect(c[n].allowsNaN, n).toBeUndefined();
      expect(c[n].allowsInfinity, n).toBeUndefined();
    }
  });

  it('reads a bare decimal as the decimal(10,0) MySQL really makes of it', async () => {
    // Not the safe-integer fallback Postgres takes, because MySQL's `decimal` is not an
    // unconstrained column. Measured on MySQL 8.4.11: `create table dd (v decimal)` reports
    // `decimal(10,0)` in information_schema, and the column accepts 9999999999 while refusing
    // 10000000000 and 9007199254740991.
    const c = await columnsOf(`numeric-precision-mysql-${major}`, MYSQL(pkg));
    expect(c.d_num_free).toMatchObject({ integer: false, min: '-9999999999', max: '9999999999' });
  });
});

describe.each(MAJORS)('singlestore decimal on drizzle %s', (major, pkg) => {
  it('answers exactly as MySQL does, which is the dialect it is wire compatible with', async () => {
    const c = await columnsOf(`numeric-precision-singlestore-${major}`, SINGLESTORE(pkg));
    expect(c.d_num).toMatchObject({
      tsType: 'number',
      integer: false,
      min: `-${N_10_2}`,
      max: N_10_2,
    });
    expect(c.d_big).toMatchObject({
      tsType: 'bigint',
      dbType: 'NUMERIC',
      integer: true,
      min: `-${N_20_0}`,
      max: N_20_0,
    });
  });
});

describe.each(MAJORS)('sqlite numeric on drizzle %s', (major, pkg) => {
  it('types both modes and states that neither holds whole numbers by accident', async () => {
    // Addendum AL filed the number mode as "still typed unknown", which it is not: it answers
    // `number` on both majors. What it did not state was `integer`, and `isIntegerColumn` falls
    // back to "declares both bounds" only in that case, so this is the fact rather than a fix.
    const c = await columnsOf(`numeric-precision-sqlite-${major}`, SQLITE(pkg));
    expect(c.s_num).toMatchObject({ tsType: 'number', dbType: 'NUMERIC', integer: false });
    expect(c.s_big).toMatchObject({ tsType: 'bigint', dbType: 'NUMERIC', integer: true });
  });

  it('bounds neither, not even by what a JS number carries', async () => {
    // `numeric()` on SQLite takes no precision or scale argument at all, on either major, and
    // NUMERIC there is an affinity rather than a type. Measured through `node:sqlite`: a `numeric`
    // column stores 1e300 and 1e32 as REALs and hands each back unchanged, so even the
    // safe-integer bound the other dialects fall back to would refuse rows this column returns.
    const c = await columnsOf(`numeric-precision-sqlite-${major}`, SQLITE(pkg));
    for (const n of ['s_num', 's_big']) {
      expect(c[n].min, n).toBeUndefined();
      expect(c[n].max, n).toBeUndefined();
    }
  });
});

describe('gel float columns', () => {
  /**
   * Gel exists on drizzle 0.4x alone; v1 removed `gel-core` and importing it there throws
   * ERR_PACKAGE_PATH_NOT_EXPORTED.
   *
   * Measured on a live Gel 7.1 (`geldata/gel:7`) through the `gel` client, casting a literal so the
   * server parses it, and again through a stored property on a real object type:
   *
   *   std::float32   NaN, Infinity and -Infinity all stored and returned unchanged
   *   std::float32   3.4028235677973366e38 accepted, stored as 3.4028234663852886e38
   *   std::float32   3.402823567797337e38 refused, "is out of range for type std::float32"
   *   std::float32   1e300 refused, the same way
   *   std::float64   all three non-finite values, 1e300 and Number.MAX_VALUE, all faithful
   *
   * The float32 edge is Postgres's exactly, to the double: the same value accepted, the same next
   * double up refused, and the same rounding down of the midpoint. So `real` takes the constant
   * this file already carries for a Postgres `real` rather than a second measurement of the same
   * number, and `doublePrecision` takes no finite bound at all, for the reason every 8 byte float
   * takes none.
   */
  const PG_FLOAT4_INPUT_MAX = '340282356779733661637539395458142568448';

  const GEL = `
    import { gelTable, real, doublePrecision, decimal } from 'drizzle-orm/gel-core';
    export const t = gelTable('t', {
      g_real: real('g_real'),
      g_double: doublePrecision('g_double'),
      g_dec: decimal('g_dec'),
    });
  `;

  it('bounds real at the magnitude the server refuses past, and names it a REAL', async () => {
    const c = await columnsOf('numeric-precision-gel', GEL);
    expect(c.g_real).toMatchObject({
      tsType: 'number',
      dbType: 'REAL',
      integer: false,
      min: `-${PG_FLOAT4_INPUT_MAX}`,
      max: PG_FLOAT4_INPUT_MAX,
    });
  });

  it('leaves doublePrecision unbounded, and names it a DOUBLE', async () => {
    const c = await columnsOf('numeric-precision-gel', GEL);
    expect(c.g_double).toMatchObject({ tsType: 'number', dbType: 'DOUBLE', integer: false });
    expect(c.g_double.min).toBeUndefined();
    expect(c.g_double.max).toBeUndefined();
  });

  it('admits the three non-finite doubles both columns store and return', async () => {
    // Without these the emitted schema refuses every row carrying one, which is a read-path defect
    // on a column behaving as the server documents.
    const c = await columnsOf('numeric-precision-gel', GEL);
    expect(c.g_real).toMatchObject({ allowsNaN: true, allowsInfinity: true });
    expect(c.g_double).toMatchObject({ allowsNaN: true, allowsInfinity: true });
  });

  it('leaves the decimal column, whose value is a string, alone', async () => {
    const c = await columnsOf('numeric-precision-gel', GEL);
    expect(c.g_dec).toMatchObject({ tsType: 'string', dbType: 'NUMERIC' });
    expect(c.g_dec.min).toBeUndefined();
    expect(c.g_dec.allowsNaN).toBeUndefined();
  });
});

describe('the arm that reads a declared precision reads nothing else', () => {
  it('is reached only by numeric and decimal in number mode, across every v1 core', async () => {
    // `describeV1Column` reads `precision` off any column landing in the bare-number arm, with no
    // class-name guard, and that is only sound while nothing else lands there: a `precision` on
    // some other column would mean something else entirely. This is the sweep the comment on that
    // read cites, run rather than written down.
    //
    // Every column builder each core exports, in five argument shapes, keeping the ones whose
    // `dataType` is `number` with no semantic half.
    // Literal specifiers rather than a template over a list of names, which the bundler cannot
    // resolve and warns about on every run.
    const CORES = [
      import('drizzle-orm-v1/pg-core'),
      import('drizzle-orm-v1/mysql-core'),
      import('drizzle-orm-v1/sqlite-core'),
      import('drizzle-orm-v1/singlestore-core'),
      import('drizzle-orm-v1/mssql-core'),
      import('drizzle-orm-v1/cockroach-core'),
    ];
    const SHAPES = [
      undefined,
      { mode: 'number' },
      { precision: 10, scale: 2 },
      { precision: 10, scale: 2, mode: 'number' },
      { precision: 10 },
    ];
    const found = new Set<string>();
    for (const core of CORES) {
      const mod: Record<string, any> = await core;
      for (const [name, fn] of Object.entries(mod)) {
        if (typeof fn !== 'function' || /^[A-Z]/.test(name)) continue;
        for (const args of SHAPES) {
          let col: any;
          try {
            const built = args === undefined ? fn('c') : fn('c', args);
            // A core exports more than column builders. `migrate` and friends return a promise
            // that rejects on the nonsense arguments above, and an unhandled rejection fails the
            // whole file rather than this call, so they are settled and skipped rather than caught.
            if (typeof built?.then === 'function') {
              built.catch(() => {});
              continue;
            }
            col = built?.build?.({ name: 't' });
          } catch {
            continue;
          }
          if (typeof col?.dataType !== 'string') continue;
          const [js, semantic = ''] = col.dataType.split(' ');
          if (js !== 'number' || semantic) continue;
          found.add(String(col.constructor?.[Symbol.for('drizzle:entityKind')] ?? '?'));
        }
      }
    }
    // A sweep that matched nothing would assert nothing, so the set is compared whole rather than
    // filtered down to what it happens to contain.
    expect([...found].sort()).toEqual([
      'CockroachDecimalNumber',
      'MsSqlDecimalNumber',
      'MsSqlNumericNumber',
      'MySqlDecimalNumber',
      'PgNumericNumber',
      'SQLiteNumericNumber',
      'SingleStoreDecimalNumber',
    ]);
  });
});

describe('the two majors describe the same column identically', () => {
  /**
   * A fact stated on one analyzer path and not the other is a schema that changes when the user
   * upgrades drizzle, which is what the cross-major diff in `scripts/verify-packed.sh` fails on.
   * Every column above goes through both paths here rather than through whichever one its own
   * `describe.each` arm happened to exercise.
   */
  it.each([
    ['pg', PG],
    ['mysql', MYSQL],
    ['singlestore', SINGLESTORE],
    ['sqlite', SQLITE],
  ])('%s', async (dialect, source) => {
    const old = await columnsOf(`numeric-precision-cross-${dialect}-old`, source('drizzle-orm'));
    const next = await columnsOf(
      `numeric-precision-cross-${dialect}-new`,
      source('drizzle-orm-v1')
    );
    // `format` is deliberately outside this. The numeric pattern is attached by the v1 path alone
    // and that gap is filed and waived by name in `scripts/verify-packed.sh`; it is one thing
    // across the whole 0.4x path rather than anything this family introduced.
    const compared = (c: Record<string, any>) =>
      Object.fromEntries(
        Object.entries(c).map(([k, v]) => [
          k,
          {
            tsType: v.tsType,
            dbType: v.dbType,
            integer: v.integer,
            min: v.min,
            max: v.max,
            allowsNaN: v.allowsNaN,
            allowsInfinity: v.allowsInfinity,
          },
        ])
      );
    expect(compared(next)).toEqual(compared(old));
  });
});
