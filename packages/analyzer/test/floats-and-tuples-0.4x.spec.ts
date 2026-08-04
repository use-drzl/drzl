/**
 * `point`, `line` and the inexact numeric types on drizzle-orm 0.4x, the major this package
 * depends on and the one most users have installed.
 *
 * 0.4x carries no `codec`, so every column here reaches the analyzer through the class-name
 * fallback rather than through `describeV1Column`, and that path got two things wrong.
 *
 * `point` and `line` were typed `string` by a coarse `/Point|Line/i` over the class name. They
 * are not strings in either direction. Asked through PGlite, a real Postgres:
 *
 *   drizzle 0.45.2 maps [1, 2] to the literal "(1,2)", Postgres stores it, and
 *   `mapFromDriverValue` hands back [1, 2]                                       accepted
 *   the same column asked to insert the string "1,2" is handed "(1,,)", because
 *   `mapToDriverValue` indexes the value by position, and Postgres answers
 *   `invalid input syntax for type point: "(1,,)"`                               rejected
 *   line, the same way: [1, 2, 3] becomes "{1,2,3}" and "1,2,3" becomes "{1,,,2}"
 *
 * So a select schema built on 0.4x refused every row the driver returned, and an insert schema
 * accepted the one string shape the column cannot be given.
 *
 * The floats carried no bounds at all, because the class-name path reads its ranges from
 * `INT_RANGES` and nothing else. That left DRZL looser than `drizzle-zod@0.8.3`, the first-party
 * validator for this same major, which is the one direction this repository's parity gate exists
 * to forbid.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer } from '../src/index';

const dir = path.resolve(__dirname, 'fixtures');

/** The largest finite float32, which is the only magnitude Postgres refuses on a `real` column. */
const FLOAT4_MAX = '340282346638528859811704183484516925440';

