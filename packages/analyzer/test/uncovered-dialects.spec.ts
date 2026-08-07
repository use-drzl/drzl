/**
 * SingleStore and Gel against real drizzle-orm, rather than against hand-written classes.
 *
 * `singlestore-types.spec.ts` and `gel-types.spec.ts` already claimed to cover these two, and both
 * built a fake table out of `class SingleStoreVarchar {}` and a bare `Symbol.for('drizzle:Columns')`
 * object. Neither ever called `singlestoreTable` or `gelTable`, so what they tested is that the
 * analyzer's own regex table agrees with a class list someone typed out by hand. Every type
 * drizzle really ships that nobody thought to type out is invisible to that, and it was not
 * hypothetical: `GelBoolean` was missing from `gel-types.spec.ts`, and a real `boolean()` column
 * came back `unknown` while it passed. `gel-types.spec.ts` builds its table with `gelTable` now
 * and holds itself to `gel-core`'s own export list; `singlestore-types.spec.ts` still does not,
 * which is what the SingleStore half of this file is for.
 *
 * `mssql` and `cockroach` are the other two dialects in the public `Dialect` union. This header
 * used to say they "cannot be reached from here at all", because they exist only in drizzle v1
 * and the workspace resolves `drizzle-orm` to 0.45.2. That stopped being true when
 * `drizzle-orm-v1`, an alias of 1.0.0-rc.4, became a devDependency of this package: both cores
 * import, and `mssql-cockroach-columns.spec.ts` builds a real `mssqlTable` and `cockroachTable`
 * beside this file. The original measurement is in
 * `.superpowers/sdd/2026-08-03-top-100/task-5-report.md`.
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

  it('types every column it is given', async () => {
    // 28 columns tried, none `unknown`. The count is asserted alongside the emptiness so that a
    // regression shows up even if it widens a column this file does not name individually, and so
    // that deleting a column from the fixture cannot quietly shrink the coverage.
    //
    // This asserted `['m']` when it was written, and that measurement is what produced the fix:
    // the enum was the one column left, and its `unknown` was a wrong description rather than a
    // hole, because the generators had been reading `enumValues` all along. See the enum test
    // below.
    const { analysis, unknowns } = await columnsOf('real-singlestore', SINGLESTORE_SOURCE);
    expect(analysis.tables[0].columns).toHaveLength(28);
    expect(unknowns).toEqual([]);
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

  it('types binary and varbinary as the string the driver returns', async () => {
    // This used to assert `Uint8Array` and was labelled DEFECT, which it was: the select schema
    // accepted a Buffer and rejected the string in zod, valibot, arktype and typebox, so it
    // rejected every row. `SingleStoreBinary` and `SingleStoreVarBinary` both declare
    // `dataType: 'string'` and both define a `mapFromDriverValue` that decodes the driver's
    // Buffer, verified by calling it:
    //
    //   mapFromDriverValue(Buffer.from('hi')) -> "hi"   (a string, not bytes)
    //
    // And end to end, over the MySQL wire protocol SingleStore speaks, on both drizzle majors:
    // a row written as `<00 ff 41>` into a varbinary comes back as a 3 code point string with
    // `instanceof Uint8Array` false.
    const { byName } = await columnsOf('real-singlestore', SINGLESTORE_SOURCE);
    expect(byName.get('bin')?.tsType).toBe('string');
    expect(byName.get('vbin')?.tsType).toBe('string');
    expect(byName.get('bin')?.shape).toEqual({ kind: 'byteString', length: 16 });
    expect(byName.get('vbin')?.shape).toEqual({ kind: 'byteString', length: 32 });
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

  it('describes the enum as the string it is, and keeps its members', async () => {
    // This asserted `tsType: 'unknown'` when it was written, and said so with a note that the
    // emitted schema was fine anyway: `enumValues` survives, every generator keys on it before it
    // looks at `tsType`, and the select schema accepts 'sad' and refuses
    // 'definitely-not-a-member' in all five generators.
    //
    // The note went further, and that is what got fixed. It observed that
    // DRZL_ANL_UNKNOWN_COLUMN was therefore a false positive for `m`: it says the validator "will
    // accept any value" while the validator accepts exactly three. A warning wrong about the one
    // column it names teaches the reader to skip the true ones.
    //
    // The class-name map now has arms for `MySqlEnumColumn` and `SingleStoreEnumColumn` beside the
    // `PgEnumColumn` one it already had, so the description matches the schema and the warning is
    // silent here. `string` rather than a union of the members, because that is what v1 answers for
    // the same column and the narrowing lives in `enumValues` on both majors.
    const { byName, analysis } = await columnsOf('real-singlestore', SINGLESTORE_SOURCE);
    expect(byName.get('m')?.tsType).toBe('string');
    expect(byName.get('m')?.enumValues).toEqual(['sad', 'ok', 'happy']);
    expect(analysis.enums.map((e) => e.values)).toContainEqual(['sad', 'ok', 'happy']);

    // Named columns only. A first version asserted the whole issue list was empty, failed on `vec`,
    // and was narrowed to name both sides: `m` must not warn and `vec` must, because `vec` really
    // was unnameable and a fix for the false positive must not silence a true one.
    //
    // `vec` is named now, so this fixture no longer has a true warning to hold the line with. The
    // assertion that matters is the one this test is about, and it is kept as an emptiness check
    // rather than dropped: a warning appearing here again means something regressed.
    const warned = analysis.issues
      .filter((i) => i.code === 'DRZL_ANL_UNKNOWN_COLUMN')
      .map((i) => i.message.match(/"(\w+)"/)?.[1]);
    expect(warned).toEqual([]);
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

  it('types a vector column as the number array the driver returns', async () => {
    // This was a DEFECT, asserting `any` with the note that `/Vector/i` returned it "to avoid
    // unknown in generators". `any` avoided the word and avoided the validation too: the emitted
    // schema accepted 'not a vector', 5 and { a: 1 } in all four libraries.
    //
    // Drizzle stated the truth on the column the whole time, `dataType: 'array'` and the SQL type
    // `vector(3, F32)`, and `mapFromDriverValue` hands back `[1, 2, 3]`. v1 already answered
    // `number[]` with a `numberVector` shape, so naming it here is the two majors agreeing rather
    // than a new opinion. Found by the analyzer fuzzer, alongside the pgvector family.
    const { byName, analysis } = await columnsOf('real-singlestore', SINGLESTORE_SOURCE);
    expect(byName.get('vec')?.tsType).toBe('number[]');
    expect(byName.get('vec')?.shape).toEqual({ kind: 'numberVector', length: 3 });
    // And the warning it used to raise is gone, because there is nothing left to warn about.
    expect(
      analysis.issues.some((i) => i.code === 'DRZL_ANL_UNKNOWN_COLUMN' && /"vec"/.test(i.message))
    ).toBe(false);
  });

  it('types the default decimal mode as the string the driver returns', async () => {
    // Was a DEFECT here: `/Decimal|Numeric|Float|Double|Real/i` matched all three mode classes
    // and returned 'number' for each, so two of the three rejected every row.
    //
    //   mode          class                      driver returns   0.4x said   0.4x says
    //   (default)     SingleStoreDecimal         '1.25' string    number      string
    //   mode:'number' SingleStoreDecimalNumber   1.25   number    number      number
    //   mode:'bigint' SingleStoreDecimalBigInt   125n   bigint    number      bigint
    //
    // MySQL 0.4x ships the identical three classes and had the identical problem, and it is the
    // dialect the row-by-row measurement was taken on, since there is no in-process SingleStore.
    // All three modes on all four dialects that have them are pinned in `decimal-modes.spec.ts`,
    // against those readings; this fixture carries the default mode alone.
    const { byName } = await columnsOf('real-singlestore', SINGLESTORE_SOURCE);
    expect(byName.get('price')?.tsType).toBe('string');
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

  it('types every column whose JavaScript type it can state', async () => {
    // 20 columns tried. The six `unknown` ones are the `cal::` and duration family, whose value
    // is an instance of a class from the `gel` package: see the test below for the measurement
    // and for why stating nothing is the honest answer there. `flag` used to be a seventh, for
    // no reason at all.
    const { analysis, unknowns } = await columnsOf('real-gel', GEL_SOURCE);
    expect(analysis.tables[0].columns).toHaveLength(20);
    expect(unknowns).toEqual(['ts', 'ld', 'lt', 'dd', 'rd', 'd']);
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
    // Gel's decimal really is a string, and it is the one dialect that reached the right answer
    // from the class name alone: `GelDecimal` has an arm of its own, where SingleStore's three
    // mode classes shared one arm with the floats until that was split.
    expect(ts('dec')).toBe('string'); // decimal.d.ts   data: string
    expect(ts('tstz')).toBe('Date'); // timestamptz.d.ts data: Date
  });

  it('states nothing for the cal:: and duration family, whose value is a gel class', async () => {
    // Six columns whose value is an instance of a class from the `gel` package. DRZL cannot
    // import that package, so it cannot express the check, and it says so rather than guessing.
    // The guess it used to make was `string`, which is refused in both directions.
    //
    // GROUND TRUTH, a live Gel 7.1 (`geldata/gel:7`, sys::get_version_as_str() -> 7.1+08db576)
    // read and written through `drizzle-orm/gel` 0.45.2 on `gel@2.2.0`:
    //
    //   column        gel-core declares        SELECT hands back    INSERT accepts
    //   timestamp     data: LocalDateTime      LocalDateTime        LocalDateTime
    //   localDate     data: LocalDate          LocalDate            LocalDate
    //   localTime     data: LocalTime          LocalTime            LocalTime
    //   dateDuration  data: DateDuration       RelativeDuration     DateDuration
    //   relDuration   data: RelativeDuration   RelativeDuration     RelativeDuration
    //   duration      data: Duration           RelativeDuration     Duration
    //
    // The last two lines are the server disagreeing with drizzle's own `.d.ts`, and the server
    // is the arbiter: `dateDuration` and `duration` come back as a `RelativeDuration` and take a
    // `DateDuration`/`Duration` on the way in, refusing a `RelativeDuration` there. An earlier
    // version of this comment recorded `DateDuration` and `Duration` as the SELECT answers,
    // taken from `gel-core/columns/*.d.ts` rather than from a server.
    //
    // A string is refused by that server on INSERT for all six ('2020-01-01T12:00:00',
    // '2020-01-01', '01:02:03', 'P1Y', 'P1Y', 'PT1H' each rejected outright) and returned by it
    // for none, so `string` was not a loose answer here, it was a wrong one in both directions.
    //
    // `timestamptz` and `decimal` were read from the same row and really are a `Date` and a
    // string, which is why they stay in the test above.
    const { byName, analysis } = await columnsOf('real-gel', GEL_SOURCE);
    const ts = (n: string) => byName.get(n)?.tsType;
    for (const n of ['ts', 'ld', 'lt', 'dd', 'rd', 'd']) {
      expect(ts(n), n).toBe('unknown');
      // Not silent. The analyzer's own warning names the column and carries `getSQLType()`, so
      // the absence is reported as an absence rather than papered over.
      expect(
        analysis.issues.some(
          (i) => i.code === 'DRZL_ANL_UNKNOWN_COLUMN' && i.message.includes(`"${n}"`)
        ),
        `no unknown-column warning for ${n}`
      ).toBe(true);
    }
    expect(
      analysis.issues.find((i) => i.message.includes('"ts"'))?.message,
      'the warning identifies the Gel type, not just the column'
    ).toContain('cal::local_datetime');
  });

  it('DEFECT: the "ends in At" heuristic turns one of those six into a Date', async () => {
    // Pre-existing and not introduced here, but newly reachable: `analyzeTable` rewrites any
    // `unknown` column whose name ends in `At` to `Date`, and a Gel `timestamp('createdAt')` is
    // now `unknown` where it used to be `string`. Both answers are refused by the same server
    // (it hands back a `LocalDateTime` and takes one), so nothing got worse; what is lost is the
    // unknown-column warning, which the heuristic suppresses by supplying a value for an
    // absence. Pinned so the day the heuristic is scoped, this test names the consequence.
    const { byName, analysis } = await columnsOf(
      'real-gel-at',
      GEL_SOURCE.replace(
        "ts: timestamp('ts'),",
        "ts: timestamp('ts'), createdAt: timestamp('createdAt'),"
      )
    );
    expect(byName.get('createdAt')?.tsType).toBe('Date');
    expect(
      analysis.issues.some((i) => i.message.includes('"createdAt"')),
      'the heuristic suppresses the warning the other five get'
    ).toBe(false);
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

  it('answers every one of the seven that used to be wrong, and no others', async () => {
    // Every column of the fixture, keyed by name rather than counted, so a fix that repairs one
    // and breaks another fails here naming both. The seven that changed are marked.
    //
    // An earlier version of this test was `wrong.filter((n) => byName.has(n))`, which reads only
    // whether the fixture still defines those columns and never looks at a type at all, while
    // its comment claimed it was the thing stopping a partial fix from looking green. Measured
    // at the time: applying the full gel fix failed three tests in this file and left that one
    // passing.
    const EXPECTED: Record<string, string> = {
      i: 'number',
      si: 'number',
      b64: 'bigint',
      i53: 'number',
      flag: 'boolean', // was `unknown`;  boolean.d.ts  data: boolean, and the server returns one
      name: 'string',
      u: 'string',
      payload: 'any',
      r: 'number',
      dp: 'number',
      dec: 'string',
      b: 'Uint8Array',
      ts: 'unknown', // was `string`;  the server returns a LocalDateTime
      tstz: 'Date',
      ld: 'unknown', // was `string`;  the server returns a LocalDate
      lt: 'unknown', // was `string`;  the server returns a LocalTime
      dd: 'unknown', // was `string`;  the server returns a RelativeDuration
      rd: 'unknown', // was `string`;  the server returns a RelativeDuration
      d: 'unknown', //  was `string`;  the server returns a RelativeDuration
      tags: 'string', // the element type; `arrayDimensions` carries the rest
    };
    const { byName } = await columnsOf('real-gel', GEL_SOURCE);
    const actual = Object.fromEntries([...byName.values()].map((c) => [c.name, c.tsType]));
    expect(actual).toEqual(EXPECTED);
  });

  it('types a boolean column as a boolean, so its validator refuses what is not one', async () => {
    // The `/^Gel/i` arm had cases for integers, floats, decimal, uuid, json, text, bytes and the
    // whole temporal family, and no case for a boolean at all, so `GelBoolean` fell off the end
    // to `unknown` and the emitted field was `z.unknown()`: measured through the emitted zod
    // schema, the column accepted 'yes', 12345 and { a: 1 }. All four validator generators and
    // the JSON Schema generator behaved the same way. A live Gel 7.1 hands back a JS `true`.
    //
    // `gel-types.spec.ts` did not catch it because its hand-written class list has no
    // `GelBoolean` in it. A boolean is the least exotic type a schema can have, which is the
    // point: a fixture written from the implementation can only ever confirm the implementation.
    const { byName, analysis } = await columnsOf('real-gel', GEL_SOURCE);
    expect(byName.get('flag')?.tsType).toBe('boolean');
    expect(byName.get('flag')?.dbType).toBe('BOOLEAN');
    expect(
      analysis.issues.some((i) => i.code === 'DRZL_ANL_UNKNOWN_COLUMN' && /"flag"/.test(i.message))
    ).toBe(false);
  });
});
