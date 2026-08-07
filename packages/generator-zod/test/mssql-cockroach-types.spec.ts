/**
 * The mssql and cockroach dialects, end to end: a real drizzle table, the real analyzer, and the
 * emitted zod module executed against values two real servers handed back or refused.
 *
 * Both cores arrived with Drizzle v1 and neither has ever had a fixture anywhere in this
 * repository. `packages/analyzer/test/uncovered-dialects.spec.ts` says so outright and stops
 * there, because the workspace resolves `drizzle-orm` to 0.45.2, which has no `mssql-core` or
 * `cockroach-core` at all. This file gets at them through `drizzle-orm-v1`, an alias of
 * 1.0.0-rc.4 held as a devDependency of this package alone, so the 0.45.2 every other suite
 * measures against is untouched.
 *
 * Measured before the fix, by running the real analyzer over the two tables below: 7 of 23 mssql
 * columns and 6 of 27 cockroach columns came back `tsType: 'unknown'`, and all thirteen were
 * booleans or strings. Neither dialect states a `codec`, and `describeV1Column` was gated on
 * "a codec, or a semantic half on the dataType". A `bit` states `boolean` and a `varchar` states
 * `string`, both bare, so both failed that gate and fell to the class-name path, which has arms
 * for Pg, MySql, SingleStore and Gel and none for these two.
 *
 * Ground truth is the servers, not drizzle's declarations. SQL Server 2022 and CockroachDB
 * v24.3 were run in Docker, the tables created, rows inserted and read back through drizzle's
 * own drivers; every literal asserted below is a value one of them returned or refused, and the
 * measurement is recorded in `.superpowers/sdd/2026-08-03-top-100/mssql-cockroach-report.md`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer, describeV1Column, type Analysis, type Column } from '@drzl/analyzer';
import { ZodGenerator } from '../src/index';

const dir = path.join(__dirname, '.tmp-mssql-cockroach');

/**
 * Every mssql column family the core exports a builder for, so a hole cannot hide in a type
 * nobody thought to list. `nvarchar`/`nchar`/`ntext` are separate builders from their non-N
 * counterparts and are kept apart here for that reason.
 */
const MSSQL_SOURCE = `
  import {
    mssqlTable, bigint, binary, bit, char, date, datetime, datetime2, datetimeoffset,
    decimal, float, int, nchar, ntext, numeric, nvarchar, real, smallint, text, time,
    tinyint, varbinary, varchar,
  } from 'drizzle-orm-v1/mssql-core';
  export const t = mssqlTable('t', {
    i: int('i'),
    ti: tinyint('ti'),
    si: smallint('si'),
    b53: bigint('b53', { mode: 'number' }),
    b64: bigint('b64', { mode: 'bigint' }),
    flag: bit('flag'),
    price: decimal('price', { precision: 10, scale: 2 }),
    num: numeric('num', { precision: 10, scale: 2 }),
    fl: float('fl'),
    rl: real('rl'),
    name: varchar('name', { length: 120 }),
    nname: nvarchar('nname', { length: 120 }),
    code: char('code', { length: 4 }),
    ncode: nchar('ncode', { length: 4 }),
    body: text('body'),
    nbody: ntext('nbody'),
    d: date('d'),
    dt: datetime('dt'),
    dt2: datetime2('dt2'),
    dto: datetimeoffset('dto'),
    tm: time('tm'),
    bin: binary('bin', { length: 16 }),
    vbin: varbinary('vbin', { length: 32 }),
  });
`;

/** The same spread for cockroach, including the array and enum forms Postgres shares. */
const COCKROACH_SOURCE = `
  import {
    cockroachTable, bigint, bit, boolean, char, cockroachEnum, date, decimal,
    doublePrecision, float, geometry, inet, int4, interval, jsonb, numeric, real,
    smallint, string, text, time, timestamp, uuid, varbit, varchar, vector,
  } from 'drizzle-orm-v1/cockroach-core';
  export const mood = cockroachEnum('mood', ['sad', 'ok', 'happy']);
  export const t = cockroachTable('t', {
    i: int4('i'),
    si: smallint('si'),
    b53: bigint('b53', { mode: 'number' }),
    b64: bigint('b64', { mode: 'bigint' }),
    flag: boolean('flag'),
    dec: decimal('dec', { precision: 10, scale: 2 }),
    num: numeric('num', { precision: 10, scale: 2 }),
    rl: real('rl'),
    fl: float('fl'),
    dp: doublePrecision('dp'),
    name: varchar('name', { length: 120 }),
    code: char('code', { length: 4 }),
    body: text('body'),
    str: string('str'),
    u: uuid('u'),
    payload: jsonb('payload'),
    d: date('d'),
    ts: timestamp('ts'),
    tm: time('tm'),
    iv: interval('iv'),
    ip: inet('ip'),
    // A length, not a dimensions. This fixture passed dimensions for a round, and cockroach
    // ignores it: the column that reached the analyzer was a default bit, whose SQL type is a
    // bare "bit" and whose width is 1, so the declared 3 and 8 never existed. Postgres is the
    // builder that takes dimensions, and copying its call shape is how it got here.
    bt: bit('bt', { length: 3 }),
    vb: varbit('vb', { length: 8 }),
    g: geometry('g', { type: 'point', mode: 'tuple' }),
    vec: vector('vec', { dimensions: 3 }),
    m: mood('m'),
    tags: text('tags').array(),
  });
`;

