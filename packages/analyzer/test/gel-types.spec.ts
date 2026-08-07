/**
 * Gel columns, built by `gelTable` and the real column builders, as a user would write them.
 *
 * This file used to build its table out of `class GelInteger {}` and a bare
 * `Symbol.for('drizzle:Columns')` object. Nothing in it ever called `gelTable`, so all it could
 * ever show was that the analyzer's regex table agreed with a class list someone had typed out,
 * and a type drizzle ships that nobody thought to type out was invisible to it. That is not
 * hypothetical: `GelBoolean` was missing from the list, and a real `boolean()` column came back
 * `unknown` while this file passed. A fixture written from the implementation can only ever
 * confirm the implementation.
 *
 * So the fixture is built by the builders now, and one test asserts that it names **every column
 * builder `gel-core` exports**, which is the part a hand-written class list cannot do: a builder
 * added by a later drizzle release fails that test by name rather than going unnoticed.
 *
 * What the old file was really covering, the ordering of the regexes in the `/^Gel/i` arm, is
 * still covered and is now covered by columns that ship: `timestamptz()` must not be caught by
 * the `Timestamp` case, and `localDate()` must not be caught by the `Text` one.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer, type Analysis, type Column } from '../src/index';

const dir = path.resolve(__dirname, 'fixtures');

/**
 * Every column builder `gel-core` exports, each one used once, plus `.array()` on top of one of
 * them. Written out rather than generated so it reads as a schema; the coverage test below is
 * what holds it to the core's own export list.
 */
