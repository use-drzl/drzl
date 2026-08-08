/**
 * The nested plan when two schemas hold a table of the same name.
 *
 * Two things here were keyed on the bare database name and cannot be: the map from a relation's
 * `to` back to a table, which silently kept whichever of the two it saw last, and the search for
 * the child's foreign keys back to the parent, which matched a key pointing at `reporting.users`
 * against `public.users` and omitted a column from the wrong schema's payload.
 *
 * Nothing here changes for a schema that names no schema: a qualified name for a table with no
 * schema is its own name, so every existing plan is byte for byte what it was.
 */
import { describe, expect, it } from 'vitest';
import type { Relation, Table } from '@drzl/analyzer';
import { buildNestedPlan } from '../src/index';

const col = (name: string) =>
  ({
    name,
    tsType: 'string',
    dbType: 'TEXT',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
  }) as never;

const table = (name: string, tsName: string, cols: string[], over: Partial<Table> = {}): Table =>
  ({
    name,
    tsName,
    columns: cols.map((c) => col(c)),
    unique: [],
    indexes: [],
    checks: [],
    ...over,
  }) as Table;

const publicUsers = table('users', 'users', ['id', 'email']);
const reportingUsers = table('users', 'reportingUsers', ['id', 'label'], {
  schema: 'reporting',
});

/** A child of `reporting.users`, in the same schema. */
const reportingNotes = table('notes', 'reportingNotes', ['id', 'userId', 'body'], {
  schema: 'reporting',
  foreignKeys: [
    {
      columns: ['userId'],
      foreignTable: 'users',
      foreignSchema: 'reporting',
      foreignColumns: ['id'],
    },
  ],
});

/** A child of `public.users`. */
const publicPosts = table('posts', 'posts', ['id', 'authorId', 'title'], {
  foreignKeys: [{ columns: ['authorId'], foreignTable: 'users', foreignColumns: ['id'] }],
});

const TABLES = [publicUsers, reportingUsers, reportingNotes, publicPosts];

/** Exactly what the analyzer now emits for those four, from their foreign keys alone. */
const REL: Relation[] = [
  { kind: 'one', from: 'reporting.notes', to: 'reporting.users' },
  { kind: 'many', from: 'reporting.users', to: 'reporting.notes' },
  { kind: 'one', from: 'posts', to: 'users' },
  { kind: 'many', from: 'users', to: 'posts' },
];

describe('a table resolved from a relation', () => {
  it('is the one in the relation two schemas apart, not whichever came last', () => {
    const plan = buildNestedPlan(reportingUsers, TABLES, REL, 'insert', 1)!;
    expect(plan.arms.map((a) => a.key)).toEqual(['reportingNotes']);
  });

  it('leaves the table in the default schema with its own child only', () => {
    const plan = buildNestedPlan(publicUsers, TABLES, REL, 'insert', 1)!;
    expect(plan.arms.map((a) => a.key)).toEqual(['posts']);
  });
});

describe('the column a nested insert omits', () => {
  it('comes from a foreign key that names the parent schema too', () => {
    const plan = buildNestedPlan(reportingUsers, TABLES, REL, 'insert', 1)!;
    expect(plan.arms[0].child.omitted).toEqual(['userId']);
  });

  it('is not taken from a key pointing at a same-named table in another schema', () => {
    // `publicPosts.authorId` points at `public.users`. Asked for `reporting.users`'s payload, the
    // old bare-name match would have claimed it.
    const plan = buildNestedPlan(publicUsers, TABLES, REL, 'insert', 1)!;
    expect(plan.arms[0].child.omitted).toEqual(['authorId']);
  });
});
