/**
 * `decimal`/`numeric` carries its mode in the class name on drizzle 0.4x, and each mode returns a
 * different JavaScript type.
 *
 * Everything below was measured against a running engine before it was written down. Each column
 * was created, a row inserted through the raw driver, and the row read back twice: once through the
 * driver and once through `db.select()`, which is what a DRZL select schema has to accept.
 *
 * MySQL 8.4.11 in Docker, mysql2, drizzle-orm 0.45.2, `decimal(10,2)` holding '1234.56'
 * (`decimal(20,0)` holding '9007199254740993' for the bigint mode, which is the only shape
 * `BigInt(value)` can take):
 *
 *   mode           class                  mysql2 hands back   db.select() hands back
 *   (default)      MySqlDecimal           "1234.56" string    "1234.56"          string
 *   mode:'string'  MySqlDecimal           "1234.56" string    "1234.56"          string
 *   mode:'number'  MySqlDecimalNumber     "1234.56" string    1234.56            number
 *   mode:'bigint'  MySqlDecimalBigInt     "900..93" string    9007199254740993n  bigint
 *
 * Postgres via PGlite, same drizzle, `numeric(10,2)` and `numeric(20,0)`, identical readings for
 * `PgNumeric`, `PgNumericNumber` and `PgNumericBigInt`. SQLite via better-sqlite3 3.53.4, likewise
 * for `SQLiteNumeric`, `SQLiteNumericNumber` and `SQLiteNumericBigInt`.
 *
 * So the driver returns a string in the default and string modes, a number in number mode and a
 * bigint in bigint mode, on all three engines. The class-name path used to answer `number` for the
 * whole MySQL and SingleStore family, which is right for exactly one of the three: the select
 * schema rejected every row in the other two, and the insert schema rejected the value the driver
 * wants. A fix told only "decimal is a string" would break the number mode, which is why all three
 * are pinned here rather than the one that started it.
 *
 * The v1 path is not affected and is the reference for the answers: drizzle v1 stamps
 * `string numeric`, a bare `number`, and `bigint int64` on the three modes, which
 * `describeV1Column` already reads correctly. `v1-column-types.spec.ts` covers that side.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer } from '../src/index';

const dir = path.resolve(__dirname, 'fixtures');

/** Every column of the first table, by name, from a real drizzle schema module. */
async function columnsOf(name: string, source: string) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.mjs`);
  await fs.writeFile(file, source, 'utf8');
  const analysis = await new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({});
  const t = analysis.tables[0];
  expect(t, `no table was analyzed; issues: ${JSON.stringify(analysis.issues)}`).toBeTruthy();
  return { analysis, byName: new Map(t!.columns.map((c) => [c.name, c])) };
}

const MYSQL_SOURCE = `
  import { mysqlTable, decimal } from 'drizzle-orm/mysql-core';
  export const t = mysqlTable('t', {
    d_def: decimal('d_def', { precision: 10, scale: 2 }),
    d_str: decimal('d_str', { precision: 10, scale: 2, mode: 'string' }),
    d_num: decimal('d_num', { precision: 10, scale: 2, mode: 'number' }),
    d_big: decimal('d_big', { precision: 20, scale: 0, mode: 'bigint' }),
  });
`;

const SINGLESTORE_SOURCE = `
  import { singlestoreTable, decimal } from 'drizzle-orm/singlestore-core';
  export const t = singlestoreTable('t', {
    d_def: decimal('d_def', { precision: 10, scale: 2 }),
    d_str: decimal('d_str', { precision: 10, scale: 2, mode: 'string' }),
    d_num: decimal('d_num', { precision: 10, scale: 2, mode: 'number' }),
    d_big: decimal('d_big', { precision: 20, scale: 0, mode: 'bigint' }),
  });
`;

const PG_SOURCE = `
  import { pgTable, numeric } from 'drizzle-orm/pg-core';
  export const t = pgTable('t', {
    n_def: numeric('n_def', { precision: 10, scale: 2 }),
    n_str: numeric('n_str', { precision: 10, scale: 2, mode: 'string' }),
    n_num: numeric('n_num', { precision: 10, scale: 2, mode: 'number' }),
    n_big: numeric('n_big', { precision: 20, scale: 0, mode: 'bigint' }),
  });
`;

const SQLITE_SOURCE = `
  import { sqliteTable, numeric } from 'drizzle-orm/sqlite-core';
  export const t = sqliteTable('t', {
    s_def: numeric('s_def'),
    s_num: numeric('s_num', { mode: 'number' }),
    s_big: numeric('s_big', { mode: 'bigint' }),
  });
