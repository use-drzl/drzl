/**
 * `{ unsigned: true }` across the MySQL and SingleStore integer family, on both drizzle majors.
 *
 * The columns are built by the real builders rather than hand-modelled, because the defect this
 * spec pins was invisible to every fixture that spelled its own column: no fixture in the repo
 * carried an unsigned column at all, so the signed ranges looked universally correct.
 *
 * What each major actually states for an unsigned column, measured off real column objects:
 *
 *   0.45.2   the class name does not move (`MySqlInt` either way) and the flag lives only in
 *            `config.unsigned`, plus `getSQLType()` growing an ` unsigned` suffix.
 *   rc.4     the `dataType` semantic half moves: `int32` becomes `uint32`, `int64` becomes
 *            `uint64`, and `bigint({ mode: 'string', unsigned: true })` states `string uint64`.
 *            `serial` states `number uint53` with no `config.unsigned` at all, on both dialects.
 *
 * Before the fix, the class-name path answered every unsigned width with its signed range, so a
 * select schema refused every stored value in the upper half of the column: an `int unsigned`
 * holding 4294967295 failed validation on a row the database returned. On v1, `uint16`, `uint24`
 * and `uint32` had no arm and fell to the bare-number arm, which treats a MySQL number with no
 * declared precision as the implicit decimal(10,0): NUMERIC, `integer: false`, and a bound of
 * +/-9999999999 that takes -1, 1.5 and 4294967296 alike. `uint64` had no arm either and fell all
 * the way back to the class table's signed int64 range, which rejects 18446744073709551615n.
 *
 * The ranges below are the type's, from the MySQL manual and verified against a live MySQL 8.4.11
 * (see the transcript in the fix's changeset review): tinyint unsigned stores 255 and refuses -1
 * and 256, int unsigned stores 4294967295, bigint unsigned stores 18446744073709551615.
 * SingleStore is MySQL wire compatible and its builders state the same widths.
 *
 * The two bigint modes stay apart on purpose, exactly as the signed ranges already do: in
 * `{ mode: 'number' }` the value arrives through `Number`, so the truthful ceiling is the JS
 * safe-integer bound rather than the column's 2^64-1, which no double can hold. In
 * `{ mode: 'bigint' }` the value is a bigint and the column's own edge is representable.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SchemaAnalyzer, type Column } from '../src/index';

const dir = path.resolve(__dirname, 'fixtures');

async function columnsOf(name: string, source: string): Promise<Map<string, Column>> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.mjs`);
  await fs.writeFile(file, source, 'utf8');
  const analysis = await new SchemaAnalyzer(file).analyze({});
  const table = analysis.tables[0];
  expect(table, `no table analyzed: ${JSON.stringify(analysis.issues)}`).toBeTruthy();
  return new Map(table.columns.map((c) => [c.name, c]));
}

/** The integer family, unsigned and signed side by side, in one dialect's spelling. */
const INT_FAMILY = (core: string, tableFn: string) => `
  import { ${tableFn}, tinyint, smallint, mediumint, int, bigint, serial } from '${core}';
  export const t = ${tableFn}('t', {
    ti_u: tinyint('ti_u', { unsigned: true }),
    si_u: smallint('si_u', { unsigned: true }),
    mi_u: mediumint('mi_u', { unsigned: true }),
    i_u: int('i_u', { unsigned: true }),
    b53_u: bigint('b53_u', { mode: 'number', unsigned: true }),
    b64_u: bigint('b64_u', { mode: 'bigint', unsigned: true }),
    ser: serial('ser'),
    ti_s: tinyint('ti_s'),
    mi_s: mediumint('mi_s'),
    i_s: int('i_s'),
    b64_s: bigint('b64_s', { mode: 'bigint' }),
  });
`;

const UNSIGNED: Record<string, [string, string]> = {
  ti_u: ['0', '255'],
  si_u: ['0', '65535'],
  mi_u: ['0', '16777215'],
  i_u: ['0', '4294967295'],
  b53_u: ['0', '9007199254740991'],
  b64_u: ['0', '18446744073709551615'],
};

function expectUnsignedFamily(cols: Map<string, Column>) {
  for (const [name, [min, max]] of Object.entries(UNSIGNED)) {
    expect(cols.get(name), name).toMatchObject({ integer: true, min, max });
  }
  expect(cols.get('b64_u')).toMatchObject({ tsType: 'bigint' });
  // `serial` is `bigint unsigned auto_increment`: no `config.unsigned` states it, the builder
  // itself does. Safe-integer ceiling, because the mode is number.
  expect(cols.get('ser')).toMatchObject({
    integer: true,
    min: '0',
    max: '9007199254740991',
    dbType: 'BIGINT',
  });
  // The signed siblings hold their signed ranges, so the flag narrows only the column it is on.
  expect(cols.get('ti_s')).toMatchObject({ min: '-128', max: '127' });
  expect(cols.get('mi_s')).toMatchObject({ min: '-8388608', max: '8388607' });
  expect(cols.get('i_s')).toMatchObject({ min: '-2147483648', max: '2147483647' });
  expect(cols.get('b64_s')).toMatchObject({
    min: '-9223372036854775808',
    max: '9223372036854775807',
  });
}

