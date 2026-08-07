/**
 * The mssql and cockroach dialects, against real `mssqlTable` and `cockroachTable` schemas.
 *
 * `uncovered-dialects.spec.ts` said these two "cannot be reached from here at all", because the
 * workspace resolves `drizzle-orm` to 0.45.2 and neither core exists on that major. That stopped
 * being true when `drizzle-orm-v1`, an alias of 1.0.0-rc.4, became a devDependency of this
 * package: the two cores are reachable, and the analyzer facts for them belong here beside every
 * other dialect's rather than only in a generator package.
 *
 * Every fixture below is built by the real column builders, and one test per dialect asserts the
 * fixture names **every column builder the core exports**. That is the check a hand-written class
 * list cannot make, and its absence is what let the whole boolean and string family of both
 * dialects sit at `unknown` while `gel-types.spec.ts` passed green against classes typed out by
 * hand.
 *
 * GROUND TRUTH. Every bound and every width asserted here was taken from a server, not from a
 * class name:
 *
 *   SQL Server 2022 (`mcr.microsoft.com/mssql/server:2022-latest`), on a `tinyint` column:
 *     -1                 refused, Msg 220, arithmetic overflow
 *      0                 accepted
 *      255               accepted
 *      256               refused, Msg 220
 *      9007199254740991  refused, Msg 8115
 *      3.7               accepted, and the row reads back as 3
 *
 *   CockroachDB v24.3.5 (`cockroachdb/cockroach:v24.3.5`), on `bit(3)` and `varbit(8)`:
 *     bit(3)     ''        refused, "bit string length 0 does not match type BIT(3)"
 *     bit(3)     '1'       refused, length 1 does not match
 *     bit(3)     '10'      refused, length 2 does not match
 *     bit(3)     '101'     accepted, and read back as the string '101'
 *     bit(3)     '1011'    refused, length 4 does not match
 *     varbit(8)  ''        accepted
 *     varbit(8)  '1'       accepted
 *     varbit(8)  '10101010' accepted, read back as '10101010'
 *     varbit(8)  '101010101' refused, "bit string length 9 too large for type VARBIT(8)"
 *
 * `drizzle-orm/zod` at 1.0.0-rc.4 was asked the same questions and agrees with both servers on
 * all of them, which is recorded here because official agreeing is evidence and official
 * disagreeing would have been a reason to look again.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer, type Analysis, type Column } from '../src/index';

const dir = path.resolve(__dirname, 'fixtures');

/** Every column builder `mssql-core` exports, each one used at least once, modes included. */
const MSSQL_SOURCE = `
  import {
    mssqlTable, bigint, binary, bit, char, date, datetime, datetime2, datetimeoffset, decimal,
    float, int, nchar, ntext, numeric, nvarchar, real, smallint, text, time, tinyint, varbinary,
    varchar,
  } from 'drizzle-orm-v1/mssql-core';
  export const t = mssqlTable('t', {
    c_int: int('c_int'),
    c_tinyint: tinyint('c_tinyint'),
    c_smallint: smallint('c_smallint'),
    c_bigint: bigint('c_bigint', { mode: 'number' }),
    c_bigint64: bigint('c_bigint64', { mode: 'bigint' }),
    c_bit: bit('c_bit'),
    c_decimal: decimal('c_decimal', { precision: 10, scale: 2 }),
    c_decimal_num: decimal('c_decimal_num', { precision: 10, scale: 2, mode: 'number' }),
    c_decimal_big: decimal('c_decimal_big', { precision: 20, scale: 0, mode: 'bigint' }),
    c_numeric: numeric('c_numeric', { precision: 10, scale: 2 }),
    c_numeric_num: numeric('c_numeric_num', { precision: 10, scale: 2, mode: 'number' }),
    c_numeric_big: numeric('c_numeric_big', { precision: 20, scale: 0, mode: 'bigint' }),
    c_float: float('c_float'),
    c_real: real('c_real'),
    c_varchar: varchar('c_varchar', { length: 120 }),
    c_nvarchar: nvarchar('c_nvarchar', { length: 120 }),
    c_char: char('c_char', { length: 4 }),
    c_nchar: nchar('c_nchar', { length: 4 }),
    c_text: text('c_text'),
    c_ntext: ntext('c_ntext'),
    c_date: date('c_date'),
    c_date_str: date('c_date_str', { mode: 'string' }),
    c_datetime: datetime('c_datetime'),
    c_datetime_str: datetime('c_datetime_str', { mode: 'string' }),
    c_datetime2: datetime2('c_datetime2'),
    c_datetime2_str: datetime2('c_datetime2_str', { mode: 'string' }),
    c_dto: datetimeoffset('c_dto'),
    c_dto_str: datetimeoffset('c_dto_str', { mode: 'string' }),
    c_time: time('c_time'),
    c_time_str: time('c_time_str', { mode: 'string' }),
    c_binary: binary('c_binary', { length: 16 }),
    c_varbinary: varbinary('c_varbinary', { length: 32 }),
  });
`;

