/**
 * A whole project generated from a schema that holds two tables of the same name, and compiled.
 *
 * The unit tests each pin one surface. This one asks the question those cannot: with
 * `public.users` and `reporting.users` both present, does a real run of the real analyzer and the
 * real generators produce a tree that a consumer's `tsc` accepts? Every collision this item is
 * about is a collision between two *files* or two *exports*, and only a compile of the emitted
 * tree can say whether one silently replaced the other.
 *
 * The schema is built with real drizzle-orm rather than hand-written `Table` objects, because the
 * one fact everything rests on, that `pgSchema('reporting').table('users', ...)` records `users`
 * and not `reporting.users`, is a fact about Drizzle and not about DRZL.
 *
 * Two directories because two things have to resolve: the schema imports `drizzle-orm`, which
 * resolves from `packages/cli`, and the emitted modules import `zod`, which resolves from
 * `packages/generator-zod`. Both are `test/.tmp-*`, gitignored for every package.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer, qualifiedTableName } from '@drzl/analyzer';
import type { Analysis } from '@drzl/analyzer';
import { ZodGenerator } from '@drzl/generator-zod';
import { ServiceGenerator } from '@drzl/generator-service';
import { JsonSchemaGenerator } from '@drzl/generator-json-schema';
import { filterColumns } from '../src/column-filter';
import { filterTables, tableFilterWarnings } from '../src/config';

const SCHEMA_DIR = path.join(__dirname, '.tmp-multi-schema-e2e');
const EMIT_ROOT = path.join(
  __dirname,
  '..',
  '..',
  'generator-zod',
  'test',
  `.tmp-multi-schema-e2e-${process.pid}`
);
const tsc = path.resolve(__dirname, '..', '..', 'generator-zod', 'node_modules', '.bin', 'tsc');

/**
 * Two `users`, one child in each schema, and a name that exists in only one.
 *
 * `reportingUsers` deliberately carries a column `public.users` does not, and vice versa, so a
 * schema built from the wrong table is a visible difference rather than a coincidence.
 */
const SCHEMA = `
import { pgTable, pgSchema, integer, text, boolean } from 'drizzle-orm/pg-core';

export const reporting = pgSchema('reporting');

export const users = pgTable('users', {
  id: integer('id').primaryKey(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  active: boolean('active').notNull().default(true),
});

export const reportingUsers = reporting.table('users', {
  id: integer('id').primaryKey(),
  label: text('label').notNull(),
});

export const posts = pgTable('posts', {
  id: integer('id').primaryKey(),
  authorId: integer('author_id').references(() => users.id),
  title: text('title').notNull(),
});

export const reportingNotes = reporting.table('notes', {
  id: integer('id').primaryKey(),
  userId: integer('user_id').references(() => reportingUsers.id),
  body: text('body').notNull(),
});
`;

let analysis: Analysis;
let warnings: string[];
let emitted: string[];
let barrel: string;
let openapi: any;

beforeAll(async () => {
  await fs.rm(SCHEMA_DIR, { recursive: true, force: true });
  await fs.rm(EMIT_ROOT, { recursive: true, force: true });
  await fs.mkdir(SCHEMA_DIR, { recursive: true });
  await fs.mkdir(path.join(EMIT_ROOT, 'validators'), { recursive: true });

  const schemaFile = path.join(SCHEMA_DIR, 'schema.mjs');
  await fs.writeFile(schemaFile, SCHEMA, 'utf8');

  analysis = await new SchemaAnalyzer(path.relative(process.cwd(), schemaFile)).analyze({
    includeRelations: true,
  });

  // A qualified key, which is the whole point: `passwordHash` is on `public.users` and the other
  // `users` must not be touched.
  const narrowed = filterColumns(analysis.tables, {
    'public.users': { omit: ['passwordHash'] },
  });
  const cfg = { exclude: ['reporting.notes'] };
  warnings = [...narrowed.warnings, ...tableFilterWarnings(narrowed.tables, cfg)];
  analysis.tables = filterTables(narrowed.tables, cfg);

  await new ZodGenerator(analysis).generate({
    outDir: path.join(EMIT_ROOT, 'validators'),
    nestedSchemas: true,
  } as never);
  await new ServiceGenerator(analysis).generate({
    outDir: path.join(EMIT_ROOT, 'services'),
  } as never);
  await new JsonSchemaGenerator(analysis).generate({
    outDir: path.join(EMIT_ROOT, 'openapi'),
    document: { format: 'json' },
    includeRelations: true,
  } as never);

  emitted = (await fs.readdir(path.join(EMIT_ROOT, 'validators'))).sort();
  barrel = await fs.readFile(path.join(EMIT_ROOT, 'validators', 'index.ts'), 'utf8');
  openapi = JSON.parse(await fs.readFile(path.join(EMIT_ROOT, 'openapi', 'openapi.json'), 'utf8'));
}, 120_000);

afterAll(async () => {
  await fs.rm(SCHEMA_DIR, { recursive: true, force: true });
  await fs.rm(EMIT_ROOT, { recursive: true, force: true });
});

