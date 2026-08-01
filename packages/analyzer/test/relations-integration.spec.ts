/**
 * Integration tests against REAL drizzle-orm, not hand-written stand-ins.
 *
 * Every other suite in this package builds fake classes named `PgInteger`, `SQLiteText` and so
 * on, and asserts the analyzer maps those names to types. That is useful for the type table and
 * useless for everything else: a stand-in cannot reproduce where Drizzle actually keeps foreign
 * keys, how it stores a table's third argument, or what `relations()` returns. Those suites were
 * green the entire time foreign keys, relations, indexes, composite primary keys and check
 * constraints were all silently coming back empty.
 *
 * So these tests import drizzle-orm and build real tables. They fail if Drizzle moves its
 * internals, which is the point: this package reads those internals deliberately and has no
 * other way to find out.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer } from '../src/index';

const dir = path.resolve(__dirname, 'fixtures');

/** Write a real schema module and analyze it the way the CLI would. */
async function analyzeSource(name: string, source: string, opts = { includeRelations: true }) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.mjs`);
  await fs.writeFile(file, source, 'utf8');
  return new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze(opts);
}

describe('foreign keys, from real drizzle metadata', () => {
  it('reads an inline .references() foreign key, with its referential actions', async () => {
    const a = await analyzeSource(
      'rel-inline-fk',
      `
      import { pgTable, integer } from 'drizzle-orm/pg-core';
      export const users = pgTable('users', { id: integer('id').primaryKey() });
      export const posts = pgTable('posts', {
        id: integer('id').primaryKey(),
        authorId: integer('author_id').references(() => users.id, { onDelete: 'cascade' }),
      });
      `
    );
    const posts = a.tables.find((t) => t.name === 'posts')!;
    expect(posts.foreignKeys).toEqual([
      {
        columns: ['authorId'],
        foreignTable: 'users',
        foreignColumns: ['id'],
        onDelete: 'cascade',
        onUpdate: undefined,
        name: undefined,
      },
    ]);
    // Single-column keys are mirrored onto the column for convenience.
    expect(posts.columns.find((c) => c.name === 'authorId')!.references).toEqual({
      table: 'users',
      column: 'id',
      onDelete: 'cascade',
      onUpdate: undefined,
    });
  });

  it('reads a composite table-level foreignKey() and does not attach it to a column', async () => {
    const a = await analyzeSource(
      'rel-composite-fk',
      `
      import { pgTable, integer, text, foreignKey } from 'drizzle-orm/pg-core';
      export const users = pgTable('users', {
        id: integer('id').primaryKey(),
        tenant: text('tenant').notNull(),
      });
      export const posts = pgTable('posts', {
        id: integer('id').primaryKey(),
        authorId: integer('author_id'),
        authorTenant: text('author_tenant'),
      }, (t) => [
        foreignKey({ columns: [t.authorId, t.authorTenant], foreignColumns: [users.id, users.tenant], name: 'fk_author' })
          .onDelete('set null'),
      ]);
      `
    );
    const posts = a.tables.find((t) => t.name === 'posts')!;
    expect(posts.foreignKeys).toHaveLength(1);
    expect(posts.foreignKeys![0]).toMatchObject({
      columns: ['authorId', 'authorTenant'],
      foreignTable: 'users',
      foreignColumns: ['id', 'tenant'],
      onDelete: 'set null',
    });
    // A composite key belongs to no single column, so nothing is attached.
    expect(posts.columns.every((c) => !c.references)).toBe(true);
  });

  it('reports TypeScript property names, not database column names', async () => {
    const a = await analyzeSource(
      'rel-naming',
      `
      import { pgTable, integer } from 'drizzle-orm/pg-core';
      export const users = pgTable('users', { userId: integer('user_id').primaryKey() });
      export const posts = pgTable('posts', {
        id: integer('id').primaryKey(),
        authorId: integer('author_id').references(() => users.userId),
      });
      `
    );
    const posts = a.tables.find((t) => t.name === 'posts')!;
    // Drizzle reports 'author_id' and 'user_id' here; a generated schema has to spell the
    // TypeScript names, so both sides of the key are translated.
    expect(posts.foreignKeys![0].columns).toEqual(['authorId']);
    expect(posts.foreignKeys![0].foreignColumns).toEqual(['userId']);
  });

  it('normalises the Postgres-only "no action" default away', async () => {
    // Postgres reports 'no action' where MySQL and SQLite report nothing, for identical
    // schemas. Since it IS the default, the same schema must analyse the same either way.
    const pg = await analyzeSource(
      'rel-noaction-pg',
      `
      import { pgTable, integer } from 'drizzle-orm/pg-core';
      export const users = pgTable('users', { id: integer('id').primaryKey() });
      export const posts = pgTable('posts', { authorId: integer('author_id').references(() => users.id) });
      `
    );
    const sqlite = await analyzeSource(
      'rel-noaction-sqlite',
      `
      import { sqliteTable, integer } from 'drizzle-orm/sqlite-core';
      export const users = sqliteTable('users', { id: integer('id').primaryKey() });
      export const posts = sqliteTable('posts', { authorId: integer('author_id').references(() => users.id) });
      `
    );
    const fk = (a: any) => a.tables.find((t: any) => t.name === 'posts').foreignKeys[0];
    expect(fk(pg).onDelete).toBeUndefined();
    expect(fk(pg).onDelete).toEqual(fk(sqlite).onDelete);
  });

  it('finds inline foreign keys in every dialect that supports them', async () => {
    const cases = [
      ['pg', `import { pgTable as t, integer as i } from 'drizzle-orm/pg-core';`],
      ['mysql', `import { mysqlTable as t, int as i } from 'drizzle-orm/mysql-core';`],
      ['sqlite', `import { sqliteTable as t, integer as i } from 'drizzle-orm/sqlite-core';`],
    ] as const;
    for (const [label, imports] of cases) {
      const a = await analyzeSource(
        `rel-dialect-${label}`,
        `${imports}
        export const users = t('users', { id: i('id').primaryKey() });
        export const posts = t('posts', { authorId: i('author_id').references(() => users.id) });
        `
      );
      const posts = a.tables.find((x) => x.name === 'posts')!;
      expect(posts.foreignKeys, `dialect ${label}`).toHaveLength(1);
      expect(posts.foreignKeys![0].foreignTable, `dialect ${label}`).toBe('users');
    }
  });
});

describe('the table extra-config callback', () => {
  // Drizzle calls this callback with the table's ExtraConfigColumns. Passing the table itself
  // throws, and the throw used to be swallowed, taking every index, unique index, composite
  // primary key, check and table-level foreign key with it.
  it('captures indexes, unique indexes, composite primary keys and checks together', async () => {
    const a = await analyzeSource(
      'rel-extraconfig',
      `
      import { pgTable, integer, text, index, uniqueIndex, primaryKey, check } from 'drizzle-orm/pg-core';
      import { sql } from 'drizzle-orm';
      export const t1 = pgTable('t1', {
        a: integer('a'),
        b: integer('b'),
        slugText: text('slug_text'),
      }, (t) => [
        index('idx_slug').on(t.slugText),
        uniqueIndex('uq_slug').on(t.slugText),
        primaryKey({ columns: [t.a, t.b], name: 'pk_ab' }),
        check('ck_a', sql\`\${t.a} > 0\`),
      ]);
      `
    );
    const t1 = a.tables.find((t) => t.name === 't1')!;

    expect(t1.indexes).toEqual(
      expect.arrayContaining([
        { columns: ['slugText'], name: 'idx_slug' },
        { columns: ['slugText'], name: 'uq_slug' },
      ])
    );
    expect(t1.unique).toEqual([{ columns: ['slugText'], name: 'uq_slug' }]);
    expect(t1.primaryKey?.columns).toEqual(['a', 'b']);
    expect(t1.checks).toHaveLength(1);
    expect(t1.checks![0].name).toBe('ck_a');
    // The expression has to be readable SQL. Stringifying Drizzle's internal chunk array
    // yields "[object Object]", which is worse than omitting it.
    expect(t1.checks![0].expression).not.toContain('[object Object]');
    expect(t1.checks![0].expression).toMatch(/a/);

    expect(a.issues.filter((i) => i.code === 'DRZL_ANL_EXTRACONFIG')).toHaveLength(0);
  });

  it('records an issue rather than silently losing a table whose callback throws', async () => {
    const a = await analyzeSource(
      'rel-badconfig',
      `
      import { pgTable, integer } from 'drizzle-orm/pg-core';
      export const t1 = pgTable('t1', { a: integer('a') }, () => { throw new Error('boom'); });
      `
    );
    expect(a.tables.map((t) => t.name)).toContain('t1');
    expect(a.issues.some((i) => i.code === 'DRZL_ANL_EXTRACONFIG')).toBe(true);
  });
});

