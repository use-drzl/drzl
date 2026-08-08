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

/** An `integer` column whose declared bounds prove it fits GraphQL's 32-bit Int. */
export function int32(name: string, over: Partial<Column> = {}): Column {
  return col(name, 'number', {
    dbType: 'INTEGER',
    integer: true,
    min: '-2147483648',
    max: '2147483647',
    ...over,
  });
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
 * `role` is an enum column whose members are all valid GraphQL enum names, so it keeps its
 * database spellings verbatim and needs no value map; the mangled family lives on `tasks`.
 * `bio` is the nullable no-default column the input-nullability rule is measured on.
 */
export const users = table('users', {
  columns: [
    int32('id', { hasDefault: true, isGenerated: true }),
    col('email', 'string'),
    col('bio', 'string', { nullable: true }),
    col('role', 'string', { enumValues: ['admin', 'member'], hasDefault: true }),
  ],
  primaryKey: { columns: ['id'] },
});

/** A single-column foreign key, riding along so multi-table emission is exercised. */
export const posts = table('posts', {
  columns: [
    int32('id', { hasDefault: true, isGenerated: true }),
    int32('authorId'),
    col('title', 'string'),
  ],
  primaryKey: { columns: ['id'] },
  foreignKeys: [{ columns: ['authorId'], foreignTable: 'users', foreignColumns: ['id'] }],
});

/**
 * A natural, non-numeric primary key, plus a column whose name is not a GraphQL Name.
 * GraphQL has no quoted-field escape hatch, so `cover url` has to be renamed on the GraphQL
 * side and mapped back to the row property by an emitted field resolver.
 */
export const books = table('books', {
  columns: [
    col('isbn', 'string'),
    col('title', 'string'),
    col('cover url', 'string', { nullable: true }),
  ],
  primaryKey: { columns: ['isbn'] },
});

/** A composite primary key, addressed by a multi-argument query field. */
export const memberships = table('memberships', {
  columns: [int32('orgId'), int32('userId'), col('role', 'string')],
  primaryKey: { columns: ['orgId', 'userId'] },
});

/**
 * No primary key at all, so no byId field and no update or delete mutation; `payload` has a
 * type the analyzer could not narrow, so it maps to the JSON scalar with the wide note.
 */
export const auditLog = table('audit_log', {
  tsName: 'auditLog',
  columns: [col('at', 'string'), col('what', 'string'), col('payload', 'JsonValue')],
});

/** A materialized view: readable, and refuses every write, so no mutations and no inputs. */
export const activeUsers = table('active_users', {
  tsName: 'activeUsers',
  columns: [int32('id'), col('email', 'string')],
  primaryKey: { columns: ['id'] },
  readOnly: true,
});

/** Read-only *and* keyless: a list query field and the object type, nothing else. */
export const dailyTotals = table('daily_totals', {
  tsName: 'dailyTotals',
  columns: [col('day', 'string'), col('total', 'number')],
  readOnly: true,
});

/**
 * The column kinds with wire-shape decisions of their own, in one row: a `Date` crossing as
 * the DateTime scalar, a `bigint` crossing as the BigInt digits scalar, a text array (a GraphQL
 * list with nullable elements, because Postgres arrays admit NULL elements), a `point` tuple,
 * a boolean, and a nullable column. A fixture family without these is how 13 defects shipped
 * once.
 */
export const events = table('events', {
  columns: [
    int32('id', { hasDefault: true, isGenerated: true }),
    col('at', 'Date'),
    col('flag', 'boolean'),
    col('big', 'bigint'),
    col('tags', 'string', { dbType: 'TEXT', arrayDimensions: 1 }),
    col('point', '[number, number]', { shape: { kind: 'tuple', length: 2 } }),
    col('note', 'string', { nullable: true }),
  ],
  primaryKey: { columns: ['id'] },
});

/**
 * The enum landmine, both halves.
 *
 * `status` holds members GraphQL cannot name (`in-progress` is a syntax error in SDL, `2fa`
 * lexes as a malformed number, measured on graphql 16.14.2 and 17.0.2), so they are mangled
 * and a value map carries the database spellings. `mood` mangles two different values onto one
 * name, which no map can represent, so the column falls back to String with a note.
 */
export const tasks = table('tasks', {
  columns: [
    int32('id', { hasDefault: true, isGenerated: true }),
    col('status', 'string', { enumValues: ['todo', 'in-progress', '2fa'] }),
    col('mood', 'string', { enumValues: ['a-b', 'a b'], nullable: true }),
  ],
  primaryKey: { columns: ['id'] },
});

/**
 * The numeric spread: an unbounded `integer` (SQLite's is 64-bit, so Int would refuse values
 * the database returns), a 53-bit `bigint { mode: 'number' }`, a `real`, a `numeric` in string
 * mode (the wire is a string; no precision is invented), a `uuid` and a `date` in string mode.
 */
export const metrics = table('metrics', {
  columns: [
    col('id', 'number', { dbType: 'INTEGER' }),
    col('big53', 'number', {
      dbType: 'BIGINT',
      integer: true,
      min: '-9007199254740991',
      max: '9007199254740991',
    }),
    col('ratio', 'number', { dbType: 'REAL' }),
    col('amount', 'string', { dbType: 'NUMERIC', format: 'numeric' }),
    col('ref', 'string', { dbType: 'UUID', format: 'uuid' }),
    col('day', 'string', { dbType: 'DATE' }),
  ],
  primaryKey: { columns: ['id'] },
});