interface Analyzed {
  analysis: Analysis;
  byName: Map<string, Column>;
  unknowns: string[];
  /** The emitted zod module, imported and ready to run. */
  schemas: Record<string, any>;
}

const cache = new Map<string, Analyzed>();

async function dialect(name: string, source: string): Promise<Analyzed> {
  const hit = cache.get(name);
  if (hit) return hit;
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.schema.mjs`);
  await fs.writeFile(file, source, 'utf8');
  // The real analyzer over the real module, exactly as the CLI runs it.
  const analysis = await new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({});
  const table = analysis.tables[0];
  expect(table, `no table analyzed; issues: ${JSON.stringify(analysis.issues)}`).toBeTruthy();

  // The real generator over that real analysis, then the module is imported and run. Nothing
  // here reads the emitted text: a schema that parses is not a schema that validates.
  const outDir = path.join(dir, `${name}-out`);
  await new ZodGenerator(analysis).generate({ outDir } as never);
  const emitted = path.join(outDir, `t-${process.pid}.ts`);
  await fs.rename(path.join(outDir, 't.zod.ts'), emitted);
  const schemas = await import(emitted);

  const out: Analyzed = {
    analysis,
    byName: new Map(table.columns.map((c) => [c.name, c])),
    unknowns: table.columns.filter((c) => c.tsType === 'unknown').map((c) => c.name),
    schemas,
  };
  cache.set(name, out);
  return out;
}

const mssql = () => dialect('mssql', MSSQL_SOURCE);
const cockroach = () => dialect('cockroach', COCKROACH_SOURCE);

/** The select-side field for one column of the emitted module. */
const field = (a: Analyzed, col: string) => a.schemas.SelecttSchema.shape[col];
const accepts = (schema: any, v: unknown) => schema.safeParse(v).success;

beforeAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('the marker that lets these two dialects through', () => {
  it('does not catch MySql, which is one letter away from MsSql', () => {
    // `MySqlVarChar` and `MsSqlVarChar` differ by a single letter, and a MySQL column on 0.45.2
    // presents exactly the shape the marker was added to admit: `dataType: 'string'`, no codec.
    // Catching it would send every 0.4x MySQL string and boolean down the v1 path and past the
    // byte caps the class-name path applies.
    //
    // The three shapes below were read off real drizzle-orm@0.45.2 columns rather than invented:
    // `varchar('n',{length:10})` is a MySqlVarChar stating `"string"` with codec undefined,
    // `boolean('f')` a MySqlBoolean stating `"boolean"`, `text('b')` a MySqlText stating
    // `"string"`, and the real analyzer answers null for all three.
    const old = (kind: string, dataType: string) => ({
      dataType,
      dimensions: 0,
      constructor: { [Symbol.for('drizzle:entityKind')]: kind },
    });
    expect(describeV1Column(old('MySqlVarChar', 'string'))).toBe(null);
    expect(describeV1Column(old('MySqlBoolean', 'boolean'))).toBe(null);
    expect(describeV1Column(old('MySqlText', 'string'))).toBe(null);
    // And the two it must catch, so this test cannot pass by matching nothing.
    expect(describeV1Column(old('MsSqlVarChar', 'string'))).toMatchObject({ tsType: 'string' });
    expect(describeV1Column(old('CockroachBoolean', 'boolean'))).toMatchObject({
      tsType: 'boolean',
    });
  });
});

describe('mssql, against a real mssqlTable on drizzle v1', () => {
  it('is identified as mssql and reaches every column', async () => {
    const a = await mssql();
    expect(a.analysis.dialect).toBe('mssql');
    expect(a.analysis.tables[0].columns).toHaveLength(23);
  });

  it('leaves no column without a type', async () => {
    // 7 of these 23 were `unknown`: flag, name, nname, code, ncode, body, nbody. The count is
    // asserted next to the list so that shrinking the fixture cannot quietly shrink the coverage.
    const a = await mssql();
    expect(a.unknowns).toEqual([]);
    expect(a.analysis.issues.filter((i) => i.code === 'DRZL_ANL_UNKNOWN_COLUMN')).toEqual([]);
  });

  it('types the bit column as the boolean SQL Server hands back', async () => {
    // Measured on SQL Server 2022: a `bit` column inserted with drizzle and read back through
    // `drizzle-orm/node-mssql` returns JS `true` and `false`, and the server refuses the string
    // 'yes' outright ("Conversion failed when converting the varchar value 'yes' to data type
    // bit").
    const a = await mssql();
    expect(a.byName.get('flag')).toMatchObject({ tsType: 'boolean', dbType: 'BOOLEAN' });
    const f = field(a, 'flag');
    expect(accepts(f, true), 'the true the server returned').toBe(true);
    expect(accepts(f, false), 'the false the server returned').toBe(true);
    expect(accepts(f, 'yes'), 'the string the server refused').toBe(false);
  });

  it('types the whole string family, N-prefixed spellings included', async () => {
    const a = await mssql();
    for (const n of ['name', 'nname', 'code', 'ncode', 'body', 'nbody']) {
      expect(a.byName.get(n)?.tsType, `${n} is a string`).toBe('string');
    }
    // `length` was already being read while the type was unknown, so the cap outlived the type
    // it belonged to. Both survive the fix.
    expect(a.byName.get('name')?.maxLength).toBe(120);
    expect(a.byName.get('nname')?.maxLength).toBe(120);
    expect(a.byName.get('code')?.maxLength).toBe(4);
    expect(a.byName.get('ncode')?.maxLength).toBe(4);
    // MySQL's intrinsic TEXT caps are a MySQL fact. SQL Server's `text` holds 2 GB, so borrowing
    // MySQL's 65535 here would refuse rows this server stores.
    expect(a.byName.get('body')?.maxBytes).toBeUndefined();
    expect(a.byName.get('nbody')?.maxBytes).toBeUndefined();
  });

  it('runs the emitted string schemas against what the server took and refused', async () => {
    // Measured on SQL Server 2022. `varchar(120)` took 120 'a's and refused 121 with "String or
    // binary data would be truncated"; `char(4)`/`nchar(4)` returned 'ab  ', space padded to the
    // declared width; `text`/`ntext` returned the strings they were given.
    const a = await mssql();
    const name = field(a, 'name');
    expect(accepts(name, 'hello'), 'a row the server returned').toBe(true);
    expect(accepts(name, 'a'.repeat(120)), 'the longest value the server took').toBe(true);
    expect(accepts(name, 'a'.repeat(121)), 'the value the server refused').toBe(false);
    expect(accepts(name, 12345), 'a number in a varchar column').toBe(false);

    expect(accepts(field(a, 'code'), 'ab  '), 'the padded char(4) the server returned').toBe(true);
    expect(accepts(field(a, 'ncode'), 'cd  '), 'the padded nchar(4) the server returned').toBe(
      true
    );
    expect(accepts(field(a, 'code'), 'abcde'), 'past the char(4) width').toBe(false);

    expect(accepts(field(a, 'body'), 'body text')).toBe(true);
    expect(accepts(field(a, 'nbody'), 'nbody text')).toBe(true);
    expect(accepts(field(a, 'body'), { a: 1 }), 'an object in a text column').toBe(false);
  });

  it('holds tinyint to the whole numbers 0 to 255 SQL Server stores', async () => {
    // `MsSqlTinyInt` states `dataType: 'number uint8'`, and the semantic range table had no
    // `uint8`, so the column fell to the bare-number arm: NUMERIC, `integer: false`, and the
    // safe-integer bounds. mssql is v1-only, so there was no class-name table to override it the
    // way MySQL's `tinyint` is overridden.
    //
    // GROUND TRUTH, SQL Server 2022 (`mcr.microsoft.com/mssql/server:2022-latest`), one `tinyint`
    // column, each value sent as its own INSERT:
    //
    //   -1                 refused, Msg 220 arithmetic overflow
    //    0                 accepted
    //    255               accepted
    //    256               refused, Msg 220
    //    9007199254740991  refused, Msg 8115
    //    3.7               accepted, and the stored row reads back as 3
    //
    // The select schema describes what the column hands back, and it hands back whole numbers in
    // 0 to 255: the five rows written above read back as 0, 1, 3, 255, 255. `drizzle-orm/zod` at
    // 1.0.0-rc.4 refuses -1, 3.7 and 256 for the same column, so official agrees.
    const a = await mssql();
    expect(a.byName.get('ti')).toMatchObject({
      tsType: 'number',
      dbType: 'TINYINT',
      integer: true,
      min: '0',
      max: '255',
    });
    const ti = field(a, 'ti');
    expect(accepts(ti, 0), 'the 0 the server stored').toBe(true);
    expect(accepts(ti, 255), 'the 255 the server stored').toBe(true);
    expect(accepts(ti, 3), 'the row 3.7 was stored as').toBe(true);
    expect(accepts(ti, -1), 'the value the server refused with Msg 220').toBe(false);
    expect(accepts(ti, 256), 'the value the server refused with Msg 220').toBe(false);
    expect(accepts(ti, 9007199254740991), 'the value the server refused with Msg 8115').toBe(false);
    expect(accepts(ti, 3.7), 'a fraction, which this column never hands back').toBe(false);
  });

  it('keeps a real column at the float32 edge SQL Server stops at', async () => {
    // Measured on SQL Server 2022: a `real` column stores 3.4028234663852886e38, the largest
    // finite float32, and refuses 3.4028235677973366e38 with "Arithmetic overflow error for type
    // real". So MySQL's bound is the right one here, and it is what falling through to it
    // already produced. Asserted so the cockroach change below cannot move it.
    const a = await mssql();
    expect(a.byName.get('rl')).toMatchObject({
      tsType: 'number',
      integer: false,
      min: '-340282346638528859811704183484516925440',
      max: '340282346638528859811704183484516925440',
    });
    const rl = field(a, 'rl');
    expect(accepts(rl, 3.4028234663852886e38), 'the largest value the server stored').toBe(true);
    expect(accepts(rl, 3.4028235677973366e38), 'the value the server refused').toBe(false);
  });
});

describe('cockroach, against a real cockroachTable on drizzle v1', () => {
  it('is identified as cockroach and reaches every column', async () => {
    const a = await cockroach();
    expect(a.analysis.dialect).toBe('cockroach');
    expect(a.analysis.tables[0].columns).toHaveLength(27);
  });

  it('leaves no column without a type', async () => {
    // 6 of these 27 were `unknown`: flag, name, code, body, str and tags. `tags` is a
    // `text().array()`, whose element is the same CockroachString that `body` is, so it was the
    // string hole wearing an array.
    const a = await cockroach();
    expect(a.unknowns).toEqual([]);
    expect(a.analysis.issues.filter((i) => i.code === 'DRZL_ANL_UNKNOWN_COLUMN')).toEqual([]);
  });

  it('types the bool column as the boolean CockroachDB hands back', async () => {
    // Measured on CockroachDB v24.3: a `bool` column read back through `drizzle-orm/cockroach`
    // returns JS `true` and `false`, and the server refuses the integer 1 for it ("value type int
    // doesn't match type bool of column \"flag\"").
    const a = await cockroach();
    expect(a.byName.get('flag')).toMatchObject({ tsType: 'boolean', dbType: 'BOOLEAN' });
    const f = field(a, 'flag');
    expect(accepts(f, true), 'the true the server returned').toBe(true);
    expect(accepts(f, false), 'the false the server returned').toBe(true);
    expect(accepts(f, 1), 'the integer the server refused').toBe(false);
  });

  it('types varchar, char, string and text alike', async () => {
    const a = await cockroach();
    for (const n of ['name', 'code', 'body', 'str']) {
      expect(a.byName.get(n)?.tsType, `${n} is a string`).toBe('string');
    }
    expect(a.byName.get('name')?.maxLength).toBe(120);
    expect(a.byName.get('code')?.maxLength).toBe(4);
    expect(a.byName.get('body')?.maxLength).toBeUndefined();
    expect(a.byName.get('body')?.maxBytes).toBeUndefined();
  });

  it('runs the emitted string schemas against what the server took and refused', async () => {
    // Measured on CockroachDB v24.3: `varchar(120)` took 120 'a's and refused 121 with "value too
    // long for type VARCHAR(120)"; `char(4)` returned 'ab  '; `string` and `string`-as-text
    // returned what they were given.
    const a = await cockroach();
    const name = field(a, 'name');
    expect(accepts(name, 'hello')).toBe(true);
    expect(accepts(name, 'a'.repeat(120)), 'the longest value the server took').toBe(true);
    expect(accepts(name, 'a'.repeat(121)), 'the value the server refused').toBe(false);
    expect(accepts(name, 12345)).toBe(false);
    expect(accepts(field(a, 'code'), 'ab  '), 'the padded char(4) the server returned').toBe(true);
    expect(accepts(field(a, 'body'), 'body text')).toBe(true);
    expect(accepts(field(a, 'str'), 'str text')).toBe(true);
    expect(accepts(field(a, 'str'), 12345)).toBe(false);
  });

  it('reads a string array as an array of strings', async () => {
    // Measured on CockroachDB v24.3: the column returned ['a','b'] and [], and the server refuses
    // a bare string for it ("could not parse \"a\" as type string[]"). Before the fix the element
    // was `unknown`, so the emitted schema was `z.unknown().array()` and took `[1, 2]` as readily
    // as the real rows.
    const a = await cockroach();
    expect(a.byName.get('tags')).toMatchObject({ tsType: 'string', arrayDimensions: 1 });
    const tags = field(a, 'tags');
    expect(accepts(tags, ['a', 'b']), 'the array the server returned').toBe(true);
    expect(accepts(tags, []), 'the empty array the server returned').toBe(true);
    expect(accepts(tags, 'a'), 'the bare string the server refused').toBe(false);
    expect(accepts(tags, [1, 2]), 'numbers in a string[] column').toBe(false);
  });

  it('holds bit to its exact width and varbit to a maximum', async () => {
    // `exact` was `codec === 'bit'`, and cockroach carries no codec, so both came back
    // `exact: false` and `bit(3)` accepted what only a `varbit` takes.
    //
    // GROUND TRUTH, CockroachDB v24.3.5 (`cockroachdb/cockroach:v24.3.5`), one table with a
    // `bit(3)` and a `varbit(8)`, each value sent as its own INSERT:
    //
    //   bit(3)      ''           refused, "bit string length 0 does not match type BIT(3)"
    //   bit(3)      '1'          refused, length 1 does not match
    //   bit(3)      '10'         refused, length 2 does not match
    //   bit(3)      '101'        accepted, and SELECT hands back the string '101'
    //   bit(3)      '1011'       refused, length 4 does not match
    //   varbit(8)   ''           accepted
    //   varbit(8)   '1'          accepted
    //   varbit(8)   '10101010'   accepted, and SELECT hands back '10101010'
    //   varbit(8)   '101010101'  refused, "bit string length 9 too large for type VARBIT(8)"
    const a = await cockroach();
    expect(a.byName.get('bt')?.shape).toEqual({ kind: 'bitstring', length: 3, exact: true });
    expect(a.byName.get('vb')?.shape).toEqual({ kind: 'bitstring', length: 8, exact: false });

    const bt = field(a, 'bt');
    expect(accepts(bt, '101'), 'the value the server stored and returned').toBe(true);
    expect(accepts(bt, ''), 'the empty string the server refused').toBe(false);
    expect(accepts(bt, '1'), 'one digit, refused as length 1').toBe(false);
    expect(accepts(bt, '1011'), 'four digits, refused as length 4').toBe(false);

    const vb = field(a, 'vb');
    expect(accepts(vb, ''), 'the empty string the server accepted').toBe(true);
    expect(accepts(vb, '1'), 'one digit, which varbit takes').toBe(true);
    expect(accepts(vb, '10101010'), 'the value the server returned').toBe(true);
    expect(accepts(vb, '101010101'), 'nine digits, past the declared width').toBe(false);
  });

  it('bounds a real column where Postgres does, not where MySQL does', async () => {
    // CockroachDB's `real` is a FLOAT4: `information_schema.columns` reports crdb_sql_type FLOAT4
    // for it, and it speaks the Postgres wire protocol. Measured on v24.3, the same defect the
    // analyzer already records for Postgres: insert the largest finite float32 and the column
    // hands back 3.4028235e+38, a double *above* that float32. Bounded at MySQL's edge, which is
    // that float32 exactly, the select schema refused a row the column had just returned.
    const a = await cockroach();
    expect(a.byName.get('rl')).toMatchObject({
      tsType: 'number',
      integer: false,
      min: '-340282356779733661637539395458142568448',
      max: '340282356779733661637539395458142568448',
    });
    const rl = field(a, 'rl');
    expect(accepts(rl, 3.4028235e38), 'the value the column handed back').toBe(true);
    // `float`/`doublePrecision` are 8 byte and stay unbounded, so this is a property of the 4
    // byte column and not of every cockroach float.
    expect(a.byName.get('fl')?.max).toBeUndefined();
    expect(a.byName.get('dp')?.max).toBeUndefined();
  });
});