describe('relations()', () => {
  it('reads one and many declarations, in the right direction', async () => {
    const a = await analyzeSource(
      'rel-declared',
      `
      import { pgTable, integer } from 'drizzle-orm/pg-core';
      import { relations } from 'drizzle-orm';
      export const users = pgTable('users', { id: integer('id').primaryKey() });
      export const posts = pgTable('posts', { id: integer('id').primaryKey(), authorId: integer('author_id') });
      export const usersRelations = relations(users, ({ many }) => ({ posts: many(posts) }));
      export const postsRelations = relations(posts, ({ one }) => ({
        author: one(users, { fields: [posts.authorId], references: [users.id] }),
      }));
      `
    );
    expect(a.relations).toEqual(
      expect.arrayContaining([
        { kind: 'many', from: 'users', to: 'posts' },
        { kind: 'one', from: 'posts', to: 'users' },
      ])
    );
    expect(a.issues.filter((i) => i.code === 'DRZL_ANL_RELATIONS')).toHaveLength(0);
  });

  it('derives both directions from a foreign key alone, with no relations() present', async () => {
    const a = await analyzeSource(
      'rel-fk-derived',
      `
      import { pgTable, integer } from 'drizzle-orm/pg-core';
      export const users = pgTable('users', { id: integer('id').primaryKey() });
      export const posts = pgTable('posts', { authorId: integer('author_id').references(() => users.id) });
      `
    );
    expect(a.relations).toEqual(
      expect.arrayContaining([
        { kind: 'one', from: 'posts', to: 'users' },
        { kind: 'many', from: 'users', to: 'posts' },
      ])
    );
  });

  it('emits each relation once when a foreign key and a relations() declaration agree', async () => {
    const a = await analyzeSource(
      'rel-dedupe',
      `
      import { pgTable, integer } from 'drizzle-orm/pg-core';
      import { relations } from 'drizzle-orm';
      export const users = pgTable('users', { id: integer('id').primaryKey() });
      export const posts = pgTable('posts', {
        id: integer('id').primaryKey(),
        authorId: integer('author_id').references(() => users.id),
      });
      export const postsRelations = relations(posts, ({ one }) => ({
        author: one(users, { fields: [posts.authorId], references: [users.id] }),
      }));
      `
    );
    const onePostsUsers = a.relations.filter(
      (r) => r.kind === 'one' && r.from === 'posts' && r.to === 'users'
    );
    expect(onePostsUsers).toHaveLength(1);
  });

  it('returns no relations unless asked', async () => {
    const a = await analyzeSource(
      'rel-optout',
      `
      import { pgTable, integer } from 'drizzle-orm/pg-core';
      export const users = pgTable('users', { id: integer('id').primaryKey() });
      export const posts = pgTable('posts', { authorId: integer('author_id').references(() => users.id) });
      `,
      { includeRelations: false }
    );
    expect(a.relations).toEqual([]);
    // The foreign key itself is structural and is still reported.
    expect(a.tables.find((t) => t.name === 'posts')!.foreignKeys).toHaveLength(1);
  });
});