/** Every column builder `cockroach-core` exports, plus `cockroachEnum` and `.array()`. */
const COCKROACH_SOURCE = `
  import {
    cockroachTable, bigint, bit, bool, boolean, char, cockroachEnum, date, decimal,
    doublePrecision, float, geometry, inet, int2, int4, int8, interval, jsonb, numeric, real,
    smallint, string, text, time, timestamp, uuid, varbit, varchar, vector,
  } from 'drizzle-orm-v1/cockroach-core';
  export const mood = cockroachEnum('mood', ['sad', 'ok', 'happy']);
  export const t = cockroachTable('t', {
    c_int2: int2('c_int2'),
    c_int4: int4('c_int4'),
    c_int8: int8('c_int8', { mode: 'number' }),
    c_smallint: smallint('c_smallint'),
    c_bigint: bigint('c_bigint', { mode: 'number' }),
    c_bigint64: bigint('c_bigint64', { mode: 'bigint' }),
    c_bool: bool('c_bool'),
    c_boolean: boolean('c_boolean'),
    c_decimal: decimal('c_decimal', { precision: 10, scale: 2 }),
    c_decimal_num: decimal('c_decimal_num', { precision: 10, scale: 2, mode: 'number' }),
    c_decimal_big: decimal('c_decimal_big', { precision: 20, scale: 0, mode: 'bigint' }),
    c_numeric: numeric('c_numeric', { precision: 10, scale: 2 }),
    c_real: real('c_real'),
    c_float: float('c_float'),
    c_double: doublePrecision('c_double'),
    c_varchar: varchar('c_varchar', { length: 120 }),
    c_char: char('c_char', { length: 4 }),
    c_text: text('c_text'),
    c_string: string('c_string'),
    c_uuid: uuid('c_uuid'),
    c_jsonb: jsonb('c_jsonb'),
    c_date: date('c_date'),
    c_date_date: date('c_date_date', { mode: 'date' }),
    c_timestamp: timestamp('c_timestamp'),
    c_timestamp_str: timestamp('c_timestamp_str', { mode: 'string' }),
    c_time: time('c_time'),
    c_interval: interval('c_interval'),
    c_inet: inet('c_inet'),
    c_bit: bit('c_bit', { length: 3 }),
    c_varbit: varbit('c_varbit', { length: 8 }),
    c_geometry: geometry('c_geometry', { type: 'point', mode: 'tuple' }),
    c_geometry_xy: geometry('c_geometry_xy', { type: 'point', mode: 'xy' }),
    c_vector: vector('c_vector', { dimensions: 3 }),
    c_enum: mood('c_enum'),
    c_tags: text('c_tags').array(),
  });
`;

/**
 * The builders each fixture names. Compared against the core's own exports below, which is the
 * whole point: a builder a later drizzle release adds fails that comparison by name.
 */
const MSSQL_BUILDERS = [
  'bigint',
  'binary',
  'bit',
  'char',
  'date',
  'datetime',
  'datetime2',
  'datetimeoffset',
  'decimal',
  'float',
  'int',
  'nchar',
  'ntext',
  'numeric',
  'nvarchar',
  'real',
  'smallint',
  'text',
  'time',
  'tinyint',
  'varbinary',
  'varchar',
];

const COCKROACH_BUILDERS = [
  'bigint',
  'bit',
  'bool',
  'boolean',
  'char',
  'date',
  'decimal',
  'doublePrecision',
  'float',
  'geometry',
  'inet',
  'int2',
  'int4',
  'int8',
  'interval',
  'jsonb',
  'numeric',
  'real',
  'smallint',
  'string',
  'text',
  'time',
  'timestamp',
  'uuid',
  'varbit',
  'varchar',
  'vector',
];

