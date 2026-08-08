/**
 * The brand plan: which column carries which brand token, and what a token is called.
 *
 * A brand is a type-level marker and nothing else, so none of this can be checked by parsing a
 * value. What *can* be checked here is the decision: a plan that hands `posts.authorId` the wrong
 * token emits a schema whose types are confidently wrong, and that is a defect no runtime test in
 * the repository could see.
 */
import { describe, it, expect } from 'vitest';
import { buildBrandPlan, resolveBranding } from '../src/branding.js';
import type { Column, Table } from '@drzl/analyzer';

const col = (name: string, over: Partial<Column> = {}): Column =>
  ({
    name,
    tsType: 'number',
    dbType: 'INTEGER',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

const table = (tsName: string, over: Partial<Table> = {}): Table =>
  ({
    name: tsName,
    tsName,
    columns: [],
    unique: [],
    indexes: [],
    checks: [],
    ...over,
  }) as Table;

/** users(id PK), posts(id PK, authorId -> users.id) */
function usersAndPosts(over: { authorNullable?: boolean } = {}): Table[] {
  return [
    table('users', {
      columns: [col('id'), col('email', { tsType: 'string', dbType: 'TEXT' })],
      primaryKey: { columns: ['id'] },
    }),
    table('posts', {
      columns: [
        col('id'),
        col('authorId', {
          nullable: !!over.authorNullable,
          references: { table: 'users', column: 'id' },
        }),
      ],
      primaryKey: { columns: ['id'] },
      foreignKeys: [{ columns: ['authorId'], foreignTable: 'users', foreignColumns: ['id'] }],
    }),
  ];
}

describe('resolveBranding', () => {
  it('is off unless asked for', () => {
    expect(resolveBranding(undefined)).toBeUndefined();
    expect(resolveBranding(false)).toBeUndefined();
    expect(resolveBranding({ enabled: false })).toBeUndefined();
  });

  it('brands foreign keys by default, since that is where the value is', () => {
    expect(resolveBranding(true)).toEqual({ foreignKeys: true, aliases: true });
    expect(resolveBranding({})).toEqual({ foreignKeys: true, aliases: true });
    expect(resolveBranding({ foreignKeys: false })).toEqual({ foreignKeys: false, aliases: true });
    expect(resolveBranding({ aliases: false })).toEqual({ foreignKeys: true, aliases: false });
  });
});

describe('what carries a brand', () => {
  it('brands a single-column primary key with its own token', () => {
    const plan = buildBrandPlan(usersAndPosts(), true)!;
    expect(plan.brandOf('users', 'id')).toBe('users.id');
    expect(plan.brandOf('posts', 'id')).toBe('posts.id');
  });

  it('leaves an ordinary column alone', () => {
    const plan = buildBrandPlan(usersAndPosts(), true)!;
    expect(plan.brandOf('users', 'email')).toBeUndefined();
  });

  it('gives a foreign key the token of the column it references', () => {
    const plan = buildBrandPlan(usersAndPosts(), true)!;
    expect(plan.brandOf('posts', 'authorId')).toBe('users.id');
  });

  it('brands a nullable foreign key the same way', () => {
    const plan = buildBrandPlan(usersAndPosts({ authorNullable: true }), true)!;
    expect(plan.brandOf('posts', 'authorId')).toBe('users.id');
  });

  it('leaves foreign keys alone when they are turned off', () => {
    const plan = buildBrandPlan(usersAndPosts(), { foreignKeys: false })!;
    expect(plan.brandOf('posts', 'authorId')).toBeUndefined();
    expect(plan.brandOf('users', 'id')).toBe('users.id');
  });

  it('brands every column of a composite primary key separately', () => {
    const plan = buildBrandPlan(
      [
        table('orgMembers', {
          columns: [col('orgId'), col('userId')],
          primaryKey: { columns: ['orgId', 'userId'] },
        }),
      ],
      true
    )!;
    expect(plan.brandOf('orgMembers', 'orgId')).toBe('orgMembers.orgId');
    expect(plan.brandOf('orgMembers', 'userId')).toBe('orgMembers.userId');
  });

  it('lets a foreign key win over a column being its own primary key', () => {
    // A join table keyed on two foreign keys holds an org's id and a user's id, not two ids of
    // its own. Branding them after the table they are declared on would make `orgMembers.userId`
    // a type nothing else in the schema produces.
    const plan = buildBrandPlan(
      [
        table('orgs', { columns: [col('id')], primaryKey: { columns: ['id'] } }),
        table('users', { columns: [col('id')], primaryKey: { columns: ['id'] } }),
        table('orgMembers', {
          columns: [
            col('orgId', { references: { table: 'orgs', column: 'id' } }),
            col('userId', { references: { table: 'users', column: 'id' } }),
          ],
          primaryKey: { columns: ['orgId', 'userId'] },
          foreignKeys: [
            { columns: ['orgId'], foreignTable: 'orgs', foreignColumns: ['id'] },
            { columns: ['userId'], foreignTable: 'users', foreignColumns: ['id'] },
          ],
        }),
      ],
      true
    )!;
    expect(plan.brandOf('orgMembers', 'orgId')).toBe('orgs.id');
    expect(plan.brandOf('orgMembers', 'userId')).toBe('users.id');
  });

  it('follows a chain of references to the key it ends at', () => {
    const plan = buildBrandPlan(
      [
        table('users', { columns: [col('id')], primaryKey: { columns: ['id'] } }),
        table('posts', {
          columns: [col('id'), col('authorId', { references: { table: 'users', column: 'id' } })],
          primaryKey: { columns: ['id'] },
        }),
        table('flags', {
          // References the *foreign key* column of posts, which is itself a users.id.
          columns: [col('writerId', { references: { table: 'posts', column: 'authorId' } })],
        }),
      ],
      true
    )!;
    expect(plan.brandOf('flags', 'writerId')).toBe('users.id');
  });

  it('resolves a self reference to the table own key', () => {
    const plan = buildBrandPlan(
      [
        table('users', {
          columns: [
            col('id'),
            col('managerId', { nullable: true, references: { table: 'users', column: 'id' } }),
          ],
          primaryKey: { columns: ['id'] },
        }),
      ],
      true
    )!;
    expect(plan.brandOf('users', 'managerId')).toBe('users.id');
  });

  it('withholds a brand rather than guessing when references form a cycle', () => {
    const plan = buildBrandPlan(
      [
        table('a', {
          columns: [col('bId', { references: { table: 'b', column: 'aId' } })],
        }),
        table('b', {
          columns: [col('aId', { references: { table: 'a', column: 'bId' } })],
        }),
      ],
      true
    )!;
    expect(plan.brandOf('a', 'bId')).toBeUndefined();
    expect(plan.brandOf('b', 'aId')).toBeUndefined();
  });

  it('withholds a brand when the reference points at nothing', () => {
    const plan = buildBrandPlan(
      [
        table('posts', {
          columns: [col('authorId', { references: { table: 'users', column: 'id' } })],
        }),
      ],
      true
    )!;
    expect(plan.brandOf('posts', 'authorId')).toBeUndefined();
  });

  it('withholds a brand when the reference lands on a column that is not a key', () => {
    const plan = buildBrandPlan(
      [
        table('users', {
          columns: [col('id'), col('email', { tsType: 'string', dbType: 'TEXT' })],
          primaryKey: { columns: ['id'] },
          unique: [{ columns: ['email'] }],
        }),
        table('subs', {
          columns: [
            col('userEmail', {
              tsType: 'string',
              dbType: 'TEXT',
              references: { table: 'users', column: 'email' },
            }),
          ],
        }),
      ],
      true
    )!;
    expect(plan.brandOf('subs', 'userEmail')).toBeUndefined();
  });

  it('withholds a brand when the two ends of the reference are different types', () => {
    const plan = buildBrandPlan(
      [
        table('users', {
          columns: [col('id', { tsType: 'string', dbType: 'TEXT' })],
          primaryKey: { columns: ['id'] },
        }),
        table('posts', {
          columns: [col('authorId', { references: { table: 'users', column: 'id' } })],
        }),
      ],
      true
    )!;
    expect(plan.brandOf('posts', 'authorId')).toBeUndefined();
  });

  it('withholds a brand for an array column', () => {
    const plan = buildBrandPlan(
      [
        table('users', { columns: [col('id')], primaryKey: { columns: ['id'] } }),
        table('posts', {
          columns: [
            col('authorIds', { arrayDimensions: 1, references: { table: 'users', column: 'id' } }),
          ],
        }),
      ],
      true
    )!;
    expect(plan.brandOf('posts', 'authorIds')).toBeUndefined();
  });

  it('resolves a composite foreign key column by column', () => {
    const plan = buildBrandPlan(
      [
        table('orgs', {
          columns: [col('tenantId'), col('slug', { tsType: 'string', dbType: 'TEXT' })],
          primaryKey: { columns: ['tenantId', 'slug'] },
        }),
        table('teams', {
          columns: [col('tenantId'), col('orgSlug', { tsType: 'string', dbType: 'TEXT' })],
          foreignKeys: [
            {
              columns: ['tenantId', 'orgSlug'],
              foreignTable: 'orgs',
              foreignColumns: ['tenantId', 'slug'],
            },
          ],
        }),
      ],
      true
    )!;
    expect(plan.brandOf('teams', 'tenantId')).toBe('orgs.tenantId');
    expect(plan.brandOf('teams', 'orgSlug')).toBe('orgs.slug');
  });

  it('resolves a reference by the SQL table name, not the export name', () => {
    const plan = buildBrandPlan(
      [
        {
          ...table('userTable'),
          name: 'users',
          columns: [col('id')],
          primaryKey: { columns: ['id'] },
        } as Table,
        table('posts', {
          columns: [col('authorId', { references: { table: 'users', column: 'id' } })],
        }),
      ],
      true
    )!;
    expect(plan.brandOf('posts', 'authorId')).toBe('userTable.id');
  });

  it('withholds a brand when two tables share one SQL name', () => {
    const plan = buildBrandPlan(
      [
        {
          ...table('pubUsers'),
          name: 'users',
          columns: [col('id')],
          primaryKey: { columns: ['id'] },
        } as Table,
        {
          ...table('audUsers'),
          name: 'users',
          columns: [col('id')],
          primaryKey: { columns: ['id'] },
        } as Table,
        table('posts', {
          columns: [col('authorId', { references: { table: 'users', column: 'id' } })],
        }),
      ],
      true
    )!;
    expect(plan.brandOf('posts', 'authorId')).toBeUndefined();
    // The two tables still brand their own keys: only the reference is ambiguous.
    expect(plan.brandOf('pubUsers', 'id')).toBe('pubUsers.id');
  });
});

describe('the exported alias', () => {
  it('names the owning table and column', () => {
    const plan = buildBrandPlan(usersAndPosts(), true)!;
    expect(plan.aliasesFor('users')).toEqual([
      { alias: 'UsersId', column: 'id', token: 'users.id' },
    ]);
    expect(plan.aliasesFor('posts')).toEqual([
      { alias: 'PostsId', column: 'id', token: 'posts.id' },
    ]);
  });

  it('is not emitted for a column whose brand belongs to another table', () => {
    const plan = buildBrandPlan(
      [
        table('users', { columns: [col('id')], primaryKey: { columns: ['id'] } }),
        table('profiles', {
          columns: [col('userId', { references: { table: 'users', column: 'id' } })],
          primaryKey: { columns: ['userId'] },
        }),
      ],
      true
    )!;
    expect(plan.aliasesFor('profiles')).toEqual([]);
  });

  it('drops both aliases when two tables transform to the same identifier, and says so', () => {
    const plan = buildBrandPlan(
      [
        table('user_accounts', { columns: [col('id')], primaryKey: { columns: ['id'] } }),
        table('userAccounts', { columns: [col('id')], primaryKey: { columns: ['id'] } }),
        table('posts', { columns: [col('id')], primaryKey: { columns: ['id'] } }),
      ],
      true
    )!;
    expect(plan.aliasesFor('user_accounts')).toEqual([]);
    expect(plan.aliasesFor('userAccounts')).toEqual([]);
    // The brands themselves are untouched: they are built from the export name verbatim, which
    // is what makes the collision an alias problem rather than a correctness one.
    expect(plan.brandOf('user_accounts', 'id')).toBe('user_accounts.id');
    expect(plan.brandOf('userAccounts', 'id')).toBe('userAccounts.id');
    expect(plan.notes.join(' ')).toContain('UserAccountsId');
    // A table that did not collide keeps its alias.
    expect(plan.aliasesFor('posts')).toHaveLength(1);
  });

  it('can be turned off without turning off the brands', () => {
    const plan = buildBrandPlan(usersAndPosts(), { aliases: false })!;
    expect(plan.aliasesFor('users')).toEqual([]);
    expect(plan.brandOf('users', 'id')).toBe('users.id');
  });
});
