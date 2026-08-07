/**
 * The nested payload plan, which decides what all four generators emit.
 *
 * Nothing here renders anything. It pins the four decisions that are the whole design: which
 * relation kinds appear in which mode, which of the child's columns the parent supplies, what a
 * cycle does, and what happens when the relation does not say enough to answer the second question.
 */
import { describe, expect, it } from 'vitest';
import type { Relation, Table } from '@drzl/analyzer';
import {
  buildNestedPlan,
  DEFAULT_NESTED_DEPTH,
  MAX_NESTED_DEPTH,
  nestedArmNotes,
  nestedNodeColumns,
  nestedSchemaName,
  nestedTypeName,
  resolveAffix,
  resolveNestedDepth,
} from '../src/index';

const col = (name: string, over: Record<string, unknown> = {}) =>
  ({
    name,
    tsType: 'string',
    dbType: 'TEXT',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
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

const users = table('users', 'users', ['id', 'name']);
const posts = table('posts', 'posts', ['id', 'authorId', 'title'], {
  foreignKeys: [{ columns: ['authorId'], foreignTable: 'users', foreignColumns: ['id'] }],
});
const comments = table('comments', 'comments', ['id', 'postId', 'body'], {
  foreignKeys: [{ columns: ['postId'], foreignTable: 'posts', foreignColumns: ['id'] }],
});

/** Exactly what the analyzer emits for those three tables from their foreign keys alone. */
const REL: Relation[] = [
  { kind: 'one', from: 'posts', to: 'users' },
  { kind: 'many', from: 'users', to: 'posts' },
  { kind: 'one', from: 'comments', to: 'posts' },
  { kind: 'many', from: 'posts', to: 'comments' },
];

const TABLES = [users, posts, comments];

describe('which relations a nested payload carries', () => {
  it('puts the children on an insert and omits the foreign key they cannot know', () => {
    const plan = buildNestedPlan(users, TABLES, REL, 'insert', 1)!;
    expect(plan.arms.map((a) => a.key)).toEqual(['posts']);
    expect(plan.arms[0].single).toBe(false);
    // The whole point: `authorId` does not exist until the user is inserted.
    expect(plan.arms[0].child.omitted).toEqual(['authorId']);
  });

  it('leaves a `one` relation off an insert entirely', () => {
    // posts -> users is a `one`, and the foreign key for it sits on the post rather than on the
    // user, so admitting the arm would mean weakening the post's own contract.
    const plan = buildNestedPlan(posts, TABLES, REL, 'insert', 1)!;
    expect(plan.arms.map((a) => a.key)).toEqual(['comments']);
    expect(plan.arms.some((a) => a.kind === 'one')).toBe(false);
  });

  it('carries a `one` relation on a select, where the row really comes back', () => {
    const plan = buildNestedPlan(posts, TABLES, REL, 'select', 1)!;
    const kinds = Object.fromEntries(plan.arms.map((a) => [a.key, a.kind]));
    expect(kinds).toEqual({ comments: 'many', users: 'one' });
    expect(plan.arms.find((a) => a.key === 'users')!.single).toBe(true);
    // Nothing is omitted on a read: every column of the row is returned.
    for (const arm of plan.arms) expect(arm.child.omitted).toEqual([]);
  });

  it('emits nothing at all for a table with no relations', () => {
    const lonely = table('logs', 'logs', ['id']);
    expect(buildNestedPlan(lonely, [lonely], [], 'insert', 1)).toBeUndefined();
  });
});

describe('depth', () => {
  it('stops at the configured level', () => {
    const one = buildNestedPlan(users, TABLES, REL, 'insert', 1)!;
    expect(one.arms[0].child.arms).toEqual([]);

    const two = buildNestedPlan(users, TABLES, REL, 'insert', 2)!;
    expect(two.arms[0].child.arms.map((a) => a.key)).toEqual(['comments']);
    expect(two.arms[0].child.arms[0].child.omitted).toEqual(['postId']);
  });

  it('terminates a cycle by running out of depth rather than by detecting it', () => {
    // A self-referencing table is the cycle that really occurs: `users.managerId -> users`.
    const selfy = table('users', 'users', ['id', 'managerId', 'name'], {
      foreignKeys: [{ columns: ['managerId'], foreignTable: 'users', foreignColumns: ['id'] }],
    });
    const rels: Relation[] = [
      { kind: 'one', from: 'users', to: 'users' },
      { kind: 'many', from: 'users', to: 'users' },
    ];
    const plan = buildNestedPlan(selfy, [selfy], rels, 'insert', MAX_NESTED_DEPTH)!;
    let node = plan;
    let levels = 0;
    while (node.arms.length) {
      expect(node.arms).toHaveLength(1);
      node = node.arms[0].child;
      expect(node.omitted).toEqual(['managerId']);
      levels++;
      // A guard rather than an assertion: an unbounded plan would hang the suite instead of
      // failing it.
      if (levels > 20) break;
    }
    expect(levels).toBe(MAX_NESTED_DEPTH);
  });

  it('clamps a configured depth into the range it will honour', () => {
    expect(resolveNestedDepth(undefined)).toBe(DEFAULT_NESTED_DEPTH);
    expect(resolveNestedDepth(2)).toBe(2);
    expect(resolveNestedDepth(0)).toBe(1);
    expect(resolveNestedDepth(-4)).toBe(1);
    expect(resolveNestedDepth(99)).toBe(MAX_NESTED_DEPTH);
    expect(resolveNestedDepth(Number.NaN)).toBe(DEFAULT_NESTED_DEPTH);
    const said: string[] = [];
    resolveNestedDepth(99, (m) => said.push(m));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('nestedDepth');
  });
});

describe('when the relation does not say enough', () => {
  it('omits nothing where a child has two foreign keys to the same parent, and says why', () => {
    const messages = table('messages', 'messages', ['id', 'senderId', 'recipientId', 'body'], {
      foreignKeys: [
        { columns: ['senderId'], foreignTable: 'users', foreignColumns: ['id'] },
        { columns: ['recipientId'], foreignTable: 'users', foreignColumns: ['id'] },
      ],
    });
    const rels: Relation[] = [{ kind: 'many', from: 'users', to: 'messages' }];
    const plan = buildNestedPlan(users, [users, messages], rels, 'insert', 1)!;
    expect(plan.arms[0].child.omitted).toEqual([]);
    expect(plan.arms[0].note).toContain('senderId');
    expect(plan.arms[0].note).toContain('recipientId');
    expect(nestedArmNotes(plan.arms[0])).toHaveLength(1);
  });

  it('omits nothing where the relation has no foreign key behind it', () => {
    // What `relations()` with no `references`, and the name-matching heuristic, produce.
    const loose = table('notes', 'notes', ['id', 'body']);
    const rels: Relation[] = [{ kind: 'many', from: 'users', to: 'notes' }];
    const plan = buildNestedPlan(users, [users, loose], rels, 'insert', 1)!;
    expect(plan.arms[0].child.omitted).toEqual([]);
    expect(plan.arms[0].note).toBeUndefined();
  });

  it('drops a relation whose key would overwrite a column of the same name', () => {
    const owner = table('owner', 'owner', ['id', 'posts']);
    const rels: Relation[] = [{ kind: 'many', from: 'owner', to: 'posts' }];
    expect(buildNestedPlan(owner, [owner, posts], rels, 'insert', 1)).toBeUndefined();
  });

  it('keeps one arm per key when a pair of tables is linked both ways', () => {
    const rels: Relation[] = [
      { kind: 'one', from: 'users', to: 'posts' },
      { kind: 'many', from: 'users', to: 'posts' },
    ];
    const plan = buildNestedPlan(users, TABLES, rels, 'select', 1)!;
    expect(plan.arms).toHaveLength(1);
    // `many` wins, so the arm that can hold every related row is the one kept.
    expect(plan.arms[0].kind).toBe('many');
  });
});

describe('many-to-many', () => {
  const tags = table('tags', 'tags', ['id', 'label']);
  const rels: Relation[] = [
    { kind: 'manyToMany', from: 'users', to: 'tags', via: 'users_tags' },
    { kind: 'manyToMany', from: 'tags', to: 'users', via: 'users_tags' },
  ];

  it('carries the far side and omits nothing, since the join row holds both keys', () => {
    const plan = buildNestedPlan(users, [users, tags], rels, 'insert', 1)!;
    expect(plan.arms.map((a) => [a.key, a.kind, a.single])).toEqual([
      ['tags', 'manyToMany', false],
    ]);
    expect(plan.arms[0].child.omitted).toEqual([]);
  });

  it('names the join table in the comment, since the shape cannot', () => {
    const plan = buildNestedPlan(users, [users, tags], rels, 'insert', 1)!;
    expect(nestedArmNotes(plan.arms[0])[0]).toContain('users_tags');
  });
});

describe('naming', () => {
  it('prefixes the resolved name so affixes keep applying underneath', () => {
    const plain = resolveAffix();
    expect(nestedSchemaName('insert', 'users', plain)).toBe('NestedInsertusersSchema');
    expect(nestedSchemaName('select', 'users', plain)).toBe('NestedSelectusersSchema');
    expect(nestedTypeName('insert', 'users', plain)).toBe('NestedInsertusersInput');
    expect(nestedTypeName('select', 'users', plain)).toBe('NestedSelectusersOutput');

    const affixed = resolveAffix({ affix: { tableCase: 'pascal', schema: { suffix: 'Zod' } } });
    expect(nestedSchemaName('insert', 'users', affixed)).toBe('NestedInsertUsersZod');
  });
});

describe('nestedNodeColumns', () => {
  it('drops exactly what the node omits and nothing else', () => {
    const node = { table: posts, omitted: ['authorId'], arms: [] };
    const kept = nestedNodeColumns(posts.columns, node);
    expect(kept.map((c) => c.name)).toEqual(['id', 'title']);
    expect(nestedNodeColumns(posts.columns, { ...node, omitted: [] })).toHaveLength(3);
  });
});
