/**
 * End to end: a real schema through the real analyzer, routers from this generator beside the
 * services `@drzl/generator-service` actually writes, compiled with strict nodenext tsc against
 * a REAL typed database object and the real @orpc/server and zod.
 *
 * This is the leg that made plan addendum BQ measurable. Before the key-typing fix this exact
 * tree failed with 9 errors, all in the routers: 3x TS2345 on books (a number passed into the
 * varchar key's `id: string`), 3x TS2554 on memberships (one argument into a composite key's
 * parameter list), 3x TS2339 on logs (service methods a keyless table no longer has). The
 * authors tree, integer-keyed, compiled before and after. Both service modes are compiled:
 * drizzle mode against a typed PgDatabase, and stub mode, which BP's typed stub signatures
 * moved from compiling-but-fictional to red until this fix aligned the routers.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SchemaAnalyzer } from '@drzl/analyzer';
import type { Analysis } from '@drzl/analyzer';
import { ServiceGenerator } from '@drzl/generator-service';
import { ORPCGenerator } from '../src';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const ROOT = path.join(pkgRoot, 'test', '.tmp-key-typing');
const tsc = path.join(pkgRoot, 'node_modules', '.bin', 'tsc');

const SCHEMA = `import { pgTable, serial, integer, text, primaryKey } from 'drizzle-orm/pg-core';

export const authors = pgTable('authors', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
});
export const books = pgTable('books', {
  isbn: text('isbn').primaryKey(),
  title: text('title').notNull(),
  authorId: integer('author_id').references(() => authors.id),
});
export const memberships = pgTable(
  'memberships',
  {
    orgId: integer('org_id').notNull(),
    userId: text('user_id').notNull(),
    role: text('role').notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })]
);
export const logs = pgTable('logs', {
  at: integer('at').notNull(),
  what: text('what').notNull(),
});
`;

const DB = `import type { PgDatabase } from 'drizzle-orm/pg-core';
export const db = null as unknown as PgDatabase<any, any, any>;
`;

let analysisResult: Analysis;

async function compileTree(name: string, dataAccess: 'drizzle' | 'stub'): Promise<string> {
  const dir = path.join(ROOT, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'schema.ts'), SCHEMA);
  await fs.writeFile(path.join(dir, 'db.ts'), DB);

  await new ServiceGenerator(analysisResult).generate({
    outDir: path.join(dir, 'services'),
    dataAccess,
    ...(dataAccess === 'drizzle'
      ? {
          dbImportPath: path.join(dir, 'db'),
          schemaImportPath: path.join(dir, 'schema'),
        }
      : {}),
    importExtension: 'js',
    format: { enabled: false },
  });

  await new ORPCGenerator(analysisResult).generate({
    outputDir: path.join(dir, 'api'),
    template: '@drzl/template-orpc-service',
    includeRelations: true,
    servicesDir: path.join(dir, 'services'),
    importExtension: 'js',
    format: { enabled: false },
  });

  await fs.writeFile(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'es2022',
        module: 'nodenext',
        moduleResolution: 'nodenext',
        skipLibCheck: true,
      },
      include: ['schema.ts', 'db.ts', 'services/**/*.ts', 'api/**/*.ts'],
    })
  );

  try {
    execFileSync(tsc, ['-p', path.join(dir, 'tsconfig.json')], { cwd: dir, stdio: 'pipe' });
    return '';
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer };
    return `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`;
  }
}

beforeAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(ROOT, { recursive: true });
  // The analyzer needs the schema on disk before anything generates from it.
  const seed = path.join(ROOT, 'schema.ts');
  await fs.writeFile(seed, SCHEMA);
  analysisResult = await new SchemaAnalyzer(seed).analyze({ includeRelations: true });
  expect(
    analysisResult.tables.length,
    `no tables analyzed: ${JSON.stringify(analysisResult.issues)}`
  ).toBe(4);
}, 120_000);

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('the emitted tree against real services and a real typed db', () => {
  it('compiles natural, composite and keyless tables in drizzle mode with zero errors', async () => {
    expect(await compileTree('drizzle', 'drizzle')).toBe('');
  }, 120_000);

  it('compiles against stub-mode services too, the pairing BP left red', async () => {
    expect(await compileTree('stub', 'stub')).toBe('');
  }, 120_000);
});
