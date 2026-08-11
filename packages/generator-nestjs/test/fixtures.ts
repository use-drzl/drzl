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
 * enums. It rides along on the base table so every mode's DTO and the runtime matrix all
 * carry one. `bio` is the nullable no-default column the presence rule is measured on.
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

/** A single-column foreign key, riding along so multi-table emission is exercised. */
export const posts = table('posts', {
  columns: [
    col('id', 'number', { hasDefault: true, isGenerated: true }),
    col('authorId', 'number'),
    col('title', 'string'),
  ],
  primaryKey: { columns: ['id'] },
  foreignKeys: [{ columns: ['authorId'], foreignTable: 'users', foreignColumns: ['id'] }],
});

/**
 * A natural, non-numeric primary key, plus a column whose name is not an identifier, which a
 * class field has to quote the same way the schema object key does.
 */
export const books = table('books', {
  columns: [
    col('isbn', 'string'),
    col('title', 'string'),
    col('cover url', 'string', { nullable: true }),
  ],
  primaryKey: { columns: ['isbn'] },
});

/** A composite primary key, which no single scalar addresses. */
export const memberships = table('memberships', {
  columns: [col('orgId', 'number'), col('userId', 'number'), col('role', 'string')],
  primaryKey: { columns: ['orgId', 'userId'] },
});

/**
 * No primary key at all, so no params DTO; `payload` has a type the analyzer could not narrow,
 * so the module carries the wide note and validates it as unknown.
 */
export const auditLog = table('audit_log', {
  tsName: 'auditLog',
  columns: [col('at', 'string'), col('what', 'string'), col('payload', 'JsonValue')],
});

/** A materialized view: readable, and refuses every write, so no create or update DTO. */
export const activeUsers = table('active_users', {
  tsName: 'activeUsers',
  columns: [col('id', 'number'), col('email', 'string')],
  primaryKey: { columns: ['id'] },
  readOnly: true,
});

/** Read-only *and* keyless: entity only, nothing else to emit. */
export const dailyTotals = table('daily_totals', {
  tsName: 'dailyTotals',
  columns: [col('day', 'string'), col('total', 'number')],
  readOnly: true,
});

/**
 * The column kinds with wire-shape decisions of their own, in one row: a `Date` that crosses
 * JSON as a strict ISO string and reaches the controller as a `Date`, a `bigint` that crosses
 * as its decimal digits and stays a string on both sides (JSON.stringify throws on a real
 * bigint, pinned in the runtime spec), a tuple shape validated as unknown, a boolean, and a
 * nullable column. A fixture family without these is how 13 defects shipped once.
 */
export const events = table('events', {
  columns: [
    col('id', 'number', { integer: true, hasDefault: true, isGenerated: true }),
    col('at', 'Date'),
    col('flag', 'boolean'),
    col('big', 'bigint'),
    col('point', '[number, number]', { shape: { kind: 'tuple', length: 2 } }),
    // A json column and a binary one, the two that used to be `unknown` here while every
    // standalone validator generator typed them. Both cross JSON in a form of their own: json
    // natively, binary as base64, which the write side decodes to the bytes the driver wants.
    col('prefs', 'any', { shape: { kind: 'json' }, nullable: true }),
    col('blob', 'Uint8Array', { shape: { kind: 'buffer' }, nullable: true }),
    col('note', 'string', { nullable: true }),
  ],
  primaryKey: { columns: ['id'] },
});
