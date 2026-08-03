/**
 * SingleStore and Gel against real drizzle-orm, rather than against hand-written classes.
 *
 * `singlestore-types.spec.ts` and `gel-types.spec.ts` already claim to cover these two, but both
 * build a fake table out of `class SingleStoreVarchar {}` and a bare `Symbol.for('drizzle:Columns')`
 * object. Nothing in either file ever calls `singlestoreTable` or `gelTable`, so what they test is
 * that the analyzer's own regex table agrees with a class list someone typed out by hand. Every
 * type drizzle really ships that nobody thought to type out is invisible to them, and that is not
 * hypothetical: `GelBoolean` is missing from `gel-types.spec.ts`, and a real `boolean()` column
 * comes back `unknown`, which is measured below.
 *
 * `mssql` and `cockroach` are the other two dialects in the public `Dialect` union with no
 * coverage. They exist only in drizzle v1, which is not in this workspace, so they cannot be
 * reached from here at all; they are measured and reported in
 * `.superpowers/sdd/2026-08-03-top-100/task-5-report.md` instead.
 *
 * Everything here runs the real `SchemaAnalyzer` over a real drizzle schema module. Where an
 * assertion pins output that is wrong, the comment says so and says what the right answer is.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer } from '../src/index';

const dir = path.resolve(__dirname, 'fixtures');

async function analyzeSource(name: string, source: string) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.mjs`);
  await fs.writeFile(file, source, 'utf8');
  return new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({});
}

/** Every column of the first table, by name. */
async function columnsOf(name: string, source: string) {
  const a = await analyzeSource(name, source);
  const t = a.tables[0];
  expect(t, `no table was analyzed; issues: ${JSON.stringify(a.issues)}`).toBeTruthy();
  return {
    analysis: a,
    byName: new Map(t!.columns.map((c) => [c.name, c])),
    unknowns: t!.columns.filter((c) => c.tsType === 'unknown').map((c) => c.name),
  };
}

const SINGLESTORE_SOURCE = `
  import {
    singlestoreTable, int, tinyint, smallint, mediumint, bigint, serial, boolean,
    decimal, double, real, char, varchar, text, tinytext, longtext,
    date, datetime, timestamp, time, year, json, binary, varbinary, vector, singlestoreEnum,
  } from 'drizzle-orm/singlestore-core';
  export const t = singlestoreTable('t', {
    id: serial('id'),
    i: int('i'),
    ti: tinyint('ti'),
    si: smallint('si'),
    mi: mediumint('mi'),
    b53: bigint('b53', { mode: 'number' }),
    b64: bigint('b64', { mode: 'bigint' }),
    flag: boolean('flag'),
    price: decimal('price', { precision: 10, scale: 2 }),
    dbl: double('dbl'),
    rl: real('rl'),
    name: varchar('name', { length: 120 }),
    code: char('code', { length: 4 }),
    body: text('body'),
    tiny: tinytext('tiny'),
    long: longtext('long'),
    d: date('d'),
    dt: datetime('dt'),
    ts: timestamp('ts'),
    tm: time('tm'),
    yr: year('yr'),
    payload: json('payload'),
    bin: binary('bin', { length: 16 }),
    vbin: varbinary('vbin', { length: 32 }),
    vec: vector('vec', { dimensions: 3 }),
    m: singlestoreEnum('m', ['sad', 'ok', 'happy']),
  });
`;