describe('many-to-many inference', () => {
  it('infers a link through a pure join table', async () => {
    const a = await analyzeSource(
      'rel-m2m',
      `
      import { pgTable, integer, primaryKey } from 'drizzle-orm/pg-core';
      export const posts = pgTable('posts', { id: integer('id').primaryKey() });
      export const tags = pgTable('tags', { id: integer('id').primaryKey() });
      export const postsToTags = pgTable('posts_to_tags', {
        postId: integer('post_id').references(() => posts.id),
        tagId: integer('tag_id').references(() => tags.id),
      }, (t) => [ primaryKey({ columns: [t.postId, t.tagId] }) ]);
      `
    );
    expect(a.relations).toEqual(
      expect.arrayContaining([
        { kind: 'manyToMany', from: 'posts', to: 'tags', via: 'posts_to_tags' },
        { kind: 'manyToMany', from: 'tags', to: 'posts', via: 'posts_to_tags' },
      ])
    );
  });

  it('does not treat a table carrying its own data as a join table', async () => {
    // `enrollments` has a grade of its own, so it is an entity in its own right. Calling it
    // plumbing would invent a students-to-courses relation the author never declared.
    const a = await analyzeSource(
      'rel-not-m2m',
      `
      import { pgTable, integer, text } from 'drizzle-orm/pg-core';
      export const students = pgTable('students', { id: integer('id').primaryKey() });
      export const courses = pgTable('courses', { id: integer('id').primaryKey() });
      export const enrollments = pgTable('enrollments', {
        studentId: integer('student_id').references(() => students.id),
        courseId: integer('course_id').references(() => courses.id),
        grade: text('grade'),
      });
      `
    );
    expect(a.relations.filter((r) => r.kind === 'manyToMany')).toEqual([]);
  });
});