const cache = new Map<string, { analysis: Analysis; byName: Map<string, Column> }>();

async function analyzed(name: string, source: string) {
  const hit = cache.get(name);
  if (hit) return hit;
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `v1-${name}.mjs`);
  await fs.writeFile(file, source, 'utf8');
  const analysis = await new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({});
  const table = analysis.tables[0];
  expect(table, `no table analyzed; issues: ${JSON.stringify(analysis.issues)}`).toBeTruthy();
  const out = { analysis, byName: new Map(table.columns.map((c) => [c.name, c])) };
  cache.set(name, out);
  return out;
}

const mssql = () => analyzed('mssql', MSSQL_SOURCE);
const cockroach = () => analyzed('cockroach', COCKROACH_SOURCE);

/**
 * Every column builder a core exports, found by building one and asking whether the result is a
 * column builder. `check`, `foreignKey` and `primaryKey` answer to `.build` too and build no
 * column, so they are named as the exclusions they are.
 */
async function columnBuildersOf(spec: string): Promise<string[]> {
  const mod: Record<string, unknown> = await import(spec);
  const NOT_COLUMNS = new Set(['check', 'foreignKey', 'primaryKey']);
  const shapes: unknown[][] = [
    [],
    [{ mode: 'number' }],
    [{ length: 4 }],
    [{ precision: 10, scale: 2 }],
    [{ dimensions: 3 }],
    [{ type: 'point', mode: 'tuple' }],
  ];
  const found: string[] = [];
  for (const [name, fn] of Object.entries(mod)) {
    if (typeof fn !== 'function' || /^[A-Z]/.test(name) || NOT_COLUMNS.has(name)) continue;
    for (const args of shapes) {
      try {
        const built = (fn as (...a: unknown[]) => { build?: unknown })('probe', ...args);
        if (built && typeof built.build === 'function') {
          found.push(name);
          break;
        }
      } catch {
        // Tried with the next argument shape.
      }
    }
  }
  return found.sort();
}

describe('the fixtures are built by drizzle, not by hand', () => {
  it('names every column builder mssql-core exports', async () => {
    expect(await columnBuildersOf('drizzle-orm-v1/mssql-core')).toEqual([...MSSQL_BUILDERS].sort());
  });

  it('names every column builder cockroach-core exports', async () => {
    expect(await columnBuildersOf('drizzle-orm-v1/cockroach-core')).toEqual(
      [...COCKROACH_BUILDERS].sort()
    );
  });
});