describe('SingleStore, against a real singlestoreTable', () => {
  it('is identified as singlestore', async () => {
    const { analysis } = await columnsOf('real-singlestore', SINGLESTORE_SOURCE);
    expect(analysis.dialect).toBe('singlestore');
  });

  it('types every column it is given except the enum', async () => {
    // 26 columns tried, 1 `unknown`. The count is asserted alongside the name so that a
    // regression shows up even if it widens a column this file does not name individually,
    // and so that deleting a column from the fixture cannot quietly shrink the coverage.
    const { analysis, unknowns } = await columnsOf('real-singlestore', SINGLESTORE_SOURCE);
    expect(analysis.tables[0].columns).toHaveLength(26);
    expect(unknowns).toEqual(['m']);
  });

  it('describes the scalar families correctly', async () => {
    const { byName } = await columnsOf('real-singlestore', SINGLESTORE_SOURCE);
    const ts = (n: string) => byName.get(n)?.tsType;
    expect(ts('i')).toBe('number');
    expect(ts('b53')).toBe('number');
    expect(ts('b64')).toBe('bigint');
    expect(ts('flag')).toBe('boolean');
    expect(ts('name')).toBe('string');
    expect(ts('d')).toBe('Date');
    expect(ts('dt')).toBe('Date');
    expect(ts('ts')).toBe('Date');
    expect(ts('tm')).toBe('string');
    expect(ts('bin')).toBe('Uint8Array');
    expect(byName.get('payload')?.shape).toEqual({ kind: 'json' });
  });

  it('carries the declared varchar and char lengths', async () => {
    const { byName } = await columnsOf('real-singlestore', SINGLESTORE_SOURCE);
    expect(byName.get('name')?.maxLength).toBe(120);
    expect(byName.get('code')?.maxLength).toBe(4);
  });

  it('bounds int and smallint by their width', async () => {
    const { byName } = await columnsOf('real-singlestore', SINGLESTORE_SOURCE);
    expect(byName.get('i')).toMatchObject({
      integer: true,
      min: '-2147483648',
      max: '2147483647',
    });
    expect(byName.get('si')).toMatchObject({ integer: true, min: '-32768', max: '32767' });
  });

  it('keeps the enum members even though the column type is unknown', async () => {
    // The column itself is `unknown`, but `enumValues` survives, and every generator keys on
    // `enumValues` before it looks at `tsType`. Measured end to end against zod, valibot,
    // arktype, typebox and the JSON Schema generator: the emitted select schema accepts 'sad'
    // and refuses 'definitely-not-a-member', so this one is not a hole in practice.
    //
    // It does mean the DRZL_ANL_UNKNOWN_COLUMN warning raised for `m` is a false positive: it
    // says the validator "will accept any value" and the validator does no such thing. MySQL's
    // `mysqlEnum` behaves identically, so this is shared with a covered dialect rather than
    // specific to SingleStore.
    const { byName, analysis } = await columnsOf('real-singlestore', SINGLESTORE_SOURCE);
    expect(byName.get('m')?.tsType).toBe('unknown');
    expect(byName.get('m')?.enumValues).toEqual(['sad', 'ok', 'happy']);
    expect(analysis.enums.map((e) => e.values)).toContainEqual(['sad', 'ok', 'happy']);
  });

  it('DEFECT: leaves tinyint and mediumint unbounded, where MySQL bounds them', async () => {
    // `INT_RANGES` carries `MySqlTinyInt` and `MySqlMediumInt` but has no SingleStore entry for
    // either, so the identical column is bounded on one dialect and open on the other. Measured
    // side by side in this same suite run: a MySQL `tinyint` comes back min '-128' max '127',
    // and this one comes back with no bounds at all.
    //
    // Correct values are the same as MySQL's, since SingleStore's integer widths match.
    const { byName } = await columnsOf('real-singlestore', SINGLESTORE_SOURCE);
    expect(byName.get('ti')?.min).toBeUndefined();
    expect(byName.get('ti')?.max).toBeUndefined();
    expect(byName.get('mi')?.min).toBeUndefined();
    expect(byName.get('mi')?.max).toBeUndefined();
  });

  it('DEFECT: puts no cap on the text family, where MySQL caps it in bytes', async () => {
    // The byte-cap table is applied only when `drizzle:entityKind` starts with `MySql`, so a
    // SingleStore `tinytext` gets nothing. Measured through the emitted zod schema: a 300
    // character string is accepted for a column that stores 255 bytes.
    //
    // 0.4x gives every member of the family the same class, `SingleStoreText`, so the SQL type
    // is the only thing that separates them, exactly as it is on MySQL.
    const { byName } = await columnsOf('real-singlestore', SINGLESTORE_SOURCE);
    expect(byName.get('tiny')?.maxBytes).toBeUndefined();
    expect(byName.get('tiny')?.maxLength).toBeUndefined();
    expect(byName.get('long')?.maxBytes).toBeUndefined();
    expect(byName.get('body')?.maxBytes).toBeUndefined();
  });

  it('DEFECT: types a vector column as any, so its validator refuses nothing', async () => {
    // `SingleStoreVector` is matched by the `/Vector/i` arm, which returns `tsType: 'any'` with
    // the comment "model as any to avoid unknown in generators". `any` does avoid the word
    // unknown and it avoids the validation too: measured through the emitted schema for all
    // four validator libraries, this column accepts 'not a vector', 5 and { a: 1 }.
    //
    // Drizzle states the truth on the column: `dataType` is 'array' and the SQL type is
    // 'vector(3, F32)'. The same column on drizzle v1 comes back 'number[]' with
    // `shape: { kind: 'numberVector', length: 3 }` and does reject all three.
    const { byName, analysis } = await columnsOf('real-singlestore', SINGLESTORE_SOURCE);
    expect(byName.get('vec')?.tsType).toBe('any');
    expect(byName.get('vec')?.shape).toBeUndefined();
    // The analyzer does at least say so, which is the one thing standing between this and silence.
    expect(analysis.issues.some((i) => i.code === 'DRZL_ANL_UNKNOWN_COLUMN' && /"vec"/.test(i.message))).toBe(true);
  });

  it('DEFECT: types decimal as a number, which drizzle returns as a string', async () => {
    // `SingleStoreDecimal` reports `dataType: 'string'`: the driver hands back a string because
    // a JS number cannot hold arbitrary precision. The `/Decimal|Numeric|Float|Double|Real/i`
    // arm types it 'number' anyway, so a select validator rejects every row the database
    // returns. This is the incident already recorded on `PgNumeric`, which the same file
    // describes and gets right.
    //
    // MySQL's `decimal` has the same problem through the same arm, so this is not specific to
    // SingleStore; it is included here because it is in the measured spread.
    const { byName } = await columnsOf('real-singlestore', SINGLESTORE_SOURCE);
    expect(byName.get('price')?.tsType).toBe('number');
  });
});

