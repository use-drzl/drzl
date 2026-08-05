/**
 * Views, on the drizzle-orm major this package depends on.
 *
 * Drizzle changed how a view answers for itself between majors. On 1.0.0 a view is a Proxy that
 * maps `drizzle:Columns` to its selected fields, `drizzle:Name` to the view's name and
 * `drizzle:Schema` to its schema, exactly as a table does. On every 0.x release it is a plain
 * object carrying three own symbols and none of those three: the columns live only in
 * `Symbol.for('drizzle:ViewBaseConfig').selectedFields`.
 *
 * The analyzer identifies a table-like export by asking for `drizzle:Columns`, so on 0.4x every
 * view was skipped, with no issue raised. Measured on the pg fixture below before the fix: 2
 * relations on 0.45.2 against 8 on 1.0.0-rc.4, `issues: []` on both. A views-only file came back
 * `tables: 0, dialect: unknown, issues: []`. With the fix the two majors' analyses of that same
 * fixture are byte-identical.
 *
 * These tests build against the installed 0.4x, so they fail on the version users actually have
 * rather than only on the one the release gate installs.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer } from '../src/index';

const dir = path.resolve(__dirname, 'fixtures');

async function analyze(name: string, source: string) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.mjs`);
  await fs.writeFile(file, source, 'utf8');
  return new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({ includeRelations: true });
}

const byName = (a: { tables: { name: string }[] }) =>
  Object.fromEntries(a.tables.map((t) => [t.name, t])) as Record<string, any>;

const PG = `
import { pgTable, pgView, pgMaterializedView, pgSchema, integer, text, boolean } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';

export const users = pgTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  active: boolean('active'),
});
export const orders = pgTable('orders', {
  id: integer('id').primaryKey(),
  userId: integer('user_id').references(() => users.id),
  total: integer('total').notNull(),
});
export const activeUsers = pgView('active_users').as((qb) =>
  qb.select().from(users).where(eq(users.active, true)));
export const userOrders = pgView('user_orders').as((qb) =>
  qb.select({ userId: users.id, userName: users.name, total: orders.total })
    .from(users).leftJoin(orders, eq(orders.userId, users.id)));
export const legacyView = pgView('legacy_view', {
  id: integer('id'),
  label: text('label'),
}).existing();
export const userStats = pgMaterializedView('user_stats').as((qb) =>
  qb.select({ id: users.id, name: users.name }).from(users));

const reporting = pgSchema('reporting');
export const reportView = reporting.view('report_view', { id: integer('id') }).existing();
export const reportMv = reporting.materializedView('report_mv', { id: integer('id') }).existing();
`;

describe('a postgres view', () => {
  it('is analysed, under its database name', async () => {
    const a = await analyze('views-pg', PG);
    expect(a.tables.map((t) => t.name).sort()).toEqual([
      'active_users',
      'legacy_view',
      'orders',
      'report_mv',
      'report_view',
      'user_orders',
      'user_stats',
      'users',
    ]);
  });

  it('carries the columns it selects', async () => {
    const t = byName(await analyze('views-pg', PG));
    expect(t.active_users.columns.map((c: any) => c.name)).toEqual(['id', 'name', 'active']);
    expect(t.user_orders.columns.map((c: any) => c.name)).toEqual(['userId', 'userName', 'total']);
    // An explicit column list on a view declared elsewhere is the same shape.
    expect(t.legacy_view.columns.map((c: any) => c.name)).toEqual(['id', 'label']);
  });

  it('keeps each column typed rather than falling back to unknown', async () => {
    const t = byName(await analyze('views-pg', PG));
    const cols = Object.fromEntries(t.user_orders.columns.map((c: any) => [c.name, c]));
    expect(cols.userId).toMatchObject({ tsType: 'number', dbType: 'INTEGER' });
    expect(cols.userName).toMatchObject({ tsType: 'string', dbType: 'TEXT' });
  });

  it('reports the schema a qualified view was declared in', async () => {
    const t = byName(await analyze('views-pg', PG));
    expect(t.report_view.schema).toBe('reporting');
    expect(t.report_mv.schema).toBe('reporting');
    expect(t.active_users.schema).toBeUndefined();
  });

  it('marks a materialized view read-only and leaves a plain view writable', async () => {
    // Postgres refuses every write to a materialized view ("cannot change materialized view"),
    // and accepts an INSERT into a simple auto-updatable view.
    const t = byName(await analyze('views-pg', PG));
    expect(t.user_stats.readOnly).toBe(true);
    expect(t.report_mv.readOnly).toBe(true);
    expect(t.active_users.readOnly).toBeUndefined();
    expect(t.users.readOnly).toBeUndefined();
  });
});

describe('a schema file of nothing but views', () => {
  it('names the dialect', async () => {
    // The dialect loop read `Symbol.for('drizzle:Columns')` directly rather than through the
    // resolver every other site uses, so a fallback living only in the resolver leaves it
    // answering `unknown`. Measured in exactly that state: both views analysed, `dialect:
    // unknown`, and a DRZL_ANL_DIALECT warning on a schema whose dialect is not in doubt.
    const a = await analyze(
      'views-only-pg',
      `
      import { pgView, integer, text } from 'drizzle-orm/pg-core';
      export const a = pgView('a', { id: integer('id'), label: text('label') }).existing();
      export const b = pgView('b', { id: integer('id') }).existing();
      `
    );
    expect(a.dialect).toBe('postgres');
    expect(a.tables.map((t) => t.name)).toEqual(['a', 'b']);
    expect(a.issues).toEqual([]);
    const id = a.tables[0].columns.find((c) => c.name === 'id');
    expect(id).toMatchObject({ tsType: 'number', dbType: 'INTEGER' });
  });
});

describe('a sqlite view', () => {
  it('is analysed and marked read-only', async () => {
    // SQLite refuses every write to a view, insert, update and delete alike, with
    // "cannot modify <name> because it is a view". Measured with node:sqlite; an insert or update
    // schema for one describes an operation the database will always refuse.
    const a = await analyze(
      'views-sqlite',
      `
      import { sqliteTable, sqliteView, integer, text } from 'drizzle-orm/sqlite-core';
      export const users = sqliteTable('users', {
        id: integer('id').primaryKey(),
        name: text('name').notNull(),
      });
      export const activeUsers = sqliteView('active_users').as((qb) => qb.select().from(users));
      `
    );
    expect(a.dialect).toBe('sqlite');
    const t = byName(a);
    expect(t.active_users.columns.map((c: any) => c.name)).toEqual(['id', 'name']);
    expect(t.active_users.readOnly).toBe(true);
    expect(t.users.readOnly).toBeUndefined();
  });
});

describe('a mysql view', () => {
  it('is analysed and stays writable', async () => {
    // MySQL accepts inserts and updates through a simple view (information_schema.views reports
    // is_updatable=YES for one), so it keeps all three schemas.
    const a = await analyze(
      'views-mysql',
      `
      import { mysqlTable, mysqlView, int, varchar } from 'drizzle-orm/mysql-core';
      export const users = mysqlTable('users', {
        id: int('id').primaryKey(),
        name: varchar('name', { length: 40 }).notNull(),
      });
      export const activeUsers = mysqlView('active_users').as((qb) => qb.select().from(users));
      `
    );
    expect(a.dialect).toBe('mysql');
    const t = byName(a);
    expect(t.active_users.columns.map((c: any) => c.name)).toEqual(['id', 'name']);
    expect(t.active_users.readOnly).toBeUndefined();
  });
});
