/**
 * The SQLite half of the dialect split: SQLite has RETURNING and drizzle's sqlite builders
 * expose `.returning()` on both majors (measured through better-sqlite3), so the service
 * emission for sqlite keeps the single-statement shape the pg emission uses. This spec pins
 * that: the emitted tree compiles against both majors and runs against a real database, so a
 * change that routed sqlite through the MySQL branch, or broke the RETURNING branch, fails
 * here rather than in a consumer's project.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SchemaAnalyzer } from '@drzl/analyzer';
import { ServiceGenerator } from '../src';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const ROOT = path.join(pkgRoot, 'test', '.tmp-sqlite-runtime');
const tsc = path.join(pkgRoot, 'node_modules', '.bin', 'tsc');

const SCHEMA = `import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull(),
  nickname: text('nickname'),
});
`;

interface Tree {
  dir: string;
  compileOut: string;
  text: string;
}

const rel = (p: string) => path.relative(process.cwd(), p);

async function buildTree(name: string, majorPkg: string): Promise<Tree> {
  const dir = path.join(ROOT, name);
  await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
  const link = path.join(dir, 'node_modules', 'drizzle-orm');
  await fs.rm(link, { recursive: true, force: true });
  await fs.symlink(path.join(pkgRoot, 'node_modules', majorPkg), link, 'dir');
  await fs.writeFile(path.join(dir, 'package.json'), '{"name":"probe","private":true,"type":"module"}');
  await fs.writeFile(path.join(dir, 'schema.ts'), SCHEMA);

  const analysis = await new SchemaAnalyzer(rel(path.join(dir, 'schema.ts'))).analyze({});
  expect(analysis.dialect).toBe('sqlite');

  const injection = {
    enabled: true,
    databaseType: 'BetterSQLite3Database',
    databaseTypeImport: { name: 'BetterSQLite3Database', from: 'drizzle-orm/better-sqlite3' },
  };
  const gen = new ServiceGenerator(analysis);
  await gen.generate({
    outDir: rel(path.join(dir, 'services')),
    dataAccess: 'drizzle',
    schemaImportPath: rel(path.join(dir, 'schema')),
    databaseInjection: injection,
    importExtension: 'js',
  });
  await gen.generate({
    outDir: rel(path.join(dir, 'services-run')),
    dataAccess: 'drizzle',
    schemaImportPath: rel(path.join(dir, 'schema')),
    databaseInjection: injection,
    importExtension: 'none',
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
      include: ['schema.ts', 'services/**/*.ts'],
    })
  );
  let compileOut = '';
  try {
    execFileSync(tsc, ['-p', path.join(dir, 'tsconfig.json')], { cwd: dir, stdio: 'pipe' });
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer };
    compileOut = `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`;
  }
  const text = await fs.readFile(path.join(dir, 'services', 'userService.ts'), 'utf8');
  return { dir, compileOut, text };
}

let v045: Tree;
let v1: Tree;

beforeAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
  v045 = await buildTree('v045', 'drizzle-orm');
  v1 = await buildTree('v1', 'drizzle-orm-v1');
}, 300_000);

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe.each([
  ['0.45.2', () => v045],
  ['1.0.0-rc.4', () => v1],
])('emitted sqlite services on drizzle-orm %s', (label, tree) => {
  it('keeps the RETURNING shape and compiles', () => {
    expect(tree().compileOut).toBe('');
    expect(tree().text.match(/\.returning\(\)/g)?.length).toBe(2);
    expect(tree().text).not.toContain('$returningId');
  });

  it('create and update hand the row back through a real better-sqlite3', async () => {
    const { default: Database } = await import('better-sqlite3');
    const sqlite = new Database(':memory:');
    sqlite.exec(
      'CREATE TABLE users (id integer PRIMARY KEY AUTOINCREMENT, email text NOT NULL, nickname text NULL)'
    );
    let db: unknown;
    if (label === '0.45.2') {
      const { drizzle } = await import('drizzle-orm/better-sqlite3');
      db = drizzle(sqlite);
    } else {
      const { drizzle } = await import('drizzle-orm-v1/better-sqlite3');
      db = drizzle({ client: sqlite });
    }
    try {
      const { UserService } = await import(path.join(tree().dir, 'services-run', 'userService.ts'));
      const created = await UserService.create(db, { email: 'ada@x.io' });
      expect(created).toEqual({ id: 1, email: 'ada@x.io', nickname: null });
      const updated = await UserService.update(db, 1, { nickname: 'Ada' });
      expect(updated).toEqual({ id: 1, email: 'ada@x.io', nickname: 'Ada' });
      expect(await UserService.update(db, 9999, { nickname: 'X' })).toBeUndefined();
      expect(await UserService.delete(db, 1)).toBe(true);
      expect(await UserService.getById(db, 1)).toBeNull();
    } finally {
      sqlite.close();
    }
  }, 60_000);
});