describe('the analysis', () => {
  it('sees four tables and tells the two users apart', () => {
    expect(analysis.tables.map(qualifiedTableName).sort()).toEqual([
      'posts',
      'reporting.users',
      'users',
    ]);
  });

  it('honoured the qualified columns key on one table only', () => {
    const byQualified = Object.fromEntries(analysis.tables.map((t) => [qualifiedTableName(t), t]));
    expect(byQualified['users'].columns.map((c) => c.name)).toEqual(['id', 'email', 'active']);
    expect(byQualified['reporting.users'].columns.map((c) => c.name)).toEqual(['id', 'label']);
  });

  it('honoured a qualified exclude', () => {
    expect(analysis.tables.map(qualifiedTableName)).not.toContain('reporting.notes');
  });

  it('said nothing about ambiguity, because every pattern named its schema', () => {
    // The one warning that is here is the pre-existing NOT NULL note about `passwordHash`, which
    // has nothing to do with schemas and is exactly right.
    expect(warnings.filter((w) => w.includes('more than one schema'))).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/drops "passwordHash" from table "users"/);
  });

  it('would have warned had the key been bare', () => {
    // `email` is on `public.users` only, so the "matches at least one" typo check stays quiet and
    // the entry silently reaches a second, unrelated table. That is the case the warning is for.
    const bare = filterColumns(analysis.tables, { users: { omit: ['email'] } });
    expect(bare.warnings.join('\n')).toMatch(/matches tables in more than one schema/);
    expect(bare.warnings.join('\n')).toMatch(/public\.users, reporting\.users/);
  });
});

describe('the emitted files', () => {
  it('gives each table its own module, named from the Drizzle export', () => {
    expect(emitted).toEqual(['index.ts', 'posts.zod.ts', 'reportingUsers.zod.ts', 'users.zod.ts']);
  });

  it('exports every module from the barrel exactly once', () => {
    const lines = barrel.split('\n').filter((l) => l.startsWith('export'));
    expect(lines).toEqual([
      "export * from './posts.zod.js';",
      "export * from './reportingUsers.zod.js';",
      "export * from './users.zod.js';",
    ]);
  });

  it('keeps the two schemas describing different rows', async () => {
    const pub = await fs.readFile(path.join(EMIT_ROOT, 'validators', 'users.zod.ts'), 'utf8');
    const rep = await fs.readFile(
      path.join(EMIT_ROOT, 'validators', 'reportingUsers.zod.ts'),
      'utf8'
    );
    expect(pub).toContain('SelectusersSchema');
    expect(pub).toContain('email');
    expect(pub).not.toContain('passwordHash');
    expect(rep).toContain('SelectreportingUsersSchema');
    expect(rep).toContain('label');
    expect(rep).not.toContain('email');
  });

  it('gives the services distinct names too', async () => {
    const files = (await fs.readdir(path.join(EMIT_ROOT, 'services'))).sort();
    expect(files).toContain('userService.ts');
    expect(files).toContain('reportingUserService.ts');
  });
});

describe('the OpenAPI document', () => {
  it('emits a path for both tables rather than refusing', () => {
    expect(Object.keys(openapi.paths)).toContain('/users');
    expect(Object.keys(openapi.paths)).toContain('/reporting/users');
  });

  it('tags them apart', () => {
    expect(openapi.tags.map((t: any) => t.name).sort()).toEqual([
      'posts',
      'reporting.users',
      'users',
    ]);
  });

  it('hangs the child under the parent in its own schema', () => {
    // `posts.authorId` points at `public.users`, so `/users/{id}/posts` and nothing under
    // `/reporting/users/{id}`.
    expect(Object.keys(openapi.paths)).toContain('/users/{id}/posts');
    expect(Object.keys(openapi.paths)).not.toContain('/reporting/users/{id}/posts');
  });
});

describe('the generated project', () => {
  it('has a tsc to run', () => {
    expect(existsSync(tsc), `no tsc at ${tsc}; run pnpm install`).toBe(true);
  });

  it('compiles under strict nodenext', async () => {
    const tsconfig = path.join(EMIT_ROOT, 'tsconfig.json');
    await fs.writeFile(
      tsconfig,
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'es2022',
          module: 'nodenext',
          moduleResolution: 'nodenext',
          skipLibCheck: true,
        },
        include: ['validators/**/*.ts', 'services/**/*.ts'],
      })
    );
    await fs.writeFile(
      path.join(EMIT_ROOT, 'package.json'),
      '{"name":"probe","type":"module","private":true}'
    );

    // A probe that imports both `users` schemas through the barrel at once. If the two modules
    // had collided on a file name or an export name, this is where it stops compiling.
    await fs.writeFile(
      path.join(EMIT_ROOT, 'validators', 'probe.ts'),
      [
        "import { SelectusersSchema, SelectreportingUsersSchema } from './index.js';",
        "import type { SelectusersOutput, SelectreportingUsersOutput } from './index.js';",
        'export const a: SelectusersOutput = SelectusersSchema.parse({',
        "  id: 1, email: 'a@b.c', active: true,",
        '});',
        'export const b: SelectreportingUsersOutput = SelectreportingUsersSchema.parse({',
        "  id: 1, label: 'x',",
        '});',
        '// Each row has a field the other does not, so a module that answered for both fails here.',
        'export const bothDiffer: [string, string] = [a.email, b.label];',
      ].join('\n')
    );

    let out = '';
    try {
      execFileSync(tsc, ['-p', tsconfig], { cwd: EMIT_ROOT, stdio: 'pipe' });
    } catch (e) {
      const err = e as { stdout?: Buffer; stderr?: Buffer };
      out = `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`;
    }
    expect(out).toBe('');
  }, 120_000);
});
