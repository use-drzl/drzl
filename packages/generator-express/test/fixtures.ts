import type { Analysis, Column, Table } from '@drzl/analyzer';

export function col(name: string, tsType: string, over: Partial<Column> = {}): Column {
  return {
    name,
    tsType,
    dbType: tsType.toUpperCase(),
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  } as Column;
}

export function table(name: string, over: Partial<Table> & { columns: Column[] }): Table {
  return {
    name,
    tsName: name,
    unique: [],
    indexes: [],
    ...over,
  } as Table;
}

export function analysis(tables: Table[]): Analysis {
  return { dialect: 'sqlite', tables, enums: [], relations: [], issues: [] };
}

/**
 * A serial primary key and one required column: the shape every other fixture varies from.
 *
 * `role` is an enum column, which the Hono fixture family lacked and this repo has been bitten
 * by before: 5 of the 13 Pro-pack defects traced to fixtures omitting ordinary field types were
 * enums. It rides along on the base table so every mode's schema and the runtime matrix all
 * carry one.
 */
export const users = table('users', {
  columns: [
    col('id', 'number', { hasDefault: true, isGenerated: true }),
    col('email', 'string'),
    col('bio', 'string', { nullable: true }),
    col('role', 'string', { enumValues: ['admin', 'member'], hasDefault: true }),
  ],
  primaryKey: { columns: ['id'] },
});

/** A single-column foreign key, for the relation lookups. */
export const posts = table('posts', {
  columns: [
    col('id', 'number', { hasDefault: true, isGenerated: true }),
    col('authorId', 'number'),
    col('title', 'string'),
  ],
  primaryKey: { columns: ['id'] },
  foreignKeys: [{ columns: ['authorId'], foreignTable: 'users', foreignColumns: ['id'] }],
});

/** A natural, non-numeric primary key: the case a fabricated `z.number()` id gets wrong. */
export const books = table('books', {
  columns: [col('isbn', 'string'), col('title', 'string')],
  primaryKey: { columns: ['isbn'] },
});

/** A composite primary key, which no single scalar addresses. */
export const memberships = table('memberships', {
  columns: [col('orgId', 'number'), col('userId', 'number'), col('role', 'string')],
  primaryKey: { columns: ['orgId', 'userId'] },
});

/** No primary key at all, so no row can be addressed. */
export const auditLog = table('audit_log', {
  tsName: 'auditLog',
  columns: [col('at', 'string'), col('what', 'string')],
});

/** A materialized view: readable, and refuses every write. */
export const activeUsers = table('active_users', {
  tsName: 'activeUsers',
  columns: [col('id', 'number'), col('email', 'string')],
  primaryKey: { columns: ['id'] },
  readOnly: true,
});

/** Read-only *and* keyless: the one table whose routes take no input at all. */
export const dailyTotals = table('daily_totals', {
  tsName: 'dailyTotals',
  columns: [col('day', 'string'), col('total', 'number')],
  readOnly: true,
});
