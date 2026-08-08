/**
 * The emitted modules, read as text: SDL shapes, the scalar mapping table, the enum policy and
 * the table-shape rules. Execution against a real graphql is runtime.spec.ts; this file is
 * where a mapping decision failing names the exact line that moved.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GraphQLGenerator } from '../src';
import {
  activeUsers,
  analysis,
  auditLog,
  books,
  col,
  dailyTotals,
  events,
  memberships,
  metrics,
  table,
  tasks,
  users,
} from './fixtures';
import type { Table } from '@drzl/analyzer';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const workRoot = path.join(pkgRoot, 'test', 'tmp', 'sdl');

afterAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
});

let n = 0;
async function emit(tables: Table[], opts: Record<string, unknown> = {}) {
  const dir = path.join(workRoot, `case-${n++}`);
  await fs.rm(dir, { recursive: true, force: true });
  await new GraphQLGenerator(analysis(tables)).generate({
    outputDir: dir,
    format: { enabled: false },
    ...opts,
  } as never);
  return {
    read: (name: string) => fs.readFile(path.join(dir, name), 'utf8'),
    list: () => fs.readdir(dir),
  };
}

describe('the users module', () => {
  it('emits the object type with notNull as ! and the enum spelled verbatim', async () => {
    const { read } = await emit([users]);
    const src = await read('users.ts');
    expect(src).toContain('enum UsersRoleEnum {\n  admin\n  member\n}');
    expect(src).toContain(
      'type Users {\n  id: Int!\n  email: String!\n  bio: String\n  role: UsersRoleEnum!\n}'
    );
  });

  it('emits the insert input: required-no-default gets !, defaulted and nullable are omittable', async () => {
    const { read } = await emit([users]);
    const src = await read('users.ts');
    // id is generated and absent; email is required; bio is nullable (GraphQL cannot say
    // "present but nullable", the documented divergence from the DTO presence rule); role has
    // a default.
    expect(src).toContain(
      'input CreateUsersInput {\n  email: String!\n  bio: String\n  role: UsersRoleEnum\n}'
    );
  });

  it('emits the update input with every field optional and the primary key excluded', async () => {
    const { read } = await emit([users]);
    const src = await read('users.ts');
    expect(src).toContain(
      'input UpdateUsersInput {\n  email: String\n  bio: String\n  role: UsersRoleEnum\n}'
    );
    expect(src).not.toMatch(/input UpdateUsersInput \{[^}]*\bid\b/);
  });

  it('types the row and input interfaces with database values, not GraphQL names', async () => {
    const { read } = await emit([users]);
    const src = await read('users.ts');
    expect(src).toContain("role: 'admin' | 'member';");
    expect(src).toContain('bio?: string | null;');
  });

  it('emits no enum value map when every member is already a valid GraphQL name', async () => {
    const { read } = await emit([users]);
    expect(await read('users.ts')).not.toContain('UsersRoleEnum:');
  });
});

describe('the barrel', () => {
  it('composes Query with a list field and a byId field per keyed table', async () => {
    const { read } = await emit([users, memberships]);
    const src = await read('index.ts');
    expect(src).toContain('users: [Users!]!');
    expect(src).toContain('usersById(id: Int!): Users');
    // The composite key becomes a multi-argument field, every column named.
    expect(src).toContain('membershipsById(orgId: Int!, userId: Int!): Memberships');
  });

  it('composes Mutation with create, update and delete per writable keyed table', async () => {
    const { read } = await emit([users]);
    const src = await read('index.ts');
    expect(src).toContain('createUsers(input: CreateUsersInput!): Users!');
    expect(src).toContain('updateUsers(id: Int!, input: UpdateUsersInput!): Users!');
    expect(src).toContain('deleteUsers(id: Int!): Boolean!');
  });

  it('declares only the scalars the schema uses', async () => {
    const { read } = await emit([users]);
    const src = await read('index.ts');
    // users has no Date, bigint or json column, so no scalar is declared and none imported.
    expect(src).not.toContain('scalar DateTime');
    expect(src).not.toContain('scalar BigInt');
    expect(src).not.toContain('scalar JSON');

    const { read: read2 } = await emit([events, auditLog]);
    const src2 = await read2('index.ts');
    expect(src2).toContain('scalar DateTime');
    expect(src2).toContain('scalar BigInt');
    expect(src2).toContain('scalar JSON');
  });

  it('merges resolvers: Query spread, Mutation spread, scalars and enum maps by name', async () => {
    const { read } = await emit([users, events, tasks]);
    const src = await read('index.ts');
    expect(src).toContain('...usersResolvers.Query');
    expect(src).toContain('...usersResolvers.Mutation');
    expect(src).toContain('DateTime: DateTimeScalar');
    expect(src).toContain('BigInt: BigIntScalar');
    expect(src).toContain('TasksStatusEnum: tasksResolvers.TasksStatusEnum');
  });

  it('emits no Mutation type when every table is read-only', async () => {
    const { read } = await emit([activeUsers, dailyTotals]);
    const src = await read('index.ts');
    expect(src).not.toContain('type Mutation');
    expect(src).toContain('activeUsers: [ActiveUsers!]!');
    expect(src).toContain('activeUsersById(id: Int!): ActiveUsers');
    expect(src).toContain('dailyTotals: [DailyTotals!]!');
  });

  it('says so when there are no tables, instead of emitting an unbuildable schema', async () => {
    const { read } = await emit([]);
    const src = await read('index.ts');
    expect(src).toContain('No tables detected');
  });
});

describe('table shapes', () => {
  it('keyless: list and create only, no byId, no update, no delete', async () => {
    const { read } = await emit([auditLog]);
    const src = await read('index.ts');
    expect(src).toContain('auditLog: [AuditLog!]!');
    expect(src).not.toContain('auditLogById');
    expect(src).toContain('createAuditLog(input: CreateAuditLogInput!): AuditLog!');
    expect(src).not.toContain('updateAuditLog');
    expect(src).not.toContain('deleteAuditLog');
  });

  it('read-only: no mutations and no input types at all', async () => {
    const { read } = await emit([activeUsers]);
    const src = await read('activeUsers.ts');
    expect(src).not.toContain('input CreateActiveUsersInput');
    expect(src).not.toContain('input UpdateActiveUsersInput');
    expect(src).not.toContain('Mutation: {');
    expect(src).not.toContain('createActiveUsers');
    expect(src).not.toContain('deleteActiveUsers');
  });
});

describe('the scalar mapping table', () => {
  it('maps an unbounded integer to Float, because Int is a 32-bit commitment', async () => {
    // SQLite integers are 64-bit: an Int field would refuse values the database returns, at
    // serialize time, which is a read-path defect. Measured: graphql refuses 2^31 through Int
    // on all three paths.
    const { read } = await emit([metrics]);
    const src = await read('metrics.ts');
    expect(src).toContain('id: Float!');
    expect(src).toContain('big53: Float!');
    expect(src).toContain('ratio: Float!');
  });

  it('maps numeric-as-string to String without inventing precision, and uuid to ID', async () => {
    const { read } = await emit([metrics]);
    const src = await read('metrics.ts');
    expect(src).toContain('amount: String!');
    expect(src).toContain('ref: ID!');
    expect(src).toContain('day: String!');
  });

  it('maps Date to DateTime, bigint to BigInt, and an array to a list with nullable elements', async () => {
    const { read } = await emit([events]);
    const src = await read('events.ts');
    expect(src).toContain('at: DateTime!');
    expect(src).toContain('big: BigInt!');
    // Postgres arrays admit NULL elements whatever the column constraint says, and a null
    // element under [String!] nulls the whole field with an error (measured), so the element
    // stays nullable.
    expect(src).toContain('tags: [String]!');
    expect(src).toContain('point: [Float!]!');
  });

  it('maps a column the analyzer could not type to JSON, and says so', async () => {
    const { read } = await emit([auditLog]);
    const src = await read('auditLog.ts');
    expect(src).toContain('payload: JSON!');
    expect(src).toContain('DRZL could not derive');
  });
});

describe('the enum policy', () => {
  it('mangles unrepresentable members and carries the database spellings in a value map', async () => {
    const { read } = await emit([tasks]);
    const src = await read('tasks.ts');
    expect(src).toContain('"Database value: in-progress"');
    expect(src).toContain('IN_PROGRESS');
    expect(src).toContain('"Database value: 2fa"');
    expect(src).toContain('_2FA');
    // Verbatim member stays verbatim: no map entry for it.
    expect(src).toContain("IN_PROGRESS: 'in-progress'");
    expect(src).toContain("_2FA: '2fa'");
    expect(src).not.toContain("todo: 'todo'");
  });

  it('falls back to String when two members mangle onto one name, and says so', async () => {
    const { read } = await emit([tasks]);
    const src = await read('tasks.ts');
    expect(src).toContain('mood: String');
    expect(src).not.toContain('TasksMoodEnum');
    expect(src).toContain('a-b');
  });

  it('types the status argument as the database values, so a resolver author sees the truth', async () => {
    const { read } = await emit([tasks]);
    const src = await read('tasks.ts');
    expect(src).toContain("status: 'todo' | 'in-progress' | '2fa';");
  });
});

describe('a column name GraphQL cannot spell', () => {
  it('renames the field, maps output back to the row property, and documents the input side', async () => {
    const { read } = await emit([books]);
    const src = await read('books.ts');
    expect(src).toContain('cover_url: String');
    expect(src).toContain("parent['cover url']");
    // The row interface keeps the real property name.
    expect(src).toContain("'cover url': string | null;");
  });
});

describe('files and options', () => {
  it('writes one module per table, a scalars module and a barrel', async () => {
    const { list } = await emit([users, events]);
    expect((await list()).sort()).toEqual(['events.ts', 'index.ts', 'scalars.ts', 'users.ts']);
  });

  it('honours naming options for file names', async () => {
    const { list } = await emit([users], {
      naming: { routerSuffix: 'Gql', procedureCase: 'kebab' },
    });
    expect((await list()).sort()).toEqual(['index.ts', 'scalars.ts', 'users-gql.ts']);
  });

  it('refuses a table whose module would land on the barrel or the scalars module', async () => {
    const clash = table('scalars', { columns: [col('id', 'number')] });
    await expect(emit([clash])).rejects.toThrow(/scalars/);
  });

  it('spells relative imports with the configured extension', async () => {
    const { read } = await emit([users], { importExtension: 'none' });
    const src = await read('index.ts');
    expect(src).toContain("from './users'");
    expect(src).not.toContain("from './users.js'");
  });
});
