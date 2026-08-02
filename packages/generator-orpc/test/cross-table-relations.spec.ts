/**
 * Lookups that return rows of another table: the inverse of a foreign key, and the far side of
 * a many-to-many.
 *
 *   users.listPosts   every post whose authorId is this user
 *   posts.listTags    every tag joined to this post through posts_to_tags
 *
 * The hard part is not finding them, the analyzer already reports both. It is that the output
 * schema lives in another router file, and once both directions are emitted, which many-to-many
 * always does, those imports are circular. An eager reference fails at runtime with "Cannot
 * access X before initialization" and typechecks perfectly on the way, so the reference is
 * deferred with `z.lazy` / `v.lazy`. That the emitted graph actually loads is verified against
 * the real packages in scripts/verify-packed.sh; these cases pin the shape.
 */
import { describe, it, expect } from 'vitest';
import { ORPCGenerator } from '../src';
import type { Analysis } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const col = (name: string, tsType = 'number') => ({
  name,
  tsType,
  dbType: 'INTEGER',
  nullable: false,
  hasDefault: false,
  isGenerated: false,
});

/** posts and tags joined by posts_to_tags, plus a plain foreign key from posts to users. */
const analysis: Analysis = {
  dialect: 'postgres',
  tables: [
    { name: 'users', tsName: 'users', columns: [col('id')], unique: [], indexes: [] },
    {
      name: 'posts',
      tsName: 'posts',
      columns: [col('id'), col('authorId')],
      unique: [],
      indexes: [],
      foreignKeys: [{ columns: ['authorId'], foreignTable: 'users', foreignColumns: ['id'] }],
    },
    { name: 'tags', tsName: 'tags', columns: [col('id')], unique: [], indexes: [] },
  ] as never,
  enums: [],
  relations: [
    { kind: 'one', from: 'posts', to: 'users' },
    { kind: 'many', from: 'users', to: 'posts' },
    { kind: 'manyToMany', from: 'posts', to: 'tags', via: 'posts_to_tags' },
    { kind: 'manyToMany', from: 'tags', to: 'posts', via: 'posts_to_tags' },
  ],
  issues: [],
};

async function generate(opts: Record<string, unknown> = {}) {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-cross-'));
  await new ORPCGenerator(analysis).generate({
    outputDir: outDir,
    includeRelations: true,
    ...opts,
  } as never);
  const read = (f: string) => fs.readFile(path.join(outDir, f), 'utf8');
  return { users: await read('users.ts'), posts: await read('posts.ts'), tags: await read('tags.ts') };
}

describe('the inverse of a foreign key', () => {
  it('gives the parent a lookup returning the child table', async () => {
    const { users } = await generate();
    expect(users).toContain('listPosts');
    expect(users).toMatch(/listPosts:\s*listPostsUsers/);
  });

  it('imports the child schema from the child router', async () => {
    const { users } = await generate();
    expect(users).toMatch(/import \{ SelectpostsSchema \} from ["']\.\/posts\.js["']/);
  });

  it('does not give the child a lookup back, which its foreign key already covers', async () => {
    const { posts } = await generate();
    expect(posts).toContain('listByAuthorId');
    expect(posts).not.toMatch(/listUsers\b/);
  });
});

describe('many-to-many', () => {
  it('emits a lookup in both directions', async () => {
    const { posts, tags } = await generate();
    expect(posts).toContain('listTags');
    expect(tags).toContain('listPosts');
  });

  it('names the join table in the stub, so the query to write is obvious', async () => {
    const { posts } = await generate();
    expect(posts).toMatch(/related to this posts through posts_to_tags/);
  });
});

describe('the circular import these create', () => {
  it('defers every cross-table reference, which is what keeps the graph loadable', async () => {
    // posts imports tags and tags imports posts. Referencing either eagerly at module scope
    // throws "Cannot access X before initialization" the moment the router is imported.
    const { posts, tags } = await generate();
    expect(posts).toMatch(/z\.array\(z\.lazy\(\(\) => SelecttagsSchema\)\)/);
    expect(tags).toMatch(/z\.array\(z\.lazy\(\(\) => SelectpostsSchema\)\)/);
  });

  it('never references an imported schema outside a lazy thunk', async () => {
    const { posts } = await generate();
    for (const m of posts.matchAll(/SelecttagsSchema/g)) {
      const before = posts.slice(Math.max(0, m.index! - 40), m.index!);
      expect(before, `eager use at offset ${m.index}`).toMatch(/lazy\(\(\) => $|import \{ $/);
    }
  });

  it('uses the shared barrel instead of sibling routers when validation is shared', async () => {
    // No cycle in that case: every router imports the one barrel.
    const { users } = await generate({
      validation: { useShared: true, library: 'zod', importPath: './schemas' },
    });
    expect(users).toMatch(/import \{ SelectpostsSchema \} from ["'][^"']*schemas[^"']*["']/);
    expect(users).not.toMatch(/from ["']\.\/posts\.js["']/);
  });
});

describe('valibot', () => {
  it('uses v.lazy rather than zod syntax', async () => {
    const { posts } = await generate({ validation: { library: 'valibot' } });
    expect(posts).toMatch(/v\.array\(v\.lazy\(\(\) => SelecttagsSchema\)\)/);
  });
});

describe('arktype', () => {
  it('emits no cross-table lookups, rather than an untested deferred form', async () => {
    // Its own foreign-key lookups are unaffected; only the ones needing a circular reference
    // are withheld, because an endpoint that fails to load is worse than one that is absent.
    const { posts } = await generate({ validation: { library: 'arktype' } });
    expect(posts).toContain('listByAuthorId');
    expect(posts).not.toContain('listTags');
  });
});