const GEL_SOURCE = `
  import {
    gelTable, integer, smallint, bigint, bigintT, boolean, text, uuid, json,
    real, doublePrecision, decimal, bytes, timestamp, timestamptz,
    localDate, localTime, dateDuration, relDuration, duration,
  } from 'drizzle-orm/gel-core';
  export const t = gelTable('t', {
    i: integer('i'),
    si: smallint('si'),
    i53: bigint('i53'),
    b64: bigintT('b64'),
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

/** The builders in the fixture above, which the coverage test compares against the core. */
const NAMED_BUILDERS = [
  'integer',
  'smallint',
  'bigint',
  'bigintT',
  'boolean',
  'text',
  'uuid',
  'json',
  'real',
  'doublePrecision',
  'decimal',
  'bytes',
  'timestamp',
  'timestamptz',
  'localDate',
  'localTime',
  'dateDuration',
  'relDuration',
  'duration',
];

let cached: { analysis: Analysis; byName: Map<string, Column> } | undefined;

async function gel() {
  if (cached) return cached;
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'gel-types.mjs');
  await fs.writeFile(file, GEL_SOURCE, 'utf8');
  const analysis = await new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({});
  const table = analysis.tables[0];
  expect(table, `no table analyzed; issues: ${JSON.stringify(analysis.issues)}`).toBeTruthy();
  cached = { analysis, byName: new Map(table.columns.map((c) => [c.name, c])) };
  return cached;
}

describe('the fixture is built by drizzle, not by hand', () => {
  it('names every column builder gel-core exports', async () => {
    // The whole reason this file changed. `check`, `foreignKey` and `primaryKey` also answer to
    // `.build`, and none of them builds a column, so they are named as the exclusions they are.
    const mod: Record<string, unknown> = await import('drizzle-orm/gel-core');
    const NOT_COLUMNS = new Set(['check', 'foreignKey', 'primaryKey']);
    const builders: string[] = [];
    for (const [name, fn] of Object.entries(mod)) {
      if (typeof fn !== 'function' || /^[A-Z]/.test(name) || NOT_COLUMNS.has(name)) continue;
      // A column builder answers to `.build`; a table or schema helper does not. Several need an
      // argument before they will build at all, so more than one shape is tried.
      const shapes: unknown[][] = [[], [{ mode: 'number' }], [{ length: 4 }], [{ dimensions: 3 }]];
      for (const args of shapes) {
        try {
          const built = (fn as (...a: unknown[]) => { build?: unknown })('probe', ...args);
          if (built && typeof built.build === 'function') {
            builders.push(name);
            break;
          }
        } catch {
          // A builder that refuses these arguments is tried with the next shape.
        }
      }
    }
    expect([...builders].sort()).toEqual([...NAMED_BUILDERS].sort());
  });

  it('reaches the drizzle column classes those builders produce', async () => {
    // A fixture can name twenty builders and still exercise five classes, if several share one.
    // These share two: `bigint()` builds a `GelInt53` while `bigintT()` builds the 64 bit one, and
    // `text()` and `text().array()` are both a `GelText`. Asserted as the whole set so that a
    // release which merges two builders into one class, or splits one into two, fails here.
    await gel();
    const mod = (await import(path.join(dir, 'gel-types.mjs'))) as unknown as Record<
      string,
      Record<symbol, Record<string, { baseColumn?: object }>>
    >;
    const columns = mod.t[Symbol.for('drizzle:Columns')];
    const classes = new Set(
      Object.values(columns).map((c) => (c.baseColumn ?? c).constructor.name)
    );
    expect([...classes].sort()).toEqual([
      'GelBigInt64',
      'GelBoolean',
      'GelBytes',
      'GelDateDuration',
      'GelDecimal',
      'GelDoublePrecision',
      'GelDuration',
      'GelInt53',
      'GelInteger',
      'GelJson',
      'GelLocalDateString',
      'GelLocalTime',
      'GelReal',
      'GelRelDuration',
      'GelSmallInt',
      'GelText',
      'GelTimestamp',
      'GelTimestampTz',
      'GelUUID',
    ]);
  });

  it('is analyzed as gel, with every column reaching the analysis', async () => {
    const { analysis } = await gel();
    expect(analysis.dialect).toBe('gel');
    expect(analysis.tables[0].columns).toHaveLength(20);
  });
});

describe('Gel columns, through the real builders', () => {
  it('types every column whose JavaScript type it can state', async () => {
    // Every column of the fixture, keyed by name rather than counted, so a change that repairs
    // one and breaks another fails here naming both.
    const EXPECTED: Record<string, string> = {
      i: 'number',
      si: 'number',
      i53: 'number',
      b64: 'bigint',
      flag: 'boolean',
      name: 'string',
      u: 'string',
      payload: 'any',
      r: 'number',
      dp: 'number',
      dec: 'string',
      b: 'Uint8Array',
      ts: 'unknown',
      tstz: 'Date',
      ld: 'unknown',
      lt: 'unknown',
      dd: 'unknown',
      rd: 'unknown',
      d: 'unknown',
      tags: 'string',
    };
    const { byName } = await gel();
    const actual = Object.fromEntries([...byName.values()].map((c) => [c.name, c.tsType]));
    expect(actual).toEqual(EXPECTED);
  });

  it('keeps the regexes in an order real columns depend on', async () => {
    // The one thing the hand-written class list did cover, now covered by columns drizzle builds.
    // `GelTimestampTz` must be matched before the `Timestamp` case or a timestamptz stops being a
    // `Date`, and `GelLocalDateString` must not be caught by the `Text` one or a localDate becomes
    // a string, which is the answer the server refuses.
    const { byName } = await gel();
    expect(byName.get('tstz')).toMatchObject({ tsType: 'Date', dbType: 'TIMESTAMPTZ' });
    expect(byName.get('ts')?.tsType).toBe('unknown');
    expect(byName.get('ld')?.tsType).toBe('unknown');
    expect(byName.get('name')).toMatchObject({ tsType: 'string', dbType: 'TEXT' });
  });

  it('types a boolean column as a boolean, so its validator refuses what is not one', async () => {
    // The column the hand-written list did not have. `GelBoolean` fell off the end of the arm to
    // `unknown` and the emitted field was `z.unknown()`: measured through the emitted zod schema,
    // the column accepted 'yes', 12345 and { a: 1 }. A live Gel 7.1 hands back a JS `true`.
    const { byName, analysis } = await gel();
    expect(byName.get('flag')).toMatchObject({ tsType: 'boolean', dbType: 'BOOLEAN' });
    expect(
      analysis.issues.some((i) => i.code === 'DRZL_ANL_UNKNOWN_COLUMN' && /"flag"/.test(i.message))
    ).toBe(false);
  });

  it('describes the two float widths by what the server refuses past', async () => {
    // `real` is a `std::float32` and `doublePrecision` a `std::float64`, and both used to answer
    // NUMERIC with no bound at all. Measured on a live Gel 7.1: the float32 edge is Postgres's
    // exactly, and no finite bound is truthful for the 8 byte width.
    const { byName } = await gel();
    expect(byName.get('r')).toMatchObject({
      tsType: 'number',
      dbType: 'REAL',
      integer: false,
      min: '-340282356779733661637539395458142568448',
      max: '340282356779733661637539395458142568448',
      allowsNaN: true,
      allowsInfinity: true,
    });
    expect(byName.get('dp')).toMatchObject({ tsType: 'number', dbType: 'DOUBLE', integer: false });
    expect(byName.get('dp')?.max).toBeUndefined();
  });

  it('gives uuid its format, json its value space, and an array its element', async () => {
    const { byName } = await gel();
    expect(byName.get('u')).toMatchObject({ tsType: 'string', format: 'uuid' });
    expect(byName.get('payload')?.shape).toEqual({ kind: 'json' });
    expect(byName.get('tags')).toMatchObject({ tsType: 'string', arrayDimensions: 1 });
  });
});

describe('the cal:: and duration family, which is deliberately left unknown', () => {
  it('states nothing, and says so per column', async () => {
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
    // A string was refused on INSERT by that server for all six and returned by it for none, so
    // the `string` these used to be answered with was wrong in both directions rather than loose.
    const { byName, analysis } = await gel();
    for (const n of ['ts', 'ld', 'lt', 'dd', 'rd', 'd']) {
      expect(byName.get(n)?.tsType, n).toBe('unknown');
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

  it('carries no mapFromDriverValue, so the driver value reaches the caller untouched', async () => {
    // The reason the class identity above is the whole answer. Drizzle's base `Column` defines
    // an identity `mapFromDriverValue`, and none of these six overrides it, so nothing converts
    // the driver's `LocalDateTime` into anything a validator could describe. `timestamptz` is
    // checked beside them as the control: it does not override it either, and its driver value
    // really is a JS `Date`, which is why that one is typed and these are not.
    const mod = await import('drizzle-orm/gel-core');
    const table = (mod.gelTable as never as (n: string, c: Record<string, unknown>) => never)(
      'probe',
      {
        ts: (mod.timestamp as never as (n: string) => never)('ts'),
        ld: (mod.localDate as never as (n: string) => never)('ld'),
        lt: (mod.localTime as never as (n: string) => never)('lt'),
        dd: (mod.dateDuration as never as (n: string) => never)('dd'),
        rd: (mod.relDuration as never as (n: string) => never)('rd'),
        d: (mod.duration as never as (n: string) => never)('d'),
      }
    );
    const columns = (table as never as Record<symbol, Record<string, object>>)[
      Symbol.for('drizzle:Columns')
    ];
    for (const [name, col] of Object.entries(columns)) {
      // Walk to whichever class in the chain owns the method, rather than testing for its
      // presence: every column has one by inheritance and almost none defines one.
      let proto = Object.getPrototypeOf(col);
      let owner = '';
      while (proto) {
        if (Object.prototype.hasOwnProperty.call(proto, 'mapFromDriverValue')) {
          owner = proto.constructor?.name ?? '';
          break;
        }
        proto = Object.getPrototypeOf(proto);
      }
      expect(owner, `${name} defines its own mapFromDriverValue`).toBe('Column');
    }
  });

  it('cannot be checked, because `gel` is an optional peer a generated module may not have', async () => {
    // The justification for leaving six columns `unknown`, asserted rather than asserted in prose.
    // A runtime check for these would have to name `LocalDateTime` and friends, which live in the
    // `gel` package. drizzle-orm declares that package as an OPTIONAL peer dependency, so a schema
    // can use `gel-core` without it being installed at all, and a generated module that imported
    // it would fail to load for those users. It is not installed here either.
    const req = createRequire(path.join(__dirname, '..', 'package.json'));
    // Through the resolved entry point rather than `drizzle-orm/package.json`, which the
    // package's own `exports` map does not expose.
    const root = path.dirname(req.resolve('drizzle-orm'));
    const drizzlePkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as {
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    expect(drizzlePkg.peerDependencies?.gel, '`gel` is a peer of drizzle-orm').toBeTruthy();
    expect(drizzlePkg.peerDependenciesMeta?.gel?.optional, '`gel` is an OPTIONAL peer').toBe(true);
    expect(() => req.resolve('gel'), '`gel` resolves here after all').toThrow();
  });
});
