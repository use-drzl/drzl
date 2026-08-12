/**
 * Row-level security policies, against real drizzle-orm.
 *
 * A policy names no columns, so it fell through the extra-config traversal's `cols.length` guard
 * and was dropped. That was silent and harmless, and it is why nothing in DRZL could say a word
 * about row-level security. These tests pin the three things a reader of a security rule cannot
 * afford to have guessed at: who it applies to, which of its two expressions are present, and
 * whether the table has any policies at all.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer } from '../src/index';

const dir = path.resolve(__dirname, 'fixtures');

async function analyzeSource(name: string, source: string) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.mjs`);
  await fs.writeFile(file, source, 'utf8');
  return new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({});
}

const TABLE_WITH_POLICIES = `
  import { pgTable, serial, integer, pgPolicy, pgRole } from 'drizzle-orm/pg-core';
  import { sql } from 'drizzle-orm';
  export const admin = pgRole('admin');
  export const posts = pgTable('posts', {
    id: serial('id').primaryKey(),
    ownerId: integer('owner_id').notNull(),
  }, (t) => [
    pgPolicy('owner_reads', { for: 'select', to: 'authenticated', using: sql\`\${t.ownerId} = 1\` }),
    pgPolicy('owner_writes', {
      as: 'permissive',
      for: 'update',
      to: ['authenticated', admin],
      using: sql\`\${t.ownerId} = 1\`,
      withCheck: sql\`\${t.ownerId} = 1\`,
    }),
    pgPolicy('anyone_inserts', { for: 'insert' }),
  ]);
`;

describe('policies declared in the table', () => {
  it('finds every policy, in declaration order', async () => {
    const a = await analyzeSource('policies-basic', TABLE_WITH_POLICIES);
    const posts = a.tables.find((t) => t.name === 'posts');
    expect(posts?.policies?.map((p) => p.name)).toEqual([
      'owner_reads',
      'owner_writes',
      'anyone_inserts',
    ]);
  });

  it('carries `as` and `for` as declared, and leaves out what was not declared', async () => {
    const a = await analyzeSource('policies-basic', TABLE_WITH_POLICIES);
    const posts = a.tables.find((t) => t.name === 'posts');
    const reads = posts?.policies?.find((p) => p.name === 'owner_reads');
    const writes = posts?.policies?.find((p) => p.name === 'owner_writes');
    expect(reads?.for).toBe('select');
    expect(reads?.as).toBeUndefined();
    expect(writes?.as).toBe('permissive');
    expect(writes?.for).toBe('update');
  });

  /**
   * The canary for the mistake this shape invites.
   *
   * A `PgPolicy` carries `as`, `for`, `to`, `using` and `withCheck` as own keys whatever the
   * declaration said, with the omitted ones set to `undefined`. So `'withCheck' in policy` is true
   * for every policy ever written, and a report keying on it would say each one constrains its
   * writes. `anyone_inserts` is exactly the policy that mistake would misreport, and it is the one
   * the CLI's headline finding is built to catch.
   */
  it('reports an absent withCheck as absent, not as present-and-empty', async () => {
    const a = await analyzeSource('policies-basic', TABLE_WITH_POLICIES);
    const posts = a.tables.find((t) => t.name === 'posts');
    const inserts = posts?.policies?.find((p) => p.name === 'anyone_inserts');
    expect(inserts).toBeDefined();
    expect(inserts?.withCheck).toBeUndefined();
    expect(inserts?.using).toBeUndefined();
    // `in` rather than a value check, and that is the whole point: on the Drizzle object both keys
    // are present and undefined, so only key absence distinguishes what this analyzer reports from
    // what it read.
    expect('withCheck' in inserts!).toBe(false);
    expect('using' in inserts!).toBe(false);
  });

  it('normalises `to` to role names, whether a string, a role or a list of both', async () => {
    const a = await analyzeSource('policies-basic', TABLE_WITH_POLICIES);
    const posts = a.tables.find((t) => t.name === 'posts');
    // A bare string.
    expect(posts?.policies?.find((p) => p.name === 'owner_reads')?.to).toEqual(['authenticated']);
    // An array mixing a string with a pgRole object, which stringifies to [object Object] if the
    // list is read as written.
    expect(posts?.policies?.find((p) => p.name === 'owner_writes')?.to).toEqual([
      'authenticated',
      'admin',
    ]);
    // Absent where the declaration did not say, rather than an empty list that reads as "no roles".
    expect(posts?.policies?.find((p) => p.name === 'anyone_inserts')?.to).toBeUndefined();
  });

  it('names a role once when both spellings of it are given', async () => {
    // `to: ['authenticated', pgRole('authenticated')]` is one role written two ways, and Postgres
    // grants it once. Reporting it twice reads as two separate grants.
    const a = await analyzeSource(
      'policies-duplicate-role',
      `
      import { pgTable, serial, pgPolicy, pgRole } from 'drizzle-orm/pg-core';
      import { sql } from 'drizzle-orm';
      export const authenticated = pgRole('authenticated');
      export const t = pgTable('t', { id: serial('id').primaryKey() }, () => [
        pgPolicy('p', { for: 'select', to: ['authenticated', authenticated], using: sql\`true\` }),
      ]);
    `
    );
    expect(a.tables.find((t) => t.name === 't')?.policies?.[0]?.to).toEqual(['authenticated']);
  });

  it('takes a bare pgRole object as `to`', async () => {
    const a = await analyzeSource(
      'policies-role-object',
      `
      import { pgTable, serial, integer, pgPolicy, pgRole } from 'drizzle-orm/pg-core';
      import { sql } from 'drizzle-orm';
      export const admin = pgRole('admin');
      export const t = pgTable('t', { id: serial('id').primaryKey() }, () => [
        pgPolicy('by_role', { for: 'delete', to: admin, using: sql\`true\` }),
      ]);
    `
    );
    expect(a.tables.find((t) => t.name === 't')?.policies?.[0]?.to).toEqual(['admin']);
  });

  it('renders the expressions with the columns under their TS names', async () => {
    const a = await analyzeSource(
      'policies-rendering',
      `
      import { pgTable, serial, integer, pgPolicy } from 'drizzle-orm/pg-core';
      import { sql } from 'drizzle-orm';
      export const t = pgTable('t', {
        id: serial('id').primaryKey(),
        ownerId: integer('owner_id').notNull(),
      }, (t) => [
        pgPolicy('p', { for: 'all', using: sql\`\${t.ownerId} = 7\`, withCheck: sql\`\${t.ownerId} = 7\` }),
      ]);
    `
    );
    const p = a.tables.find((t) => t.name === 't')?.policies?.[0];
    // `ownerId`, not `owner_id`, and no quoting: the same contract the check expressions keep.
    expect(p?.using).toBe('ownerId = 7');
    expect(p?.withCheck).toBe('ownerId = 7');
    expect(p?.using).not.toMatch(/["`]/);
  });

  it('leaves the other table metadata alone', async () => {
    // A policy reaching one of the branches below it would show up as a phantom index, a wrong
    // composite primary key or a lost unique, which is what the traversal's ordering is for.
    const a = await analyzeSource('policies-basic', TABLE_WITH_POLICIES);
    const posts = a.tables.find((t) => t.name === 'posts');
    expect(posts?.primaryKey?.columns).toEqual(['id']);
    expect(posts?.unique).toEqual([]);
    expect(posts?.indexes).toEqual([{ columns: ['id'] }]);
    expect(posts?.checks).toEqual([]);
  });
});

