/**
 * `SchemaAnalyzer` over several files at once.
 *
 * drizzle-kit's `schema` key names files in the plural (a string, an array, globs), and real
 * projects lean on it: a schema directory with one file per table and no barrel is the shape
 * kit's own docs use. DRZL reading kit's config (item 59) therefore needs the analyzer to accept
 * a list of concrete files, or the interop would only work for the single-file minority.
 *
 * The list is of files, never globs: expansion is the CLI's job, so the analyzer's contract
 * stays "load exactly these modules".
 *
 * Fixtures are written at runtime, like every generated fixture in this suite: the fixtures
 * directory's .gitignore admits only an enumerated few, so a spec relying on untracked static
 * files would pass here and fail on a fresh clone.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SchemaAnalyzer } from '../src/index';

const dir = path.resolve(__dirname, '.tmp-multi-file');
const fx = (name: string) => path.join(dir, name);

const USERS = `import { pgTable, serial, text } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
});
`;

const POSTS = `import { integer, pgTable, serial, varchar } from 'drizzle-orm/pg-core';
import { users } from './users';

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id').references(() => users.id),
  title: varchar('title', { length: 200 }).notNull(),
});
`;

// The pattern a barrel-less multi-file schema produces constantly: one file imports another's
// table for a foreign key and re-exports it. The same table under the same name twice must
// not read as a conflict.
const REEXPORT = `import { pgTable, serial, text } from 'drizzle-orm/pg-core';

export { users } from './users';

export const tags = pgTable('tags', {
  id: serial('id').primaryKey(),
  label: text('label').notNull(),
});
`;

// A different table under the same export name as users.ts. Two files disagreeing about what
// `users` is cannot both win; the analyzer keeps the first and must say so.
const CONFLICT = `import { pgTable, serial, text } from 'drizzle-orm/pg-core';

export const users = pgTable('users_shadow', {
  id: serial('id').primaryKey(),
  handle: text('handle').notNull(),
});
`;

beforeAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(fx('users.ts'), USERS, 'utf8');
  await fs.writeFile(fx('posts.ts'), POSTS, 'utf8');
  await fs.writeFile(fx('reexport.ts'), REEXPORT, 'utf8');
  await fs.writeFile(fx('conflict.ts'), CONFLICT, 'utf8');
  await fs.writeFile(
    fx('throws.ts'),
    'throw new Error("boom at import time");\nexport const nothing = 1;\n',
    'utf8'
  );
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('SchemaAnalyzer with a file list', () => {
  it('merges tables, relations and the dialect across files', async () => {
    const analyzer = new SchemaAnalyzer([fx('users.ts'), fx('posts.ts')]);
    const res = await analyzer.analyze({ includeRelations: true });
    expect(res.tables.map((t) => t.name).sort()).toEqual(['posts', 'users']);
    expect(res.dialect).toBe('postgres');
    // The FK in posts.ts references users.ts across the file boundary.
    expect(
      res.relations.some((r) => r.kind === 'one' && r.from === 'posts' && r.to === 'users')
    ).toBe(true);
    expect(res.issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  it('treats a re-export of the same table as one table, not a conflict', async () => {
    const analyzer = new SchemaAnalyzer([fx('users.ts'), fx('reexport.ts')]);
    const res = await analyzer.analyze();
    expect(res.tables.filter((t) => t.name === 'users')).toHaveLength(1);
    expect(res.tables.map((t) => t.name).sort()).toEqual(['tags', 'users']);
    expect(res.issues.some((i) => i.code === 'DRZL_ANL_DUP_EXPORT')).toBe(false);
  });

  it('keeps the first of two genuinely different exports under one name, and says so', async () => {
    const analyzer = new SchemaAnalyzer([fx('users.ts'), fx('conflict.ts')]);
    const res = await analyzer.analyze();
    // First file wins, deterministically: the list order is the caller's, and the CLI sorts.
    const users = res.tables.find((t) => t.name === 'users');
    expect(users).toBeTruthy();
    expect(users!.columns.map((c) => c.name)).toContain('email');
    expect(res.tables.some((t) => t.name === 'users_shadow')).toBe(false);
    const dup = res.issues.find((i) => i.code === 'DRZL_ANL_DUP_EXPORT');
    expect(dup?.level).toBe('warn');
    expect(dup?.message).toContain('users');
    expect(dup?.message).toContain('conflict.ts');
  });

  it('reports every missing file of the list and analyzes nothing', async () => {
    const analyzer = new SchemaAnalyzer([fx('users.ts'), fx('nope.ts'), fx('also-nope.ts')]);
    const res = await analyzer.analyze();
    const missing = res.issues.filter((i) => i.code === 'DRZL_ANL_NOFILE' && i.level === 'error');
    expect(missing).toHaveLength(2);
    expect(res.tables).toEqual([]);
  });

  it('an import failure names the file it happened in', async () => {
    const analyzer = new SchemaAnalyzer([fx('users.ts'), fx('throws.ts')]);
    const res = await analyzer.analyze();
    const imp = res.issues.find((i) => i.code === 'DRZL_ANL_IMPORT');
    expect(imp?.level).toBe('error');
    expect(imp?.message).toContain('throws.ts');
  });

  it('a one-element list behaves exactly like the string form', async () => {
    const single = await new SchemaAnalyzer(fx('users.ts')).analyze();
    const listed = await new SchemaAnalyzer([fx('users.ts')]).analyze();
    expect(listed.tables).toEqual(single.tables);
    expect(listed.dialect).toEqual(single.dialect);
  });
});
