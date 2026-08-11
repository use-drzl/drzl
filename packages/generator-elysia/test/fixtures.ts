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
 * A serial primary key, a required column, and a Date, which is the column type that decides
 * whether a schema can be a tool schema at all.
 */
export const users = table('users', {
  columns: [
    col('id', 'number', { hasDefault: true, isGenerated: true }),
    col('email', 'string'),
    col('bio', 'string', { nullable: true }),
    col('seenAt', 'Date', { nullable: true }),
  ],
  primaryKey: { columns: ['id'] },
});

/**
 * The whole point of the generator, as a fixture: a CHECK the analyzer has parsed into a bound,
 * plus one it can only state as text because it compares two columns.
 */
export const products = table('products', {
  columns: [
    col('id', 'number', { hasDefault: true, isGenerated: true }),
    col('name', 'string', { maxLength: 80 }),
    col('quantity', 'number', { min: '1', max: '999', integer: true }),
    col('price', 'number'),
    col('cost', 'number'),
  ],
  primaryKey: { columns: ['id'] },
  checks: [
    { name: 'quantity_range', expression: 'quantity >= 1 AND quantity <= 999' },
    { name: 'margin', expression: 'price > cost' },
  ],
});

/** A single-column foreign key. */
export const posts = table('posts', {
  columns: [
    col('id', 'number', { hasDefault: true, isGenerated: true }),
    col('authorId', 'number'),
    col('title', 'string'),
  ],
  primaryKey: { columns: ['id'] },
  foreignKeys: [{ columns: ['authorId'], foreignTable: 'users', foreignColumns: ['id'] }],
});

/** A natural, non-numeric primary key: the case a fabricated numeric `id` gets wrong. */
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

/** Read-only *and* keyless: the one table that gets a single tool. */
export const dailyTotals = table('daily_totals', {
  tsName: 'daily_totals',
  columns: [col('day', 'string'), col('total', 'number')],
  readOnly: true,
});

/** An enum column and a bigint, both of which have their own wire spelling. */
export const events = table('events', {
  columns: [
    col('id', 'bigint'),
    col('kind', 'string', { enumValues: ['created', 'updated', 'deleted'] }),
    col('payload', 'any', { shape: { kind: 'json' } } as Partial<Column>),
  ],
  primaryKey: { columns: ['id'] },
});