describe('the RLS flag', () => {
  it('is true when the table calls enableRLS', async () => {
    const a = await analyzeSource(
      'policies-rls-on',
      `
      import { pgTable, serial } from 'drizzle-orm/pg-core';
      export const locked = pgTable('locked', { id: serial('id').primaryKey() }).enableRLS();
    `
    );
    const locked = a.tables.find((t) => t.name === 'locked');
    expect(locked?.rlsEnabled).toBe(true);
    // The pair the CLI's headline finding is built on: RLS on, and nothing declared.
    expect(locked?.policies).toEqual([]);
  });

  /**
   * The measurement that decides what this feature may not report.
   *
   * A table can carry policies and say RLS is off, and the obvious reading of that ("these policies
   * do nothing") is wrong: measured 2026-08-12, declaring any policy makes drizzle-kit emit
   * `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` regardless. The flag is reported as read, and this
   * test exists so nobody later "fixes" the analyzer to infer one from the other.
   */
  it('stays false on a table that declares policies without calling enableRLS', async () => {
    const a = await analyzeSource('policies-basic', TABLE_WITH_POLICIES);
    const posts = a.tables.find((t) => t.name === 'posts');
    expect(posts?.rlsEnabled).toBe(false);
    expect(posts?.policies).toHaveLength(3);
  });

  it.each([
    ['mysql', `import { mysqlTable, int } from 'drizzle-orm/mysql-core';
       export const t = mysqlTable('t', { id: int('id').primaryKey() });`],
    ['sqlite', `import { sqliteTable, integer } from 'drizzle-orm/sqlite-core';
       export const t = sqliteTable('t', { id: integer('id').primaryKey() });`],
  ])('is absent on %s, which cannot be asked the question', async (dialect, source) => {
    const a = await analyzeSource(`policies-${dialect}`, source);
    const t = a.tables.find((x) => x.name === 't');
    // Absent, not false. `false` would be an answer, and this dialect has no row-level security to
    // have turned off.
    expect(t?.rlsEnabled).toBeUndefined();
    expect(t?.policies).toBeUndefined();
  });
});