const GEL_SOURCE = `
  import {
    gelTable, integer, smallint, bigintT, bigint, boolean, text, uuid, json,
    real, doublePrecision, decimal, bytes, timestamp, timestamptz,
    localDate, localTime, dateDuration, relDuration, duration,
  } from 'drizzle-orm/gel-core';
  export const t = gelTable('t', {
    i: integer('i'),
    si: smallint('si'),
    b64: bigintT('b64'),
    i53: bigint('i53'),
    flag: boolean('flag'),
    name: text('name'),
    u: uuid('u'),
    payload: json('payload'),
    r: real('r'),
    dp: doublePrecision('dp'),
    dec: decimal('dec'),
    b: bytes('b'),
    ts: timestamp('ts'),
    tstz: timestamptz('tstz'),
    ld: localDate('ld'),
    lt: localTime('lt'),
    dd: dateDuration('dd'),
    rd: relDuration('rd'),
    d: duration('d'),
    tags: text('tags').array(),
  });
`;

describe('Gel, against a real gelTable', () => {
  it('is identified as gel', async () => {
    // Gel exists only on drizzle 0.4x; v1 dropped `gel-core` entirely. This is what keeps the
    // `gel` member of the public `Dialect` union honest: a 0.4x schema really does reach it.
    const { analysis } = await columnsOf('real-gel', GEL_SOURCE);
    expect(analysis.dialect).toBe('gel');
  });

  it('types every column it is given except the boolean', async () => {
    // 20 columns tried, 1 `unknown`.
    const { analysis, unknowns } = await columnsOf('real-gel', GEL_SOURCE);
    expect(analysis.tables[0].columns).toHaveLength(20);
    expect(unknowns).toEqual(['flag']);
  });

  it('describes the scalar and temporal families correctly', async () => {
    const { byName } = await columnsOf('real-gel', GEL_SOURCE);
    const ts = (n: string) => byName.get(n)?.tsType;
    expect(ts('i')).toBe('number');
    expect(ts('si')).toBe('number');
    // `bigintT` is the 64 bit one; the export literally called `bigint` is Gel's int53.
    expect(ts('b64')).toBe('bigint');
    expect(ts('i53')).toBe('number');
    expect(ts('name')).toBe('string');
    expect(ts('b')).toBe('Uint8Array');
    // Gel's decimal is a string, and here the analyzer gets it right where SingleStore's does not.
    expect(ts('dec')).toBe('string');
    // `timestamp` is cal::local_datetime, which has no zone and arrives as a string;
    // `timestamptz` is the one that becomes a Date.
    expect(ts('ts')).toBe('string');
    expect(ts('tstz')).toBe('Date');
    expect(ts('ld')).toBe('string');
    expect(ts('lt')).toBe('string');
    expect(ts('dd')).toBe('string');
    expect(ts('rd')).toBe('string');
    expect(ts('d')).toBe('string');
  });

  it('gives a uuid column its format', async () => {
    const { byName } = await columnsOf('real-gel', GEL_SOURCE);
    expect(byName.get('u')).toMatchObject({ tsType: 'string', format: 'uuid' });
  });

  it('carries the json value space', async () => {
    const { byName } = await columnsOf('real-gel', GEL_SOURCE);
    expect(byName.get('payload')?.shape).toEqual({ kind: 'json' });
  });

  it('reads an array column as an array of its element', async () => {
    // Gel wraps arrays in `GelArray` the way 0.4x Postgres wraps them in `PgArray`, so this
    // goes through the same unwrapping the `.array()` incident added. Worth pinning, because
    // that incident was found on Postgres and nothing checked that Gel came along with it.
    const { byName } = await columnsOf('real-gel', GEL_SOURCE);
    expect(byName.get('tags')).toMatchObject({ tsType: 'string', arrayDimensions: 1 });
  });

  it('DEFECT: types a boolean column as unknown, so its validator refuses nothing', async () => {
    // The `/^Gel/i` arm has cases for integers, floats, decimal, uuid, json, text, bytes and
    // the whole temporal family, and no case for a boolean at all, so `GelBoolean` falls off
    // the end to `unknown`. Measured through the emitted zod schema: this column accepts
    // 'yes', 12345 and { a: 1 }. All four validator generators and the JSON Schema generator
    // behave the same way.
    //
    // `gel-types.spec.ts` does not catch it because its hand-written class list has no
    // `GelBoolean` in it. A boolean is the least exotic type a schema can have, which is the
    // point: a fixture written from the implementation can only ever confirm the implementation.
    const { byName, analysis } = await columnsOf('real-gel', GEL_SOURCE);
    expect(byName.get('flag')?.tsType).toBe('unknown');
    expect(byName.get('flag')?.dbType).toBe('UNKNOWN');
    expect(
      analysis.issues.some((i) => i.code === 'DRZL_ANL_UNKNOWN_COLUMN' && /"flag"/.test(i.message))
    ).toBe(true);
  });
});