describe('heuristic relations', () => {
  it('stays off by default', async () => {
    const a = await analyzeSource(
      'rel-heur-off',
      `
      import { pgTable, integer } from 'drizzle-orm/pg-core';
      export const users = pgTable('users', { id: integer('id').primaryKey() });
      export const posts = pgTable('posts', { userId: integer('user_id') });
      `
    );
    expect(a.relations).toEqual([]);
  });

  it('guesses by name only where no real foreign key exists', async () => {
    const a = await analyzeSource(
      'rel-heur-on',
      `
      import { pgTable, integer } from 'drizzle-orm/pg-core';
      export const users = pgTable('users', { id: integer('id').primaryKey() });
      export const posts = pgTable('posts', { userId: integer('user_id') });
      `,
      { includeRelations: true, includeHeuristicRelations: true } as any
    );
    expect(a.relations).toEqual(
      expect.arrayContaining([{ kind: 'one', from: 'posts', to: 'users' }])
    );
  });
});

describe('enums', () => {
  it('captures a pgEnum even when relations are not requested', async () => {
    // Enum capture used to sit inside `if (opts.includeRelations)`, so a caller that only
    // wanted tables silently got none.
    const a = await analyzeSource(
      'rel-enum',
      `
      import { pgTable, pgEnum } from 'drizzle-orm/pg-core';
      export const roleEnum = pgEnum('role', ['admin', 'user']);
      export const users = pgTable('users', { role: roleEnum('role') });
      `,
      { includeRelations: false }
    );
    expect(a.enums.some((e) => e.values.join() === 'admin,user')).toBe(true);
  });

  it('reports one entry per distinct enum rather than the same values twice', async () => {
    const a = await analyzeSource(
      'rel-enum-dupe',
      `
      import { pgTable, pgEnum } from 'drizzle-orm/pg-core';
      export const roleEnum = pgEnum('role', ['admin', 'user']);
      export const users = pgTable('users', { role: roleEnum('role') });
      `
    );
    const withValues = a.enums.filter((e) => e.values.join() === 'admin,user');
    expect(withValues).toHaveLength(1);
  });
});
