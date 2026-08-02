/**
 * Which columns the database supplies for you, against real drizzle-orm.
 *
 * This is the signal every validation generator uses to decide whether a column may be omitted
 * from an insert, and it was wrong in a way that made valid inserts impossible to express: the
 * analyzer read `col.default` and `col.config.default`, neither of which Drizzle sets, and
 * ignored `col.hasDefault`, which it does. So a `serial` primary key looked exactly like a plain
 * `integer` one, and a natural `text` key looked exactly like an identity column.
 *
 * Drizzle distinguishes them cleanly, so the analyzer has to as well:
 *
 *   pg serial, pg identity, sqlite rowid   hasDefault: true    the database supplies it
 *   pg integer, pg text, sqlite text       hasDefault: false   the caller must supply it
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

/** `{ isGenerated, hasDefault }` for the first column of each table. */
async function flags(name: string, source: string) {
  const a = await analyzeSource(name, source);
  return Object.fromEntries(
    a.tables.map((t) => [
      t.name,
      { isGenerated: t.columns[0].isGenerated, hasDefault: t.columns[0].hasDefault },
    ])
  );
}

describe('columns the database supplies', () => {
  it('marks a Postgres serial, identity column and defaulted uuid as defaulted', async () => {
    const f = await flags(
      'gen-pg-auto',
      `
      import { pgTable, integer, serial, uuid } from 'drizzle-orm/pg-core';
      export const a = pgTable('a', { id: serial('id').primaryKey() });
      export const b = pgTable('b', { id: integer('id').primaryKey().generatedAlwaysAsIdentity() });
      export const c = pgTable('c', { id: uuid('id').primaryKey().defaultRandom() });
      `
    );
    expect(f.a.hasDefault, 'serial').toBe(true);
    expect(f.b.hasDefault, 'identity').toBe(true);
    expect(f.c.hasDefault, 'uuid defaultRandom').toBe(true);
  });

  it('marks a SQLite integer primary key as defaulted, since it aliases rowid', async () => {
    const f = await flags(
      'gen-sqlite-rowid',
      `
      import { sqliteTable, integer } from 'drizzle-orm/sqlite-core';
      export const a = sqliteTable('a', { id: integer('id').primaryKey() });
      `
    );
    expect(f.a.hasDefault).toBe(true);
  });

  it('marks a MySQL autoincrement column as generated', async () => {
    const f = await flags(
      'gen-mysql-auto',
      `
      import { mysqlTable, int } from 'drizzle-orm/mysql-core';
      export const a = mysqlTable('a', { id: int('id').primaryKey().autoincrement() });
      `
    );
    expect(f.a.isGenerated).toBe(true);
  });
});

describe('columns the caller must supply', () => {
  it('does not mark a plain Postgres integer primary key as defaulted', async () => {
    // The case that started this: not auto-generated in Postgres, so the caller has to provide
    // it, and an insert schema that omits it cannot express a valid insert.
    const f = await flags(
      'gen-pg-manual',
      `
      import { pgTable, integer, text } from 'drizzle-orm/pg-core';
      export const a = pgTable('a', { id: integer('id').primaryKey() });
      export const b = pgTable('b', { slug: text('slug').primaryKey() });
      `
    );
    expect(f.a.hasDefault, 'integer pk').toBe(false);
    expect(f.a.isGenerated, 'integer pk').toBe(false);
    expect(f.b.hasDefault, 'natural text key').toBe(false);
    expect(f.b.isGenerated, 'natural text key').toBe(false);
  });

  it('does not mark a natural SQLite text key as defaulted', async () => {
    const f = await flags(
      'gen-sqlite-text',
      `
      import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
      export const a = sqliteTable('a', { slug: text('slug').primaryKey() });
      `
    );
    expect(f.a.hasDefault).toBe(false);
  });

  it('separates a defaulted ordinary column from an undefaulted one', async () => {
    const f = await flags(
      'gen-ordinary',
      `
      import { pgTable, text } from 'drizzle-orm/pg-core';
      export const a = pgTable('a', { country: text('country').default('GB') });
      export const b = pgTable('b', { country: text('country') });
      `
    );
    expect(f.a.hasDefault, 'has .default()').toBe(true);
    expect(f.b.hasDefault, 'no default').toBe(false);
  });
});
