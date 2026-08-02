/**
 * `.array()` columns on drizzle-orm 0.4x, which is the version this package depends on.
 *
 * Drizzle changed how it models an array between majors. v1 leaves the column class alone and
 * raises `dimensions` on it; 0.4x wraps the column in a `PgArray` whose `baseColumn` is the
 * element. The analyzer only ever read the v1 signal.
 *
 * That was invisible because the whole verification ladder, `verify-packed.sh` included, installs
 * `drizzle-orm@1.0.0-rc.4`. The gate was green, `text().array()` was in the fixture, and on the
 * version users actually have every array column came back `unknown` in all five generators.
 *
 * So these tests build against the installed 0.4x and assert the element type survives.
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

describe('a postgres array column', () => {
  it('reports the element type and one dimension', async () => {
    const cols = await columnsOf(
      'arr-pg',
      `
      import { pgTable, text, integer } from 'drizzle-orm/pg-core';
      export const t = pgTable('t', {
        tags: text('tags').array(),
        nums: integer('nums').array(),
        plain: text('plain'),
      });
      `
    );
    expect(cols.tags).toMatchObject({ tsType: 'string', dbType: 'TEXT', arrayDimensions: 1 });
    expect(cols.nums).toMatchObject({ tsType: 'number', dbType: 'INTEGER', arrayDimensions: 1 });
    expect(cols.plain.arrayDimensions, 'a scalar is not an array').toBeUndefined();
  });

  it('counts nesting for an array of arrays', async () => {
    const cols = await columnsOf(
      'arr-pg-2d',
      `
      import { pgTable, text } from 'drizzle-orm/pg-core';
      export const t = pgTable('t', { grid: text('grid').array().array() });
      `
    );
    expect(cols.grid).toMatchObject({ tsType: 'string', arrayDimensions: 2 });
  });

  it('keeps the element bounds rather than the array getting them', async () => {
    // `columnConstraints` reads the outer column. On an array that is the PgArray, which has no
    // length and no integer range, so a `varchar(10)[]` silently lost its cap.
    const cols = await columnsOf(
      'arr-pg-bounds',
      `
      import { pgTable, varchar, integer } from 'drizzle-orm/pg-core';
      export const t = pgTable('t', {
        names: varchar('names', { length: 10 }).array(),
        nums: integer('nums').array(),
      });
      `
    );
    expect(cols.names.maxLength, 'varchar(10)[] caps each element at 10').toBe(10);
    expect(cols.nums.min, 'integer[] elements are still int32').toBe('-2147483648');
  });

  it('carries an enum array as the enum, not as unknown', async () => {
    const cols = await columnsOf(
      'arr-pg-enum',
      `
      import { pgTable, pgEnum } from 'drizzle-orm/pg-core';
      export const mood = pgEnum('mood', ['sad', 'ok']);
      export const t = pgTable('t', { moods: mood('moods').array() });
      `
    );
    expect(cols.moods).toMatchObject({ arrayDimensions: 1 });
    expect(cols.moods.enumValues).toEqual(['sad', 'ok']);
  });

  it('leaves nullability on the column itself', async () => {
    const cols = await columnsOf(
      'arr-pg-null',
      `
      import { pgTable, text } from 'drizzle-orm/pg-core';
      export const t = pgTable('t', {
        a: text('a').array(),
        b: text('b').array().notNull(),
      });
      `
    );
    expect(cols.a.nullable).toBe(true);
    expect(cols.b.nullable).toBe(false);
  });
});

describe('a pgEnum column on 0.4x', () => {
  // Found by the drizzle-orm 0.4x stage of `verify-packed.sh` the first time it ran. The
  // class-name map had no arm for `PgEnumColumn`, so an enum column was `unknown` and every
  // generator emitted a schema accepting anything, even though `enumValues` was right there.
  it('is a string, so the enum values can be applied to it', async () => {
    const cols = await columnsOf(
      'enum-0.4x',
      `
      import { pgTable, pgEnum } from 'drizzle-orm/pg-core';
      export const mood = pgEnum('mood', ['sad', 'ok', 'happy']);
      export const t = pgTable('t', {
        feeling: mood('feeling').notNull(),
        moods: mood('moods').array().notNull(),
      });
      `
    );
    expect(cols.feeling.tsType).toBe('string');
    expect(cols.feeling.dbType).not.toBe('UNKNOWN');
    expect(cols.feeling.enumValues).toEqual(['sad', 'ok', 'happy']);

    expect(cols.moods.tsType, 'the element type, with the array carried separately').toBe('string');
    expect(cols.moods.dbType).not.toBe('UNKNOWN');
    expect(cols.moods.arrayDimensions).toBe(1);
    expect(cols.moods.enumValues).toEqual(['sad', 'ok', 'happy']);
  });
});
