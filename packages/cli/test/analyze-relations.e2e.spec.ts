/**
 * End-to-end: the real `drzl` binary, spawned as a subprocess, against a real Drizzle schema.
 *
 * Everything else in this repo tests functions by importing them from source. That leaves the
 * whole user-facing path untested: argument parsing, the analyzer loading a TypeScript schema
 * through jiti in a separate process, and the JSON that gets printed. `drzl analyze --relations`
 * is documented in docs/cli/analyze.md and returned an empty `relations` array for every schema
 * ever passed to it, and no test noticed, because no test ran the command.
 *
 * Requires a build. CI builds before testing; locally, run `pnpm build` first.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';


const run = promisify(execFile);
const CLI = path.resolve(__dirname, '..', 'dist', 'cli.js');

let workdir: string;

const SCHEMA = `
import { pgTable, integer, text, primaryKey } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const users = pgTable('users', {
  id: integer('id').primaryKey(),
  email: text('email').notNull(),
});

export const posts = pgTable('posts', {
  id: integer('id').primaryKey(),
  authorId: integer('author_id').references(() => users.id, { onDelete: 'cascade' }),
});

export const tags = pgTable('tags', { id: integer('id').primaryKey() });

export const postsToTags = pgTable('posts_to_tags', {
  postId: integer('post_id').references(() => posts.id),
  tagId: integer('tag_id').references(() => tags.id),
}, (t) => [primaryKey({ columns: [t.postId, t.tagId] })]);

export const usersRelations = relations(users, ({ many }) => ({ posts: many(posts) }));
`;

beforeAll(async () => {
  if (!existsSync(CLI)) {
    throw new Error(`Built CLI not found at ${CLI}. Run \`pnpm build\` before \`pnpm test\`.`);
  }
  // The fixture lives under this package rather than in os.tmpdir(). The schema imports
  // drizzle-orm, and Node resolves that by walking parent directories for node_modules; from
  // a system temp directory the walk finds nothing and every case fails with
  // "Cannot find module 'drizzle-orm/pg-core'" rather than testing anything. NODE_PATH does
  // not help, since it is not consulted for ESM resolution.
  workdir = path.join(__dirname, '.e2e-tmp');
  await fs.rm(workdir, { recursive: true, force: true });
  await fs.mkdir(path.join(workdir, 'src'), { recursive: true });
  await fs.writeFile(path.join(workdir, 'src', 'schema.ts'), SCHEMA, 'utf8');
}, 60_000);

async function analyze(...args: string[]) {
  const { stdout } = await run(process.execPath, [CLI, 'analyze', 'src/schema.ts', ...args], {
    cwd: workdir,
    maxBuffer: 20 * 1024 * 1024,
  });
  // The CLI prints friendly lines around the payload; take the JSON object itself.
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  expect(start, `no JSON object in CLI output:\n${stdout}`).toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(start, end + 1));
}

describe('drzl analyze, end to end', () => {
  it('reports foreign keys on the table and mirrored on the column', async () => {
    const out = await analyze('--relations', '--json');
    const posts = out.tables.find((t: any) => t.name === 'posts');
    expect(posts.foreignKeys).toEqual([
      expect.objectContaining({
        columns: ['authorId'],
        foreignTable: 'users',
        foreignColumns: ['id'],
        onDelete: 'cascade',
      }),
    ]);
    expect(posts.columns.find((c: any) => c.name === 'authorId').references).toMatchObject({
      table: 'users',
      column: 'id',
      onDelete: 'cascade',
    });
  }, 60_000);

  it('reports relations, in both directions, including through the join table', async () => {
    const out = await analyze('--relations', '--json');
    expect(out.relations).toEqual(
      expect.arrayContaining([
        { kind: 'one', from: 'posts', to: 'users' },
        { kind: 'many', from: 'users', to: 'posts' },
        { kind: 'manyToMany', from: 'posts', to: 'tags', via: 'posts_to_tags' },
      ])
    );
  }, 60_000);

  it('detects the composite primary key declared in the table callback', async () => {
    const out = await analyze('--relations', '--json');
    const join = out.tables.find((t: any) => t.name === 'posts_to_tags');
    expect(join.primaryKey.columns).toEqual(['postId', 'tagId']);
  }, 60_000);

  it('exits cleanly and reports no issues for a valid schema', async () => {
    const out = await analyze('--relations', '--json');
    expect(out.issues ?? []).toEqual([]);
    expect(out.dialect).toBe('postgres');
  }, 60_000);
});

describe('drzl generate, end to end', () => {
  /** Run the real binary against a config, exactly as documented. */
  async function generate(config: string, outDir: string) {
    await fs.writeFile(path.join(workdir, 'drzl.config.ts'), config, 'utf8');
    await run(process.execPath, [CLI, 'generate'], { cwd: workdir, maxBuffer: 20 * 1024 * 1024 });
    return fs.readFile(path.join(workdir, outDir, 'posts.ts'), 'utf8');
  }

  it('emits relation endpoints for the config shown in the docs', async () => {
    // docs/examples/relations.md verbatim: `outDir` is top level, the flag sits on the
    // generator, and nothing under `analyzer` is set. Foreign keys are structural and always
    // analysed, so that is sufficient, and the documented example has to work as written.
    const posts = await generate(
      `export default {
         schema: './src/schema.ts',
         outDir: './out-docs',
         generators: [{ kind: 'orpc', includeRelations: true }],
       };`,
      'out-docs'
    );
    expect(posts).toContain('listByAuthorId');
    expect(posts).toMatch(/listByAuthorId:\s*listByAuthorIdPosts/);
  }, 120_000);

  it('leaves the router untouched when the flag is absent', async () => {
    const posts = await generate(
      `export default {
         schema: './src/schema.ts',
         outDir: './out-plain',
         generators: [{ kind: 'orpc' }],
       };`,
      'out-plain'
    );
    expect(posts).not.toContain('listBy');
    expect(posts).toContain('list:');
  }, 120_000);
});