`;

/** The JS type the driver hands back, per column, measured as described at the top of this file. */
const DRIVER_TYPES: Record<string, Record<string, string>> = {
  mysql: { d_def: 'string', d_str: 'string', d_num: 'number', d_big: 'bigint' },
  singlestore: { d_def: 'string', d_str: 'string', d_num: 'number', d_big: 'bigint' },
  pg: { n_def: 'string', n_str: 'string', n_num: 'number', n_big: 'bigint' },
  sqlite: { s_def: 'string', s_num: 'number', s_big: 'bigint' },
};

const SOURCES: Record<string, string> = {
  mysql: MYSQL_SOURCE,
  singlestore: SINGLESTORE_SOURCE,
  pg: PG_SOURCE,
  sqlite: SQLITE_SOURCE,
};

describe.each(Object.keys(SOURCES))('%s decimal/numeric modes on drizzle 0.4x', (dialect) => {
  it('types every mode as the type its driver returns', async () => {
    // The whole table at once, keyed by column, so a fix that repairs one mode and leaves
    // another wrong fails naming the column rather than passing on the one it repaired.
    const { byName } = await columnsOf(`decimal-modes-${dialect}`, SOURCES[dialect]);
    const actual = Object.fromEntries(
      Object.keys(DRIVER_TYPES[dialect]).map((n) => [n, byName.get(n)?.tsType])
    );
    expect(actual).toEqual(DRIVER_TYPES[dialect]);
  });

  it('calls every mode a NUMERIC column, whichever JS type it carries', async () => {
    // The SQL side does not change with the mode: all three are the same `decimal(10,2)` or
    // `numeric(10,2)` column. `dbType` is read by `isIntegerColumn` in @drzl/validation-core,
    // which asks only whether it is exactly 'INTEGER', so none of these may be one.
    const { byName } = await columnsOf(`decimal-modes-${dialect}`, SOURCES[dialect]);
    const actual = Object.fromEntries(
      Object.keys(DRIVER_TYPES[dialect]).map((n) => [n, byName.get(n)?.dbType])
    );
    const expected = Object.fromEntries(
      Object.keys(DRIVER_TYPES[dialect]).map((n) => [n, 'NUMERIC'])
    );
    expect(actual).toEqual(expected);
  });

  it('raises no unknown-column warning for any mode', async () => {
    // SQLite's number and bigint modes used to reach no arm at all and came back `unknown`, so
    // the emitted schema accepted anything. The warning is the only thing that said so.
    const { analysis, byName } = await columnsOf(`decimal-modes-${dialect}`, SOURCES[dialect]);
    expect([...byName.values()].filter((c) => c.tsType === 'unknown').map((c) => c.name)).toEqual(
      []
    );
    expect(analysis.issues.filter((i) => i.code === 'DRZL_ANL_UNKNOWN_COLUMN')).toEqual([]);
  });
});

describe('what the modes must not pick up on the way', () => {
  it('leaves the number mode unbounded and non-integer, as it is today', async () => {
    // Addendum AK is open on exactly this: a `numeric(10,2)` in number mode admits 2^53 where the
    // column enforces 10^8. Pinned as it stands so this fix cannot be read as having settled it,
    // and so a later change to the bound is a deliberate edit here rather than a silent one.
    //
    // Postgres is the one dialect that already carries a bound, `PgNumericNumber` in
    // INEXACT_RANGES; MySQL, SingleStore and SQLite carry none. Both states are recorded.
    const my = (await columnsOf('decimal-modes-mysql', MYSQL_SOURCE)).byName.get('d_num');
    expect(my).toMatchObject({ tsType: 'number' });
    expect(my?.min).toBeUndefined();
    expect(my?.max).toBeUndefined();
    expect(my?.integer).toBeUndefined();

    const pg = (await columnsOf('decimal-modes-pg', PG_SOURCE)).byName.get('n_num');
    expect(pg).toMatchObject({
      tsType: 'number',
      integer: false,
      min: '-9007199254740991',
      max: '9007199254740991',
    });
  });

  it('leaves the string modes without a numeric format, as the 0.4x path does everywhere', async () => {
    // `format: 'numeric'` is set by the v1 path alone. On 0.4x no column gets one, including the
    // Postgres `numeric` that has been a string here for far longer, so the emitted schema is a
    // bare string and accepts 'hello'. That gap is one thing across the whole 0.4x path rather
    // than something this family introduced, and it is reported rather than fixed here.
    const my = (await columnsOf('decimal-modes-mysql', MYSQL_SOURCE)).byName.get('d_def');
    const pg = (await columnsOf('decimal-modes-pg', PG_SOURCE)).byName.get('n_def');
    expect(my?.format).toBeUndefined();
    expect(pg?.format).toBeUndefined();
  });
});
