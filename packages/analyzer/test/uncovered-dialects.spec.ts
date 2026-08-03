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
    decimal, double, real, float, char, varchar, text, tinytext, mediumtext, longtext,
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
    fl: float('fl'),
    name: varchar('name', { length: 120 }),
    code: char('code', { length: 4 }),
    body: text('body'),
    tiny: tinytext('tiny'),
    medium: mediumtext('medium'),
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
    // 28 columns tried, 1 `unknown`. The count is asserted alongside the name so that a
    // regression shows up even if it widens a column this file does not name individually,
    // and so that deleting a column from the fixture cannot quietly shrink the coverage.
    const { analysis, unknowns } = await columnsOf('real-singlestore', SINGLESTORE_SOURCE);
    expect(analysis.tables[0].columns).toHaveLength(28);
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
    // `float` and `double` are both real JS numbers, unlike `decimal` below.
    expect(ts('fl')).toBe('number');
    expect(ts('dbl')).toBe('number');
    expect(byName.get('payload')?.shape).toEqual({ kind: 'json' });
  });

  it('DEFECT: types binary and varbinary as Uint8Array, and the driver returns a string', async () => {
    // Not this task's to fix, and not specific to SingleStore: `mysql-types.spec.ts` and
    // `sqlite-types.spec.ts` pin the same answer, and MySQL 0.4x behaves identically. It is
    // recorded here because measuring the dialect and stating the truth was the task, and
    // because this is a second reject-every-row case in the same measured spread.
    //
    // `SingleStoreBinary` and `SingleStoreVarBinary` both declare `data: string` and both
    // define a `mapFromDriverValue` that turns the driver's Buffer into a string:
    //
    //   mapFromDriverValue(Buffer.from('hi')) -> "hi"   (a string, not bytes)
    //
    // Measured through the emitted schemas: the select schema accepts a Buffer and rejects
    // the string in zod, valibot, arktype and typebox. The JSON Schema generator is the only
    // one that accepts the real value, and only because it types every byte column as a
    // string anyway.
    const { byName } = await columnsOf('real-singlestore', SINGLESTORE_SOURCE);
    expect(byName.get('bin')?.tsType).toBe('Uint8Array');
    expect(byName.get('vbin')?.tsType).toBe('Uint8Array');
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
    // All four members the fixture carries, so the whole family is covered rather than a
    // sample of it. MySQL's caps for the same four are 255, 65535, 16777215 and 4294967295.
    const { byName } = await columnsOf('real-singlestore', SINGLESTORE_SOURCE);
    for (const n of ['tiny', 'body', 'medium', 'long']) {
      expect(byName.get(n)?.maxBytes, `${n} carries a byte cap`).toBeUndefined();
      expect(byName.get(n)?.maxLength, `${n} carries a length cap`).toBeUndefined();
    }
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

  it('DEFECT: types every decimal mode as number, and only one of the three is a number', async () => {
    // On drizzle 0.4x only. v1 gets all three right and is the reference for what a fix
    // should produce.
    //
    // `decimal` has three modes and the class-name arm cannot tell them apart, because
    // `/Decimal|Numeric|Float|Double|Real/i` matches all three class names and returns
    // 'number' for each. Measured through `mapFromDriverValue` on 0.4x, and through the real
    // analyzer on v1:
    //
    //   mode          class                      driver returns   0.4x says   v1 says
    //   (default)     SingleStoreDecimal         "1.25" string     number      string
    //   mode:'number' SingleStoreDecimalNumber   1.25   number     number      number
    //   mode:'bigint' SingleStoreDecimalBigInt   125n   bigint     number      bigint
    //
    // So two of the three reject every row. A fix told only "decimal should be a string"
    // would break the number mode, which is correct today, and would still miss the bigint
    // mode. MySQL 0.4x has the identical three classes and the identical problem, so this is
    // shared with a covered dialect rather than specific to SingleStore.
    //
    // Only the default mode is in the fixture; the other two are recorded here because the
    // fix has to cover all three and a one-column test would understate it.
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

  it('describes the scalar families correctly', async () => {
    // Each of these was checked against the `data` type drizzle declares in
    // `gel-core/columns/*.d.ts`, not against what the analyzer happens to return.
    const { byName } = await columnsOf('real-gel', GEL_SOURCE);
    const ts = (n: string) => byName.get(n)?.tsType;
    expect(ts('i')).toBe('number'); // integer.d.ts   data: number
    expect(ts('si')).toBe('number');
    // `bigintT` is the 64 bit one; the export literally called `bigint` is Gel's int53.
    expect(ts('b64')).toBe('bigint'); // bigintT.d.ts   data: bigint
    expect(ts('i53')).toBe('number');
    expect(ts('name')).toBe('string');
    expect(ts('b')).toBe('Uint8Array'); // bytes.d.ts     data: Uint8Array
    // Gel's decimal really is a string, and here the analyzer gets it right where
    // SingleStore's does not.
    expect(ts('dec')).toBe('string'); // decimal.d.ts   data: string
    expect(ts('tstz')).toBe('Date'); // timestamptz.d.ts data: Date
  });

  it('DEFECT: types the whole cal:: and duration family as string, which the driver never returns', async () => {
    // Six columns, all of the same species as the SingleStore `decimal` defect below: the
    // analyzer states a JS type the driver does not produce, so a select validator rejects
    // every row the database returns.
    //
    // Drizzle declares each one's `data` as a class from the `gel` package, and none of these
    // six defines a `mapFromDriverValue`, so the instance reaches the caller untouched. Only
    // `bigintT`, `custom` and `doublePrecision` define one anywhere in `gel-core/columns`.
    //
    //   column        gel-core declares          DRZL says   correct answer
    //   timestamp     data: LocalDateTime        string      LocalDateTime
    //   localDate     data: LocalDate            string      LocalDate
    //   localTime     data: LocalTime            string      LocalTime
    //   dateDuration  data: DateDuration         string      DateDuration
    //   relDuration   data: RelativeDuration     string      RelativeDuration
    //   duration      data: Duration             string      Duration
    //
    // Measured against real instances from `gel@2.2.0` through the emitted schemas: all six
    // are rejected by all five generators, and all six accept a string the driver never hands
    // back. `timestamptz` and `decimal` were probed the same way in the same run and are
    // correct, which is why they stay in the test above.
    //
    // The first version of this file asserted all six as correct under a test named
    // "describes the scalar and temporal families correctly", with a comment claiming
    // `timestamp` "arrives as a string". That was a type assumption written down as a
    // measurement, and `string` is exactly what the `/^Gel/i` arm happens to return.
    const { byName } = await columnsOf('real-gel', GEL_SOURCE);
    const ts = (n: string) => byName.get(n)?.tsType;
    expect(ts('ts')).toBe('string');
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

  it('DEFECT: seven holes in total, and a partial fix must not look green', async () => {
    // The boolean plus the six temporal columns, each pinned to the type DRZL returns today
    // and commented with the type drizzle declares. Keyed by column rather than counted, so
    // fixing any single one fails this test naming that column.
    //
    // The first version of this test was `wrong.filter((n) => byName.has(n))`, which reads
    // only whether the fixture still defines those seven columns and never looks at a type at
    // all. Its comment claimed it was the thing stopping a partial fix from looking green.
    // Measured: applying the full gel fix, a boolean case plus all six temporal arms, failed
    // three tests in this file and left that one passing. A vacuous assertion, an expectation
    // traced to the fixture's own column list instead of to ground truth, and a comment
    // promising a property the code did not provide, in six lines.
    const TODAY: Record<string, string> = {
      flag: 'unknown', // boolean.d.ts             data: boolean
      ts: 'string', //    timestamp.d.ts           data: LocalDateTime
      ld: 'string', //    localdate.d.ts           data: LocalDate
      lt: 'string', //    localtime.d.ts           data: LocalTime
      dd: 'string', //    date-duration.d.ts       data: DateDuration
      rd: 'string', //    relative-duration.d.ts   data: RelativeDuration
      d: 'string', //     duration.d.ts            data: Duration
    };
    const { byName } = await columnsOf('real-gel', GEL_SOURCE);
    const actual = Object.fromEntries(
      Object.keys(TODAY).map((n) => [n, byName.get(n)?.tsType])
    );
    expect(actual).toEqual(TODAY);

    // And "seven" is the whole count, not just seven of an unknown number: no column outside
    // that list comes back `unknown` either.
    const named = new Set(Object.keys(TODAY));
    const otherUnknowns = [...byName.values()]
      .filter((c) => !named.has(c.name) && c.tsType === 'unknown')
      .map((c) => c.name);
    expect(otherUnknowns).toEqual([]);
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
