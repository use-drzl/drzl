/**
 * `Column.sqlType`: the type as the database declares it.
 *
 * `dbType` is deliberately a label. The analyzer normalises `varchar`, `char` and `text` to the
 * single word `TEXT` because exactly one consumer reads it, `isIntegerColumn`, and that consumer
 * only asks whether a number is whole. So `dbType` cannot answer "what is this column", and a
 * `varchar(255)` and a `text` are the same string there.
 *
 * Drizzle already knows the real answer and every column carries it: `getSQLType()` is what the
 * migration would write. It is the one fact about a column that no validator schema can carry,
 * and it is what every other fact here is a consequence of, so it is the first thing a consumer
 * reading generated metadata wants.
 *
 * The one place the two Drizzle majors disagree is an array, measured here rather than assumed:
 * 0.4x wraps the column in a `PgArray` whose `getSQLType()` already says `text[]`, while v1 leaves
 * the class alone and raises `dimensions`, so its own answer is the bare `text`. The analyzer
 * spells both the same way, because a consumer should not be able to tell which major produced
 * its metadata.
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

describe('the declared SQL type', () => {
  it('carries the width that dbType throws away', async () => {
    const cols = await columnsOf(
      'sqltype-pg',
      `
      import { pgTable, varchar, char, text, numeric, timestamp, serial } from 'drizzle-orm/pg-core';
      export const t = pgTable('t', {
        id: serial('id').primaryKey(),
        name: varchar('name', { length: 255 }),
        code: char('code', { length: 4 }),
        body: text('body'),
        price: numeric('price', { precision: 10, scale: 2 }),
        at: timestamp('at', { withTimezone: true }),
      });
      `
    );
    expect(cols.id.sqlType).toBe('serial');
    expect(cols.name.sqlType).toBe('varchar(255)');
    expect(cols.code.sqlType).toBe('char(4)');
    expect(cols.body.sqlType).toBe('text');
    expect(cols.price.sqlType).toBe('numeric(10, 2)');
    expect(cols.at.sqlType).toBe('timestamp with time zone');

    // The point of the field: all three string columns are the same `dbType`.
    expect([cols.name.dbType, cols.code.dbType, cols.body.dbType]).toEqual([
      'TEXT',
      'TEXT',
      'TEXT',
    ]);
  });

  it('names a pg enum by its type name', async () => {
    const cols = await columnsOf(
      'sqltype-enum',
      `
      import { pgTable, pgEnum } from 'drizzle-orm/pg-core';
      export const mood = pgEnum('mood', ['ok', 'sad']);
      export const t = pgTable('t', { m: mood('m') });
      `
    );
    expect(cols.m.sqlType).toBe('mood');
  });

  it('spells an array the same way on either drizzle major', async () => {
    // 0.4x answers `text[]` from the wrapping PgArray. v1 answers `text` and raises `dimensions`,
    // so the suffix is added from `arrayDimensions` when the type does not already carry one.
    const cols = await columnsOf(
      'sqltype-array',
      `
      import { pgTable, text } from 'drizzle-orm/pg-core';
      export const t = pgTable('t', {
        tags: text('tags').array(),
        grid: text('grid').array().array(),
        plain: text('plain'),
      });
      `
    );
    expect(cols.tags.sqlType).toBe('text[]');
    expect(cols.grid.sqlType).toBe('text' + '[]'.repeat(cols.grid.arrayDimensions ?? 0));
    expect(cols.plain.sqlType).toBe('text');
  });

  it('adds the array suffix v1 does not spell for itself', async () => {
    // The other half of the reconciliation, and the half the 0.4x path above cannot exercise:
    // v1 leaves the column class alone and raises `dimensions`, so `getSQLType()` answers the
    // bare element type and the suffix has to come from `arrayDimensions`. Without this the two
    // majors describe the same column differently, which is what the cross-major stage in
    // `scripts/verify-packed.sh` fails on.
    const cols = await columnsOf(
      'sqltype-array-v1',
      `
      import { pgTable, text, integer } from 'drizzle-orm-v1/pg-core';
      export const t = pgTable('t', {
        tags: text('tags').array(),
        nums: integer('nums').array(),
        plain: text('plain'),
      });
      `
    );
    expect(cols.tags.arrayDimensions, 'v1 raises dimensions rather than wrapping').toBe(1);
    expect(cols.tags.sqlType).toBe('text[]');
    expect(cols.nums.sqlType).toBe('integer[]');
    expect(cols.plain.sqlType).toBe('text');
  });

  it('carries the declared width on mysql too', async () => {
    const cols = await columnsOf(
      'sqltype-mysql',
      `
      import { mysqlTable, varchar, tinytext, decimal, binary } from 'drizzle-orm/mysql-core';
      export const t = mysqlTable('t', {
        a: varchar('a', { length: 10 }),
        b: tinytext('b'),
        c: decimal('c', { precision: 8, scale: 3 }),
        d: binary('d', { length: 4 }),
      });
      `
    );
    expect(cols.a.sqlType).toBe('varchar(10)');
    expect(cols.b.sqlType).toBe('tinytext');
    expect(cols.c.sqlType).toBe('decimal(8,3)');
    expect(cols.d.sqlType).toBe('binary(4)');
  });

  it('is absent rather than guessed when the column cannot say', async () => {
    // Nothing in the analysis invents this: a column whose builder has no `getSQLType` leaves the
    // field off entirely, so "absent" and "unknown" are the same answer and neither is a string a
    // consumer could act on by mistake.
    const cols = await columnsOf(
      'sqltype-sqlite',
      `
      import { sqliteTable, text, integer, blob } from 'drizzle-orm/sqlite-core';
      export const t = sqliteTable('t', {
        a: text('a'),
        b: integer('b', { mode: 'timestamp' }),
        c: blob('c'),
      });
      `
    );
    expect(cols.a.sqlType).toBe('text');
    expect(cols.b.sqlType).toBe('integer');
    expect(cols.c.sqlType).toBe('blob');
  });
});