async function tableOf(name: string, source: string) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.mjs`);
  await fs.writeFile(file, source, 'utf8');
  const a = await new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({});
  return a.tables[0];
}

async function columnsOf(name: string, source: string) {
  const t = await tableOf(name, source);
  return Object.fromEntries((t?.columns ?? []).map((c) => [c.name, c]));
}

describe('a postgres point or line column on 0.4x', () => {
  it('is the tuple the driver returns, not a string', async () => {
    const cols = await columnsOf(
      'pg-tuple-0.4x',
      `
      import { pgTable, point, line } from 'drizzle-orm/pg-core';
      export const t = pgTable('t', { p: point(), l: line() });
      `
    );
    expect(cols.p).toMatchObject({
      tsType: '[number, number]',
      dbType: 'POINT',
      shape: { kind: 'tuple', length: 2 },
    });
    expect(cols.l).toMatchObject({
      tsType: '[number, number, number]',
      dbType: 'LINE',
      shape: { kind: 'tuple', length: 3 },
    });
  });

  it('reaches those classes by the names 0.4x actually uses', async () => {
    // The fix is keyed on the constructor name, so the names are asserted rather than assumed.
    // `line()` is the trap: its `drizzle:entityKind` is `PgLine` while its constructor is
    // `PgLineTuple`, so a fix written against the entity kind would have missed it, and the
    // fake `PgLine` class the older pg-types spec builds is a name drizzle never produces.
    const { pgTable, point, line } = await import('drizzle-orm/pg-core');
    const t = pgTable('t', { p: point(), l: line() });
    const cols = t[Symbol.for('drizzle:Columns') as never] as Record<string, { constructor: { name: string } }>;
    expect(cols.p.constructor.name).toBe('PgPointTuple');
    expect(cols.l.constructor.name).toBe('PgLineTuple');
  });

  it('still calls the object modes strings, which is a filed defect and not the intent', async () => {
    // What else `/Point|Line/i` catches. `point({ mode: 'xy' })` is a `PgPointObject` and
    // `line({ mode: 'abc' })` a `PgLineABC`, and both hand back an object rather than a string
    // or a tuple. Left alone here on purpose: drizzle v1 describes them as tuples too, so this
    // is a defect on both majors and fixing it needs a shape the generators do not have yet.
    // Pinned so the next change to that arm has to say what it did to them.
    const cols = await columnsOf(
      'pg-tuple-object-modes-0.4x',
      `
      import { pgTable, point, line } from 'drizzle-orm/pg-core';
      export const t = pgTable('t', { p: point({ mode: 'xy' }), l: line({ mode: 'abc' }) });
      `
    );
    expect(cols.p).toMatchObject({ tsType: 'string', dbType: 'TEXT' });
    expect(cols.l).toMatchObject({ tsType: 'string', dbType: 'TEXT' });
  });
});

describe('an inexact numeric column on 0.4x', () => {
  it('bounds postgres real, double precision and numeric in number mode', async () => {
    const cols = await columnsOf(
      'pg-floats-0.4x',
      `
      import { pgTable, real, doublePrecision, numeric } from 'drizzle-orm/pg-core';
      export const t = pgTable('t', {
        r: real(),
        d: doublePrecision(),
        n: numeric({ precision: 10, scale: 2, mode: 'number' }),
      });
      `
    );
    expect(cols.r).toMatchObject({
      tsType: 'number',
      dbType: 'REAL',
      min: `-${FLOAT4_MAX}`,
      max: FLOAT4_MAX,
      integer: false,
    });
    // An 8 byte float carries no magnitude bound at all, because there is no finite one that is
    // true: PGlite accepted every finite JS number into a `double precision` column up to
    // Number.MAX_VALUE and returned each unchanged. Stated as an absence of a range plus a stated
    // `integer: false`, which is not the same thing as the column being undescribed.
    expect(cols.d).toMatchObject({ tsType: 'number', dbType: 'DOUBLE', integer: false });
    expect(cols.d.min).toBeUndefined();
    expect(cols.d.max).toBeUndefined();
    expect(cols.n).toMatchObject({
      min: '-9007199254740991',
      max: '9007199254740991',
      integer: false,
    });
  });

  it('bounds the mysql, sqlite and singlestore spellings by their real width', async () => {
    const my = await columnsOf(
      'mysql-floats-0.4x',
      `
      import { mysqlTable, real, double, float } from 'drizzle-orm/mysql-core';
      export const t = mysqlTable('t', { r: real(), d: double(), f: float() });
      `
    );
    // MySQL's REAL is a synonym for DOUBLE unless REAL_AS_FLOAT is set, and drizzle v1 says
    // `number double` for it, so it is an 8 byte float and carries no bound.
    for (const c of [my.r, my.d]) {
      expect(c.integer).toBe(false);
      expect(c.min).toBeUndefined();
      expect(c.max).toBeUndefined();
    }
    expect(my.f).toMatchObject({ min: `-${FLOAT4_MAX}`, max: FLOAT4_MAX, integer: false });

    const sq = await columnsOf(
      'sqlite-floats-0.4x',
      `
      import { sqliteTable, real } from 'drizzle-orm/sqlite-core';
      export const t = sqliteTable('t', { r: real() });
      `
    );
    // SQLite's REAL is an 8 byte IEEE float, which is why it is unbounded and not capped at the
    // float4 magnitude its name suggests.
    expect(sq.r).toMatchObject({ integer: false });
    expect(sq.r.min).toBeUndefined();

    const ss = await columnsOf(
      'singlestore-floats-0.4x',
      `
      import { singlestoreTable, real, double, float } from 'drizzle-orm/singlestore-core';
      export const t = singlestoreTable('t', { r: real(), d: double(), f: float() });
      `
    );
    expect(ss.r.min).toBeUndefined();
    expect(ss.d.min).toBeUndefined();
    expect(ss.f).toMatchObject({ min: `-${FLOAT4_MAX}`, max: FLOAT4_MAX, integer: false });
  });

  it('names no class in both range tables', () => {
    // `columnConstraints` applies INT_RANGES and then INEXACT_RANGES, so a class named by both
    // would have its answer decided by the order of two blocks rather than by anything true.
    //
    // Read off the two tables themselves, every key of both. The first version of this test built
    // seven Postgres columns and carried a comment claiming it covered "every class either table
    // names", which was false in two directions at once: it reached 7 of the 29 keys and it
    // touched no MySQL, SQLite or SingleStore class at all. Review counted them. This is the
    // assertion that comment described.
    const tables = SchemaAnalyzer as unknown as {
      INT_RANGES: Record<string, [string, string]>;
      INEXACT_RANGES: Record<string, [string, string] | null>;
    };
    const ints = Object.keys(tables.INT_RANGES);
    const inexact = Object.keys(tables.INEXACT_RANGES);
    // A verification that can succeed by matching nothing is not one: an empty table would make
    // the intersection trivially empty.
    expect(ints.length, 'INT_RANGES is populated').toBeGreaterThan(10);
    expect(inexact.length, 'INEXACT_RANGES is populated').toBeGreaterThan(5);
    expect(ints.filter((k) => inexact.includes(k))).toEqual([]);
  });

  it('separates the two tables by what they say about a column', async () => {
    const cols = await columnsOf(
      'ranges-disjoint-0.4x',
      `
      import { pgTable, integer, smallint, serial, bigint, real, doublePrecision, numeric }
        from 'drizzle-orm/pg-core';
      export const t = pgTable('t', {
        i: integer(), si: smallint(), s: serial(), b: bigint({ mode: 'number' }),
        r: real(), d: doublePrecision(), n: numeric({ precision: 10, scale: 2, mode: 'number' }),
      });
      `
    );
    for (const name of ['i', 'si', 's', 'b']) {
      expect(cols[name].integer, name).toBe(true);
      expect(cols[name].min, name).toBeDefined();
      expect(cols[name].max, name).toBeDefined();
    }
    for (const name of ['r', 'd', 'n']) expect(cols[name].integer, name).toBe(false);
    // `d` is the one that states inexactness with no range, which is a different thing from a
    // column neither table names. Whether a consumer then reaches "not an integer" from the flag
    // alone is `isIntegerColumn`'s job and is executed in generator-zod's structured-columns
    // spec, since `@drzl/validation-core` is not a dependency of this package.
    expect(cols.d.min, 'an 8 byte float carries no magnitude bound').toBeUndefined();
    expect(cols.d.max).toBeUndefined();
  });

  it('states integer:false, which decides the bounded case and nothing on the unbounded one', () => {
    // Three comments claimed `integer: false` was on the unbounded columns to stop
    // `isIntegerColumn` reading a CHECK-derived pair of bounds as an integer range. Review asked
    // for the experiment and it disproves the claim: a CHECK never becomes a column bound at all.
    // The generators fold checks into the emitted range as they emit, and nothing writes them back
    // onto the Column, so `min` and `max` on a `doublePrecision` carrying two bracketing CHECKs
    // are still undefined.
    //
    // `isIntegerColumn` is reimplemented here in its three lines rather than imported, because
    // `@drzl/validation-core` is not a dependency of this package. That is a real weakness of this
    // test: it would not notice that function changing. What it does pin is the input, which is
    // the half this package owns, and generator-zod's structured-columns spec runs the real one.
    const isIntegerColumn = (c: {
      integer?: boolean;
      dbType?: string;
      min?: string;
      max?: string;
    }) => {
      if (typeof c.integer === 'boolean') return c.integer;
      return c.dbType === 'INTEGER' || (c.min !== undefined && c.max !== undefined);
    };
    const bounded = { integer: false, dbType: 'REAL', min: `-${FLOAT4_MAX}`, max: FLOAT4_MAX };
    const unbounded = { integer: false, dbType: 'DOUBLE' };
    const without = <T extends object>(o: T) => {
      const { integer: _drop, ...rest } = o as T & { integer?: boolean };
      return rest;
    };
    // On the bounded column the flag is the whole answer: without it the two bounds are read as an
    // integer range and the emitted schema starts refusing 1.5.
    expect(isIntegerColumn(bounded)).toBe(false);
    expect(isIntegerColumn(without(bounded)), 'the flag is load-bearing here').toBe(true);
    // On the unbounded one it decides nothing, which is what the removed comments got wrong.
    expect(isIntegerColumn(unbounded)).toBe(false);
    expect(isIntegerColumn(without(unbounded)), 'and inert here').toBe(false);
  });

  it('never turns a CHECK into a column bound, on a float or anything else', async () => {
    // The other half of the same disproof, through the real analyzer: two bracketing CHECKs on a
    // `doublePrecision` column leave its range untouched.
    const table = await tableOf(
      'pg-float-check-bounds-0.4x',
      `
      import { pgTable, doublePrecision, real, check } from 'drizzle-orm/pg-core';
      import { sql } from 'drizzle-orm';
      export const t = pgTable('t', { d: doublePrecision(), r: real() }, (x) => [
        check('lo', sql\`\${x.d} >= 0\`),
        check('hi', sql\`\${x.d} <= 100\`),
      ]);
      `
    );
    // The checks were read, so an absent bound below is the analyzer's answer and not a fixture
    // that quietly lost them. A verification that can succeed by matching nothing is not one.
    expect(table.checks?.map((c) => c.expression)).toEqual(['d >= 0', 'd <= 100']);
    const cols = Object.fromEntries(table.columns.map((c) => [c.name, c]));
    expect(cols.d.min, 'a CHECK is not a column bound').toBeUndefined();
    expect(cols.d.max).toBeUndefined();
    expect(cols.d.integer).toBe(false);
  });

  it('carries the database limit, not drizzle-zod, and the limit is the largest float4', async () => {
    // This bound is a measured database edge. PGlite, on a real `real` column: it accepted
    // 3.4028234663852886e38 and returned it identical, and refused 3.4028236e38 with
    // `"3.4028236e+38" is out of range for type real`.
    //
    // It used to be `drizzle-zod`'s +/-8388607, which is not a limit of anything: the same column
    // stores 8388608, 9000000, 1e9 and 2147483648 and returns each unchanged, so that bound made
    // the select schema refuse the column's own rows. The previous version of this test asserted
    // `Number(max) < 16777216`, which pinned the wrong number as a requirement and would have had
    // to be deleted rather than updated to adopt the right one. Review caught that.
    const cols = await columnsOf(
      'pg-float-bound-origin-0.4x',
      `
      import { pgTable, real } from 'drizzle-orm/pg-core';
      export const t = pgTable('t', { r: real() });
      `
    );
    const max = Number(cols.r.max);
    // Written out in full decimal rather than as 3.4028234663852886e38, and this asserts the two
    // are the same double. The spelling is load-bearing: ArkType's string DSL cannot resolve an
    // exponent literal, and the parity stage crashed with
    // `ParseError: '-3.4028234663852886e38' is unresolvable` when the bound was written that way.
    expect(cols.r.max, 'no exponent in the emitted bound').not.toMatch(/e/i);
    expect(max).toBe(3.4028234663852886e38);
    // The largest finite float32, asserted the way JavaScript can check it rather than described:
    // it survives a round trip through float32, and the next float32 up is Infinity.
    expect(Math.fround(max), 'is exactly representable as a float32').toBe(max);
    expect(Math.fround(3.4028236e38), 'and is the last one that is').toBe(Infinity);
    expect(Number.isFinite(max)).toBe(true);
    // The value the old bound refused and the column holds exactly, so this cannot silently
    // regress to a narrower one.
    expect(max).toBeGreaterThan(1e9);
  });

  it('leaves Infinity and NaN outside every range, which the database does not', async () => {
    // Filed, not fixed, and pinned here so it is measured rather than remembered. PGlite stores
    // Infinity and NaN in both `real` and `double precision` and returns them unchanged. A
    // `>=`/`<=` pair cannot admit either, whatever the numbers are, and `z.number()` and
    // `Type.Number()` refuse both with no bound at all. Describing those columns honestly needs a
    // union in every generator rather than a wider range.
    //
    // This asserts what the analyzer states, which is the input to that: a bounded float column
    // has a finite range and no way to say "or Infinity", and an unbounded one says nothing about
    // it either way.
    const cols = await columnsOf(
      'pg-float-inf-0.4x',
      `
      import { pgTable, real, doublePrecision } from 'drizzle-orm/pg-core';
      export const t = pgTable('t', { r: real(), d: doublePrecision() });
      `
    );
    expect(Number.isFinite(Number(cols.r.max))).toBe(true);
    expect(cols.d.max, 'nothing on the 8 byte column to admit or refuse it').toBeUndefined();
  });
});
