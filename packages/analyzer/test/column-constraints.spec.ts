/**
 * Constraints carried on the column definition itself, which the analyzer used to discard.
 *
 * `varchar('name', { length: 255 })` knows its own limit and `smallint()` knows its range, but
 * the analysis reported only `{ tsType: 'string', dbType: 'TEXT' }` and
 * `{ tsType: 'number', dbType: 'INTEGER' }`. Everything downstream then emitted `z.string()` and
 * `z.number().int()`, so a 300 character name and a smallint of 40000 both validated and then
 * failed at the database.
 *
 * Measured against `drizzle-orm/zod` at 1.0.0-rc.4, which emits:
 *
 *   varchar(255)          max_length <= 255
 *   char(4)               max_length <= 4
 *   uuid()                string, format uuid
 *   smallint()            safeint, -32768 .. 32767
 *   integer()             safeint, -2147483648 .. 2147483647
 *   bigint mode number    safeint, +/- 9007199254740991
 *   bigint mode bigint    bigint,  +/- 9223372036854775807
 *
 * `dbType` is deliberately left alone. Consumers switch on it, and widening the vocabulary would
 * be a breaking change for a distinction the new field already carries.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer } from '../src/index';

const dir = path.resolve(__dirname, 'fixtures');

async function columns(name: string, source: string) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.mjs`);
  await fs.writeFile(file, source, 'utf8');
  const a = await new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({});
  return Object.fromEntries(a.tables[0].columns.map((c) => [c.name, c]));
}

describe('string length', () => {
  it('keeps the declared length of a varchar and a char', async () => {
    const c = await columns(
      'cons-length',
      `
      import { pgTable, varchar, char, text } from 'drizzle-orm/pg-core';
      export const t = pgTable('t', {
        name: varchar('name', { length: 255 }),
        code: char('code', { length: 4 }),
        body: text('body'),
      });
      `
    );
    expect(c.name.maxLength).toBe(255);
    expect(c.code.maxLength).toBe(4);
    // text has no limit, so claiming one would be inventing a constraint.
    expect(c.body.maxLength).toBeUndefined();
  });

  it('leaves a varchar with no declared length unbounded', async () => {
    const c = await columns(
      'cons-nolength',
      `
      import { pgTable, varchar } from 'drizzle-orm/pg-core';
      export const t = pgTable('t', { name: varchar('name') });
      `
    );
    expect(c.name.maxLength).toBeUndefined();
  });

  it('reads the length on MySQL and SQLite too', async () => {
    const my = await columns(
      'cons-mysql',
      `
      import { mysqlTable, varchar } from 'drizzle-orm/mysql-core';
      export const t = mysqlTable('t', { name: varchar('name', { length: 120 }) });
      `
    );
    expect(my.name.maxLength).toBe(120);

    const sq = await columns(
      'cons-sqlite',
      `
      import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
      export const t = sqliteTable('t', { name: text('name', { length: 64 }) });
      `
    );
    expect(sq.name.maxLength).toBe(64);
  });
});

describe('numeric range', () => {
  it('bounds each integer width the way the database does', async () => {
    const c = await columns(
      'cons-ints',
      `
      import { pgTable, smallint, integer, bigint } from 'drizzle-orm/pg-core';
      export const t = pgTable('t', {
        s: smallint('s'),
        i: integer('i'),
        bn: bigint('bn', { mode: 'number' }),
        bb: bigint('bb', { mode: 'bigint' }),
      });
      `
    );
    expect({ min: c.s.min, max: c.s.max }).toEqual({ min: '-32768', max: '32767' });
    expect({ min: c.i.min, max: c.i.max }).toEqual({ min: '-2147483648', max: '2147483647' });
    // In number mode the real limit is JavaScript's, not the column's: a value beyond
    // Number.MAX_SAFE_INTEGER cannot round-trip, so the tighter bound is the honest one.
    expect({ min: c.bn.min, max: c.bn.max }).toEqual({
      min: '-9007199254740991',
      max: '9007199254740991',
    });
    // In bigint mode the full 64 bit range is representable.
    expect({ min: c.bb.min, max: c.bb.max }).toEqual({
      min: '-9223372036854775808',
      max: '9223372036854775807',
    });
  });

  it('carries the bounds as strings, since a 64 bit bound is not a safe number', async () => {
    const c = await columns(
      'cons-bigstr',
      `
      import { pgTable, bigint } from 'drizzle-orm/pg-core';
      export const t = pgTable('t', { b: bigint('b', { mode: 'bigint' }) });
      `
    );
    expect(typeof c.b.max).toBe('string');
    expect(c.b.max).toBe('9223372036854775807');
    // The round trip through a JS number does not survive, which is the whole reason the bound
    // is carried as a string. Comparing two numbers here would compare two already-rounded
    // values and prove nothing.
    expect(String(Number(c.b.max))).not.toBe(c.b.max);
  });

  it('states that a float is inexact, bounds only the width that has one', async () => {
    // Three answers here, and the middle one is the point.
    //
    // `doublePrecision` carries no range. float8 is the JavaScript number's own format, so
    // Postgres takes every finite JS number into one, measured through PGlite to
    // Number.MAX_VALUE and returned identical. Any finite bound would refuse a value the column
    // stores. It still states `integer: false`, and on this column that decides nothing: it is
    // true of the column and it is what makes the *bounded* case work, which the flag test in
    // validation-core's integer-column.spec.ts measures from both ends against the real
    // `isIntegerColumn`. It named floats-and-tuples-0.4x.spec.ts until the measurement moved out
    // of there, and that file now asserts the flag's presence alone.
    //
    // `real` is bounded, at the one magnitude the database does refuse: PGlite takes
    // 3.4028234663852886e38 and answers `out of range for type real` to 3.4028236e38.
    //
    // A `numeric` in its default string mode stays unbounded: a min and a max on a string say
    // nothing a validator can use, and its `format` carries the check instead.
    const c = await columns(
      'cons-float',
      `
      import { pgTable, real, doublePrecision, numeric } from 'drizzle-orm/pg-core';
      export const t = pgTable('t', {
        r: real('r'),
        d: doublePrecision('d'),
        n: numeric('n', { precision: 10, scale: 2 }),
      });
      `
    );
    expect(c.d).toMatchObject({ tsType: 'number', integer: false });
    expect(c.d.min).toBeUndefined();
    expect(c.d.max).toBeUndefined();
    expect(c.r).toMatchObject({
      tsType: 'number',
      min: '-340282346638528859811704183484516925440',
      max: '340282346638528859811704183484516925440',
      integer: false,
    });
    expect(c.n.tsType).toBe('string');
    expect(c.n.min).toBeUndefined();
    expect(c.n.max).toBeUndefined();
  });
});

describe('semantic format', () => {
  it('marks a uuid column, which is a string with a shape', async () => {
    const c = await columns(
      'cons-uuid',
      `
      import { pgTable, uuid, text } from 'drizzle-orm/pg-core';
      export const t = pgTable('t', { id: uuid('id'), body: text('body') });
      `
    );
    expect(c.id.format).toBe('uuid');
    expect(c.body.format).toBeUndefined();
  });
});

describe('backwards compatibility', () => {
  it('leaves tsType and dbType exactly as they were', async () => {
    const c = await columns(
      'cons-compat',
      `
      import { pgTable, varchar, smallint, uuid } from 'drizzle-orm/pg-core';
      export const t = pgTable('t', {
        name: varchar('name', { length: 10 }),
        s: smallint('s'),
        id: uuid('id'),
      });
      `
    );
    expect({ ts: c.name.tsType, db: c.name.dbType }).toEqual({ ts: 'string', db: 'TEXT' });
    expect({ ts: c.s.tsType, db: c.s.dbType }).toEqual({ ts: 'number', db: 'INTEGER' });
    expect({ ts: c.id.tsType, db: c.id.dbType }).toEqual({ ts: 'string', db: 'UUID' });
  });
});