describe('MySQL unsigned integers on drizzle-orm 0.45.2, where only config.unsigned says so', () => {
  it('bounds every width at the unsigned range the type holds', async () => {
    expectUnsignedFamily(
      await columnsOf('unsigned-mysql-045', INT_FAMILY('drizzle-orm/mysql-core', 'mysqlTable'))
    );
  });
});

describe('MySQL unsigned integers on drizzle v1, which states uintN outright', () => {
  it('bounds every width at the unsigned range the type holds', async () => {
    expectUnsignedFamily(
      await columnsOf('unsigned-mysql-v1', INT_FAMILY('drizzle-orm-v1/mysql-core', 'mysqlTable'))
    );
  });

  it('keeps the string mode a string when it is unsigned, as it already is signed', async () => {
    // `bigint({ mode: 'string', unsigned: true })` states `string uint64`, measured on rc.4. The
    // string-mode arm keyed on `int64` alone, so the unsigned spelling fell through to the
    // integer arm and came back a number, which the driver never returns in this mode.
    const cols = await columnsOf(
      'unsigned-mysql-v1-str',
      `
        import { mysqlTable, bigint } from 'drizzle-orm-v1/mysql-core';
        export const t = mysqlTable('t', {
          bs_u: bigint('bs_u', { mode: 'string', unsigned: true }),
        });
      `
    );
    expect(cols.get('bs_u')).toMatchObject({ tsType: 'string', dbType: 'BIGINT' });
    expect(cols.get('bs_u')?.min).toBeUndefined();
    expect(cols.get('bs_u')?.max).toBeUndefined();
  });
});

describe('SingleStore, whose builders state the same widths on both majors', () => {
  it('bounds the unsigned family on 0.45.2', async () => {
    expectUnsignedFamily(
      await columnsOf(
        'unsigned-ss-045',
        INT_FAMILY('drizzle-orm/singlestore-core', 'singlestoreTable')
      )
    );
  });

  it('bounds the unsigned family on v1', async () => {
    expectUnsignedFamily(
      await columnsOf(
        'unsigned-ss-v1',
        INT_FAMILY('drizzle-orm-v1/singlestore-core', 'singlestoreTable')
      )
    );
  });

  it('gives the signed tinyint and mediumint the ranges v1 already states for them', async () => {
    // These two classes were in no range table at all on 0.4x: v1 states `number int8` and
    // `number int24` for the same columns, so the majors disagreed about every such column. The
    // widths are the type's, the same ones `MySqlTinyInt` and `MySqlMediumInt` already carry.
    const cols = await columnsOf(
      'unsigned-ss-signed-045',
      `
        import { singlestoreTable, tinyint, mediumint } from 'drizzle-orm/singlestore-core';
        export const t = singlestoreTable('t', {
          ti_s: tinyint('ti_s'),
          mi_s: mediumint('mi_s'),
        });
      `
    );
    expect(cols.get('ti_s')).toMatchObject({ integer: true, min: '-128', max: '127' });
    expect(cols.get('mi_s')).toMatchObject({ integer: true, min: '-8388608', max: '8388607' });
  });
});

describe('dialects with no unsigned keep their signed ranges', () => {
  // Postgres and SQLite accept no `{ unsigned: true }` and state no `uintN`: nothing here may
  // move. The serial is the column most at risk, since MySQL's serial fix keys on the class name.
  const PG = (core: string) => `
    import { pgTable, integer, smallint, bigint, serial } from '${core}';
    export const t = pgTable('t', {
      i: integer('i'),
      si: smallint('si'),
      b64: bigint('b64', { mode: 'bigint' }),
      ser: serial('ser'),
    });
  `;

  for (const [label, core] of [
    ['0.45.2', 'drizzle-orm/pg-core'],
    ['v1', 'drizzle-orm-v1/pg-core'],
  ] as const) {
    it(`leaves Postgres alone on ${label}`, async () => {
      const cols = await columnsOf(`unsigned-pg-leak-${label.replace(/\./g, '')}`, PG(core));
      expect(cols.get('i')).toMatchObject({ min: '-2147483648', max: '2147483647' });
      expect(cols.get('si')).toMatchObject({ min: '-32768', max: '32767' });
      expect(cols.get('b64')).toMatchObject({
        min: '-9223372036854775808',
        max: '9223372036854775807',
      });
      // A Postgres serial is a plain integer defaulting from a sequence, and negative values
      // insert fine; only MySQL's serial is unsigned by definition.
      expect(cols.get('ser')).toMatchObject({ min: '-2147483648', max: '2147483647' });
    });
  }

  it('leaves SQLite alone on v1', async () => {
    const cols = await columnsOf(
      'unsigned-sqlite-leak-v1',
      `
        import { sqliteTable, integer } from 'drizzle-orm-v1/sqlite-core';
        export const t = sqliteTable('t', { i: integer('i') });
      `
    );
    expect(cols.get('i')).toMatchObject({ min: '-9007199254740991', max: '9007199254740991' });
  });
});