describe('mssql, against a real mssqlTable', () => {
  it('is identified as mssql and types every column', async () => {
    const { analysis } = await mssql();
    expect(analysis.dialect).toBe('mssql');
    expect(analysis.tables[0].columns).toHaveLength(32);
    expect(analysis.tables[0].columns.filter((c) => c.tsType === 'unknown')).toEqual([]);
    expect(analysis.issues.filter((i) => i.code === 'DRZL_ANL_UNKNOWN_COLUMN')).toEqual([]);
  });

  it('bounds tinyint where SQL Server bounds it, as a whole number from 0', async () => {
    // The one column this fixture found wrong. `MsSqlTinyInt` states `dataType: 'number uint8'`
    // and the semantic range table named int8, int16, int24, int32, int53, uint53 and int64 and
    // no uint8, so it fell through to the bare-number arm: NUMERIC, `integer: false`, and the
    // safe-integer bounds. Measured through the emitted schema, that column accepted -1, 3.7,
    // 256 and 9007199254740991, every one of which the server above refuses.
    //
    // Unsigned, which is what separates it from MySQL's `tinyint`: SQL Server's holds 0 to 255
    // where MySQL's holds -128 to 127, and drizzle names them `uint8` and `int8` accordingly.
    const { byName } = await mssql();
    expect(byName.get('c_tinyint')).toMatchObject({
      tsType: 'number',
      dbType: 'TINYINT',
      integer: true,
      min: '0',
      max: '255',
    });
  });

  it('describes every other column as the builder states it', async () => {
    const { byName } = await mssql();
    const actual = Object.fromEntries(
      [...byName.values()].map((c) => [c.name, `${c.tsType}/${c.dbType}`])
    );
    expect(actual).toEqual({
      c_int: 'number/INTEGER',
      c_tinyint: 'number/TINYINT',
      c_smallint: 'number/SMALLINT',
      c_bigint: 'number/BIGINT',
      c_bigint64: 'bigint/BIGINT',
      c_bit: 'boolean/BOOLEAN',
      c_decimal: 'string/NUMERIC',
      c_decimal_num: 'number/NUMERIC',
      c_decimal_big: 'bigint/NUMERIC',
      c_numeric: 'string/NUMERIC',
      c_numeric_num: 'number/NUMERIC',
      c_numeric_big: 'bigint/NUMERIC',
      c_float: 'number/DOUBLE',
      c_real: 'number/REAL',
      c_varchar: 'string/TEXT',
      c_nvarchar: 'string/TEXT',
      c_char: 'string/TEXT',
      c_nchar: 'string/TEXT',
      c_text: 'string/TEXT',
      c_ntext: 'string/TEXT',
      c_date: 'Date/DATE',
      c_date_str: 'string/DATE',
      c_datetime: 'Date/DATE',
      // The two modes of one builder state two different semantics, read off the columns:
      // `datetime()` says `object date` and `datetime({ mode: 'string' })` says `string datetime`.
      // The label follows the semantic drizzle states rather than the builder's name.
      c_datetime_str: 'string/TIMESTAMP',
      c_datetime2: 'Date/DATE',
      c_datetime2_str: 'string/TIMESTAMP',
      c_dto: 'Date/DATE',
      c_dto_str: 'string/TIMESTAMP',
      c_time: 'Date/DATE',
      c_time_str: 'string/TIME',
      c_binary: 'Buffer/BYTEA',
      c_varbinary: 'Buffer/BYTEA',
    });
  });

  it('keeps the string family typed, capped, and free of a borrowed byte budget', async () => {
    const { byName } = await mssql();
    for (const n of ['c_varchar', 'c_nvarchar', 'c_char', 'c_nchar', 'c_text', 'c_ntext']) {
      expect(byName.get(n)?.tsType, `${n} is a string`).toBe('string');
    }
    expect(byName.get('c_varchar')?.maxLength).toBe(120);
    expect(byName.get('c_nvarchar')?.maxLength).toBe(120);
    expect(byName.get('c_char')?.maxLength).toBe(4);
    expect(byName.get('c_nchar')?.maxLength).toBe(4);
    // MySQL's intrinsic TEXT caps are a MySQL fact. SQL Server's `text` holds 2 GB, so borrowing
    // MySQL's 65535 here would refuse rows this server stores.
    expect(byName.get('c_text')?.maxBytes).toBeUndefined();
    expect(byName.get('c_ntext')?.maxBytes).toBeUndefined();
  });

  it('bounds the integer widths and the 4 byte float', async () => {
    const { byName } = await mssql();
    expect(byName.get('c_int')).toMatchObject({
      integer: true,
      min: '-2147483648',
      max: '2147483647',
    });
    expect(byName.get('c_smallint')).toMatchObject({ integer: true, min: '-32768', max: '32767' });
    expect(byName.get('c_bigint64')).toMatchObject({
      integer: true,
      min: '-9223372036854775808',
      max: '9223372036854775807',
    });
    // Measured on SQL Server 2022: a `real` stores 3.4028234663852886e38, the largest finite
    // float32, and refuses the next candidate up with "Arithmetic overflow error for type real",
    // which is MySQL's edge rather than Postgres's.
    expect(byName.get('c_real')).toMatchObject({
      integer: false,
      min: '-340282346638528859811704183484516925440',
      max: '340282346638528859811704183484516925440',
    });
    // 8 byte, so no finite bound is truthful.
    expect(byName.get('c_float')?.max).toBeUndefined();
  });
});

