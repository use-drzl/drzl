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

async function columnsOf(name: string, source: string) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.mjs`);
  await fs.writeFile(file, source, 'utf8');
  const a = await new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({});
  return Object.fromEntries((a.tables[0]?.columns ?? []).map((c) => [c.name, c]));
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
      min: '-8388608',
      max: '8388607',
      integer: false,
    });
    expect(cols.d).toMatchObject({
      min: '-140737488355328',
      max: '140737488355327',
      integer: false,
    });
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
    // `number double` for it, so it takes the wider pair.
    expect(my.r).toMatchObject({ min: '-140737488355328', max: '140737488355327' });
    expect(my.d).toMatchObject({ min: '-140737488355328', max: '140737488355327' });
    expect(my.f).toMatchObject({ min: '-8388608', max: '8388607' });

    const sq = await columnsOf(
      'sqlite-floats-0.4x',
      `
      import { sqliteTable, real } from 'drizzle-orm/sqlite-core';
      export const t = sqliteTable('t', { r: real() });
      `
    );
    // SQLite's REAL is an 8 byte IEEE float, which is why it takes the double pair and not the
    // one its name suggests.
    expect(sq.r).toMatchObject({ min: '-140737488355328', max: '140737488355327' });

    const ss = await columnsOf(
      'singlestore-floats-0.4x',
      `
      import { singlestoreTable, real, double, float } from 'drizzle-orm/singlestore-core';
      export const t = singlestoreTable('t', { r: real(), d: double(), f: float() });
      `
    );
    expect(ss.r).toMatchObject({ min: '-140737488355328', max: '140737488355327' });
    expect(ss.d).toMatchObject({ min: '-140737488355328', max: '140737488355327' });
    expect(ss.f).toMatchObject({ min: '-8388608', max: '8388607' });
  });

  it('is bounded by a table disjoint from the integer one', async () => {
    // `columnConstraints` applies the integer table and then the inexact one, so a class in both
    // would have its answer decided by the order of two blocks. Asserted over every class either
    // table names rather than by reading them, since a later entry is exactly how that would
    // creep in. Read off the analyzer's own output: an integer column keeps `integer: true` and
    // an inexact one keeps `integer: false`, and no column can report both.
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
    const integers = ['i', 'si', 's', 'b'];
    const inexact = ['r', 'd', 'n'];
    for (const name of integers) expect(cols[name].integer, name).toBe(true);
    for (const name of inexact) expect(cols[name].integer, name).toBe(false);
    // And every one of them is bounded, so "disjoint" is not being satisfied by a class that
    // neither table names.
    for (const name of [...integers, ...inexact]) {
      expect(cols[name].min, name).toBeDefined();
      expect(cols[name].max, name).toBeDefined();
    }
  });

  it('is not an integer, so the bounds cannot be read as one', async () => {
    // `isIntegerColumn` falls back to "declares both bounds" when `integer` is absent, so a
    // float that gained a range without the flag would start refusing 1.5.
    const cols = await columnsOf(
      'pg-float-not-integer-0.4x',
      `
      import { pgTable, real } from 'drizzle-orm/pg-core';
      export const t = pgTable('t', { r: real() });
      `
    );
    expect(cols.r.integer).toBe(false);
  });

  it('carries the drizzle bound rather than the width the database can hold', async () => {
    // Measured through PGlite on the column's own `real` type: it holds every integer up to
    // 16777216 exactly, and 16777217 comes back as 16777216. The bound below is half that, so it
    // is `drizzle-zod`'s choice and not the column's limit, and DRZL matches it deliberately so
    // the two majors and the first-party module all agree about the same column. Asserted rather
    // than described, because a sentence claiming a mechanism is how the last several of these
    // went wrong.
    const cols = await columnsOf(
      'pg-float-bound-origin-0.4x',
      `
      import { pgTable, real } from 'drizzle-orm/pg-core';
      export const t = pgTable('t', { r: real() });
      `
    );
    expect(Number(cols.r.max)).toBeLessThan(16777216);
    // And it is not a database limit in the other direction either: PGlite accepted Infinity and
    // NaN into the same `real` column, which no finite bound admits. So the schema is narrower
    // than the column on purpose, and this pins that it is narrow at all.
    expect(Number.isFinite(Number(cols.r.max))).toBe(true);
  });
});