describe('a policy linked with .link(table)', () => {
  const LINKED = `
    import { pgTable, serial, integer, pgPolicy } from 'drizzle-orm/pg-core';
    import { sql } from 'drizzle-orm';
    export const docs = pgTable('docs', {
      id: serial('id').primaryKey(),
      ownerId: integer('owner_id').notNull(),
    }).enableRLS();
    export const docsOwnerReads = pgPolicy('owner_reads', {
      for: 'select',
      using: sql\`true\`,
    }).link(docs);
  `;

  /**
   * Measured 2026-08-12: linking leaves no trace on the table. Its extra-config callback stays
   * empty and it holds no reference back, so the export is the only place the policy exists.
   * Without this pass, a schema keeping its policies beside its tables reads as a schema with no
   * policies, and the headline finding would state the table denies every row while Postgres was
   * serving them.
   */
  it('is attached to the table it links to, and marked as linked', async () => {
    const a = await analyzeSource('policies-linked', LINKED);
    const docs = a.tables.find((t) => t.name === 'docs');
    expect(docs?.policies?.map((p) => p.name)).toEqual(['owner_reads']);
    expect(docs?.policies?.[0]?.linked).toBe(true);
    expect(docs?.rlsEnabled).toBe(true);
  });

  it('is not reported as a table of its own', async () => {
    const a = await analyzeSource('policies-linked', LINKED);
    expect(a.tables.map((t) => t.name)).toEqual(['docs']);
  });

  it('is not marked as linked when it came from the table itself', async () => {
    const a = await analyzeSource('policies-basic', TABLE_WITH_POLICIES);
    const posts = a.tables.find((t) => t.name === 'posts');
    for (const p of posts?.policies ?? []) expect(p.linked).toBeUndefined();
  });

  it('warns rather than guessing when its table is not exported', async () => {
    const a = await analyzeSource(
      'policies-linked-unexported',
      `
      import { pgTable, serial, pgPolicy } from 'drizzle-orm/pg-core';
      import { sql } from 'drizzle-orm';
      const hidden = pgTable('hidden', { id: serial('id').primaryKey() }).enableRLS();
      export const orphan = pgPolicy('orphan', { for: 'select', using: sql\`true\` }).link(hidden);
    `
    );
    const issue = a.issues.find((i) => i.code === 'DRZL_ANL_POLICY_UNLINKED');
    expect(issue?.level).toBe('warn');
    expect(issue?.message).toContain('orphan');
  });
});
