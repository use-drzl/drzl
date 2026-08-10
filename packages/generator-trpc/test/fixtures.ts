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
    // A Date column on a writable table. The runtime spec here calls procedures through
    // `createCallerFactory`, which hands the resolver whatever JS value it is given and never
    // crosses a transformer, so a `z.date()` input looked fine from inside while no JSON client
    // could satisfy it. Nullable, so the cases that do not name it stay valid.
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

/** A natural, non-numeric primary key. */
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
  columns: [col('at', 'Date'), col('what', 'string')],
});

/**
 * A key column the input schemas cannot type: `bigint` has no JSON transport, so `field()`
 * emits `z.unknown()` for it, and `unknown` is not assignable to the service's `id: bigint`.
 */
export const ledgers = table('ledgers', {
  columns: [col('seq', 'bigint'), col('entry', 'string')],
  primaryKey: { columns: ['seq'] },
});

/** A materialized view: readable, and refuses every write. */
export const activeUsers = table('active_users', {
  tsName: 'activeUsers',
  columns: [col('id', 'number'), col('email', 'string')],
  primaryKey: { columns: ['id'] },
  readOnly: true,
});
