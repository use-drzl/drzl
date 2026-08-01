/**
 * `includeRelations` used to be accepted and then ignored: nothing in this package ever read
 * `analysis.relations` or `Table.foreignKeys`, so the option changed no byte of output while
 * docs/examples/relations.md promised endpoints like `listByParentId`.
 *
 * These tests pin what it emits now, and, just as importantly, that it stays off by default.
 */
import { describe, it, expect } from 'vitest';
import { ORPCGenerator } from '../src';
import type { Analysis } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** users(id, email) and posts(id, title, authorId -> users.id, editorId -> users.id). */
function analysisWithForeignKeys(): Analysis {
  const col = (name: string, tsType: string, extra: Record<string, unknown> = {}) => ({
    name,
    tsType,
    dbType: tsType === 'number' ? 'INTEGER' : 'TEXT',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...extra,
  });
  return {
    dialect: 'sqlite',
    tables: [
      {
        name: 'users',
        tsName: 'users',
        columns: [col('id', 'number', { isGenerated: true, hasDefault: true }), col('email', 'string')],
        unique: [],
        indexes: [],
        foreignKeys: [],
      },
      {
        name: 'posts',
        tsName: 'posts',
        columns: [
          col('id', 'number', { isGenerated: true, hasDefault: true }),
          col('title', 'string'),
          col('authorId', 'number', {
            references: { table: 'users', column: 'id' },
          }),
          col('editorId', 'number', {
            nullable: true,
            references: { table: 'users', column: 'id' },
          }),
        ],
        unique: [],
        indexes: [],
        foreignKeys: [
          { columns: ['authorId'], foreignTable: 'users', foreignColumns: ['id'] },
          { columns: ['editorId'], foreignTable: 'users', foreignColumns: ['id'] },
        ],
      },
    ] as any,
    enums: [],
    relations: [
      { kind: 'one', from: 'posts', to: 'users' },
      { kind: 'many', from: 'users', to: 'posts' },
    ],
    issues: [],
  };
}

async function generate(opts: Record<string, unknown> = {}) {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-orpc-rel-'));
  const gen = new ORPCGenerator(analysisWithForeignKeys());
  await gen.generate({ outputDir: outDir, ...opts } as any);
  const read = async (f: string) => fs.readFile(path.join(outDir, f), 'utf8');
  return { outDir, posts: await read('posts.ts'), users: await read('users.ts') };
}

describe('relation procedures', () => {
  it('emits nothing extra unless includeRelations is set', async () => {
    const { posts } = await generate();
    expect(posts).not.toContain('listByAuthorId');
    expect(posts).not.toContain('listByEditorId');
    // The ordinary CRUD surface is untouched.
    expect(posts).toContain('list:');
    expect(posts).toContain('get:');
  });

  it('emits one lookup per foreign key, named after the column', async () => {
    const { posts } = await generate({ includeRelations: true });
    expect(posts).toContain('listByAuthorId');
    expect(posts).toContain('listByEditorId');
    // Exported on the router, not merely declared.
    expect(posts).toMatch(/listByAuthorId:\s*listByAuthorIdPosts/);
  });

  it('takes the foreign key column as input and returns rows of its own table', async () => {
    const { posts } = await generate({ includeRelations: true });
    // Input is the scalar foreign key, typed from the column.
    expect(posts).toMatch(/\.input\(z\.object\(\{ authorId: z\.number\(\) \}\)\)/);
    // Output is this table's own select schema, which is already in scope.
    expect(posts).toMatch(/listByAuthorIdPosts[\s\S]{0,200}?\.output\(z\.array\(SelectpostsSchema\)\)/);
  });

  it('adds nothing to a table that owns no foreign key', async () => {
    const { users } = await generate({ includeRelations: true });
    expect(users).not.toContain('listBy');
  });

  it('respects the chosen validation library', async () => {
    const { posts } = await generate({
      includeRelations: true,
      validation: { library: 'valibot' },
    });
    expect(posts).toMatch(/\.input\(v\.object\(\{ authorId: v\.number\(\) \}\)\)/);
    expect(posts).toContain('v.array(SelectpostsSchema)');
  });

  it('emits arktype lookups in arktype syntax', async () => {
    const { posts } = await generate({
      includeRelations: true,
      validation: { library: 'arktype' },
    });
    // Quote style is prettier's to decide, so the assertion accepts either.
    expect(posts).toMatch(/\.input\(type\(\{ authorId: ['"]number['"] \}\)\)/);
    expect(posts).toContain('SelectpostsSchema.array()');
  });

  it('applies procedure case to the exported key', async () => {
    const { posts } = await generate({
      includeRelations: true,
      naming: { procedureCase: 'snake' },
    });
    expect(posts).toContain('list_by_author_id:');
  });

  it('quotes a key that is not a valid identifier rather than emitting broken syntax', async () => {
    const { posts } = await generate({
      includeRelations: true,
      naming: { procedureCase: 'kebab' },
    });
    expect(posts).toContain('"list-by-author-id":');
  });

  it('produces output a formatter accepts, which requires it to parse', async () => {
    // The generator runs prettier over its output and swallows failures, so a syntax error
    // shows up as unformatted-but-written code rather than an error. Parse it explicitly.
    const { posts } = await generate({ includeRelations: true });
    const ts = await import('typescript');
    const sf = ts.createSourceFile('posts.ts', posts, ts.ScriptTarget.ES2022, true);
    const diagnostics = (sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics;
    expect(diagnostics ?? []).toHaveLength(0);
  });

  it('does not duplicate a lookup when two foreign keys point at the same table', async () => {
    // authorId and editorId both reference users. Naming after the table would collide and
    // emit the same procedure twice; naming after the column keeps them distinct.
    const { posts } = await generate({ includeRelations: true });
    const matches = posts.match(/const listBy\w+Posts/g) ?? [];
    expect(new Set(matches).size).toBe(matches.length);
    expect(matches).toHaveLength(2);
  });

  it('skips composite foreign keys, which have no single scalar input', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-orpc-rel-'));
    const analysis = analysisWithForeignKeys();
    (analysis.tables[1] as any).foreignKeys = [
      { columns: ['authorId', 'title'], foreignTable: 'users', foreignColumns: ['id', 'email'] },
    ];
    await new ORPCGenerator(analysis).generate({
      outputDir: outDir,
      includeRelations: true,
    } as any);
    const posts = await fs.readFile(path.join(outDir, 'posts.ts'), 'utf8');
    expect(posts).not.toContain('listBy');
  });
});
