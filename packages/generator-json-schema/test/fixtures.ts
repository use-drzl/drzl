/**
 * Tables shared by the OpenAPI document specs.
 *
 * Every awkward key shape the document has to answer for is here, because the interesting
 * decisions are all about keys: a table with no primary key cannot be addressed at all, a
 * composite key needs more than one path segment, and a key that is not called `id` and is not a
 * number is the case the oRPC generator gets wrong.
 */
import type { Column, Table } from '@drzl/analyzer';

export const col = (name: string, over: Partial<Column> = {}): Column =>
  ({
    name,
    tsType: 'string',
    dbType: 'TEXT',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

export const serial = (name: string): Column =>
  col(name, {
    tsType: 'number',
    dbType: 'INTEGER',
    hasDefault: true,
    integer: true,
    min: '-2147483648',
    max: '2147483647',
  });

export const table = (over: Partial<Table> & { name: string }): Table =>
  ({
    tsName: over.name,
    columns: [],
    unique: [],
    indexes: [],
    checks: [],
    ...over,
  }) as Table;

/** `id serial primary key`, plus a required and a nullable column. */
export const users = (): Table =>
  table({
    name: 'users',
    columns: [serial('id'), col('email'), col('nickname', { nullable: true })],
    primaryKey: { columns: ['id'] },
    unique: [{ name: 'users_email_key', columns: ['email'] }],
  });

/** A child of `users`, so a relation has somewhere to point. */
export const posts = (): Table =>
  table({
    name: 'posts',
    columns: [
      serial('id'),
      col('authorId', { tsType: 'number', dbType: 'INTEGER', integer: true }),
      col('title'),
    ],
    primaryKey: { columns: ['id'] },
    foreignKeys: [{ columns: ['authorId'], foreignTable: 'users', foreignColumns: ['id'] }],
  });

/** A uuid key that is not called `id`, which is the case an invented `{ id: number }` gets wrong. */
export const sessions = (): Table =>
  table({
    name: 'sessions',
    columns: [col('token', { format: 'uuid' }), col('ip', { nullable: true })],
    primaryKey: { columns: ['token'] },
  });

/** Two columns address one row. */
export const orgMembers = (): Table =>
  table({
    name: 'org_members',
    tsName: 'orgMembers',
    columns: [
      col('orgId', { tsType: 'number', dbType: 'INTEGER', integer: true }),
      col('userId', { tsType: 'number', dbType: 'INTEGER', integer: true }),
      col('role'),
    ],
    primaryKey: { columns: ['orgId', 'userId'] },
  });

/** Nothing addresses one row of this. */
export const events = (): Table =>
  table({ name: 'events', columns: [col('kind'), col('payload', { nullable: true })] });

/** A materialized view: the database refuses every write. */
export const activeUsers = (): Table =>
  table({
    name: 'active_users',
    tsName: 'activeUsers',
    columns: [serial('id'), col('email')],
    primaryKey: { columns: ['id'] },
    readOnly: true,
  });
