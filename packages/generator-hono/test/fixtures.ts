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

/** A serial primary key and one required column: the shape every other fixture varies from. */
export const users = table('users', {
  columns: [
    col('id', 'number', { hasDefault: true, isGenerated: true }),
    col('email', 'string'),
    col('bio', 'string', { nullable: true }),
    // A Date column on a writable table, which this family of fixtures lacked. Without one, the
    // body schemas typed a date as `z.date()` for as long as this generator existed and no test
    // could see it: a JSON body cannot carry a Date, so no valid POST touching this column
    // existed at all. Nullable, so the cases that do not name it stay valid.
    col('seenAt', 'Date', { nullable: true }),
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