describe('cockroach, against a real cockroachTable', () => {
  it('is identified as cockroach and types every column', async () => {
    const { analysis } = await cockroach();
    expect(analysis.dialect).toBe('cockroach');
    expect(analysis.tables[0].columns).toHaveLength(35);
    expect(analysis.tables[0].columns.filter((c) => c.tsType === 'unknown')).toEqual([]);
    expect(analysis.issues.filter((i) => i.code === 'DRZL_ANL_UNKNOWN_COLUMN')).toEqual([]);
  });

  it('separates a fixed-width bit from a varying one', async () => {
    // `exact` was computed as `codec === 'bit'`, and cockroach columns carry no codec at all, so
    // every one of them came back `exact: false` and a `bit(3)` was indistinguishable from a
    // `varbit(3)`. The server distinguishes them, per the widths in the header: `bit(3)` refuses
    // '' and '1' and `varbit(8)` accepts both.
    //
    // The width had a second problem that only a real builder shows. Cockroach's `bit` takes
    // `{ length: n }`, and the fixture this replaces passed `{ dimensions: 3 }`, which cockroach
    // ignores: it built a default `bit`, whose SQL type is plain `bit` and whose width is 1. A
    // hand-written column object cannot have that kind of bug, and cannot catch it either.
    const { byName } = await cockroach();
    expect(byName.get('c_bit')).toMatchObject({
      tsType: 'string',
      dbType: 'BIT',
      shape: { kind: 'bitstring', length: 3, exact: true },
    });
    expect(byName.get('c_varbit')).toMatchObject({
      tsType: 'string',
      dbType: 'BIT',
      shape: { kind: 'bitstring', length: 8, exact: false },
    });
  });

  it('describes every column as the builder states it', async () => {
    const { byName } = await cockroach();
    const actual = Object.fromEntries(
      [...byName.values()].map((c) => [c.name, `${c.tsType}/${c.dbType}`])
    );
    expect(actual).toEqual({
      c_int2: 'number/SMALLINT',
      c_int4: 'number/INTEGER',
      c_int8: 'number/BIGINT',
      c_smallint: 'number/SMALLINT',
      c_bigint: 'number/BIGINT',
      c_bigint64: 'bigint/BIGINT',
      c_bool: 'boolean/BOOLEAN',
      c_boolean: 'boolean/BOOLEAN',
      c_decimal: 'string/NUMERIC',
      c_decimal_num: 'number/NUMERIC',
      c_decimal_big: 'bigint/NUMERIC',
      c_numeric: 'string/NUMERIC',
      c_real: 'number/REAL',
      c_float: 'number/DOUBLE',
      c_double: 'number/DOUBLE',
      c_varchar: 'string/TEXT',
      c_char: 'string/TEXT',
      c_text: 'string/TEXT',
      c_string: 'string/TEXT',
      c_uuid: 'string/UUID',
      c_jsonb: 'any/JSON',
      c_date: 'string/DATE',
      c_date_date: 'Date/DATE',
      c_timestamp: 'Date/DATE',
      c_timestamp_str: 'string/TIMESTAMP',
      c_time: 'string/TIME',
      c_interval: 'string/INTERVAL',
      c_inet: 'string/INET',
      c_bit: 'string/BIT',
      c_varbit: 'string/BIT',
      c_geometry: '[number, number]/GEOMETRY',
      c_geometry_xy: '{ x: number; y: number }/GEOMETRY',
      c_vector: 'number[]/VECTOR',
      c_enum: 'string/TEXT',
      c_tags: 'string/TEXT',
    });
  });

  it('keeps the shaped columns shaped', async () => {
    const { byName } = await cockroach();
    expect(byName.get('c_jsonb')?.shape).toEqual({ kind: 'json' });
    expect(byName.get('c_geometry')?.shape).toEqual({ kind: 'tuple', length: 2 });
    expect(byName.get('c_geometry_xy')?.shape).toEqual({
      kind: 'numberObject',
      fields: ['x', 'y'],
    });
    expect(byName.get('c_vector')?.shape).toEqual({ kind: 'numberVector', length: 3 });
    expect(byName.get('c_tags')).toMatchObject({ tsType: 'string', arrayDimensions: 1 });
    expect(byName.get('c_enum')?.enumValues).toEqual(['sad', 'ok', 'happy']);
  });

  it('bounds a real where Postgres does, not where MySQL does', async () => {
    // CockroachDB's `real` is a FLOAT4 and it speaks the Postgres wire protocol, so it inherits
    // the Postgres edge: inserting the largest finite float32 makes the column hand back
    // 3.4028235e+38, a double above that float32, which MySQL's bound would refuse.
    const { byName } = await cockroach();
    expect(byName.get('c_real')).toMatchObject({
      integer: false,
      min: '-340282356779733661637539395458142568448',
      max: '340282356779733661637539395458142568448',
    });
    expect(byName.get('c_float')?.max).toBeUndefined();
    expect(byName.get('c_double')?.max).toBeUndefined();
  });
});
