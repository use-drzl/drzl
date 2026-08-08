/**
 * The key parameter of every emitted service method, typed from the primary key itself.
 *
 * The defect this pins (plan addendum BP): getById/update/delete spelled their key parameter
 * as `id: number` whatever the primary key's type, so a varchar key made `eq(books.isbn, id)`
 * TS2769 on every dialect including Postgres (measured: 3 errors per emitted module per mode
 * on pg/sqlite, 4 on mysql where update re-selects). A composite key was worse for compiling:
 * every method addressed the row by the FIRST key column alone, so `update` and `delete` hit
 * every row sharing that column's value, and the update patch type omitted only that first
 * column. A table with no primary key emitted the methods anyway against a fictional `id`
 * column, which is TS2339 against any real schema.
 *
 * The policy here is the route generators' settled one (hono/express/fastify/nestjs, and the
 * tRPC procedures): the key is read off `primaryKey`, every column of it, at its real type,
 * and a table without one loses the methods that would have needed it rather than gaining a
 * fictional `id`. Spelled for a function signature, a composite key becomes one parameter per
 * key column, in key order, named after the columns: the signature analogue of the routers'
 * `/:orgId/:userId`. A single-column key keeps its historical parameter name `id`, because for
 * an integer key `id: number` was always correct and int-pk emissions must not move a byte.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SchemaAnalyzer } from '@drzl/analyzer';
import type { Analysis, Column, Table } from '@drzl/analyzer';
import { ServiceGenerator } from '../src';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const ROOT = path.join(pkgRoot, 'test', '.tmp-key-typing');
const tsc = path.join(pkgRoot, 'node_modules', '.bin', 'tsc');
const rel = (p: string) => path.relative(process.cwd(), p);

// ---------------------------------------------------------------------------------------------
// In-memory fixtures for the emission shapes, same helpers as the tRPC generator's tests.
// ---------------------------------------------------------------------------------------------

function col(name: string, tsType: string, over: Partial<Column> = {}): Column {
  return {
    name,
    tsType,
    dbType: tsType.toUpperCase(),
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  } as Column;
}

function table(name: string, over: Partial<Table> & { columns: Column[] }): Table {
  return { name, tsName: name, unique: [], indexes: [], ...over } as Table;
}

function analysis(tables: Table[], dialect: Analysis['dialect'] = 'postgres'): Analysis {
  return { dialect, tables, enums: [], relations: [], issues: [] };
}

const users = table('users', {
  columns: [col('id', 'number', { hasDefault: true, isGenerated: true }), col('email', 'string')],
  primaryKey: { columns: ['id'] },
});
const books = table('books', {
  columns: [col('isbn', 'string'), col('title', 'string')],
  primaryKey: { columns: ['isbn'] },
});
const counters = table('counters', {
  columns: [col('id', 'bigint'), col('n', 'number')],
  primaryKey: { columns: ['id'] },
});
const snapshots = table('snapshots', {
  columns: [col('at', 'Date'), col('state', 'string')],
  primaryKey: { columns: ['at'] },
});
const states = table('states', {
  columns: [col('kind', 'string', { enumValues: ['draft', 'live'] }), col('note', 'string')],
  primaryKey: { columns: ['kind'] },
});
/** A key column the analyzer could not type: `tsType` is not a name `tsTypeOf` passes through. */
const things = table('things', {
  columns: [col('ref', 'CustomRef'), col('note', 'string')],
  primaryKey: { columns: ['ref'] },
});
const memberships = table('memberships', {
  columns: [col('orgId', 'number'), col('userId', 'string'), col('role', 'string')],
  primaryKey: { columns: ['orgId', 'userId'] },
});
const auditLog = table('audit_log', {
  tsName: 'auditLog',
  columns: [col('at', 'Date'), col('what', 'string')],
});
/** A composite key with a database-generated member, for the mysql throw branch. */
const genPair = table('gen_pair', {
  tsName: 'genPair',
  columns: [col('a', 'number'), col('b', 'number', { isGenerated: true })],
  primaryKey: { columns: ['a', 'b'] },
});

async function emit(
  t: Table,
  opts: {
    dialect?: Analysis['dialect'];
    mode?: 'stub' | 'drizzle';
    injection?: boolean;
  } = {}
): Promise<string> {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-svc-key-'));
  try {
    const gen = new ServiceGenerator(analysis([t], opts.dialect ?? 'postgres'));
    await gen.generate({
      outDir,
      dataAccess: opts.mode ?? 'drizzle',
      ...(opts.mode === 'stub'
        ? {}
        : opts.injection
          ? {
              schemaImportPath: 'src/db/schema',
              databaseInjection: { enabled: true, databaseType: 'Database' },
            }
          : { dbImportPath: 'src/db/connection', schemaImportPath: 'src/db/schema' }),
      format: { enabled: false },
    });
    const file = (await fs.readdir(outDir)).find((f) => f.endsWith('Service.ts'))!;
    return await fs.readFile(path.join(outDir, file), 'utf8');
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
}

describe('single-column keys are typed from the key column', () => {
  it('keeps id: number for an integer key, byte for byte', async () => {
    const text = await emit(users);
    expect(text).toContain('static async getById(id: number): Promise<Selectusers | null> {');
    expect(text).toContain('static async update(id: number, data: Updateusers): Promise<Selectusers> {');
    expect(text).toContain('static async delete(id: number): Promise<boolean> {');
    expect(text).toContain("import { eq } from 'drizzle-orm';");
    expect(text).toContain("Partial<Omit<typeof users.$inferInsert, 'id'>>");
  });

  it('types a varchar key as string, against the real key column', async () => {
    const text = await emit(books);
    expect(text).toContain('static async getById(id: string): Promise<Selectbooks | null> {');
    expect(text).toContain('static async update(id: string, data: Updatebooks): Promise<Selectbooks> {');
    expect(text).toContain('static async delete(id: string): Promise<boolean> {');
    expect(text).toContain('eq(books.isbn, id)');
  });

  it('types bigint, Date and enum keys at their real types', async () => {
    expect(await emit(counters)).toContain('static async getById(id: bigint)');
    expect(await emit(snapshots)).toContain('static async getById(id: Date)');
    expect(await emit(states)).toContain("static async getById(id: 'draft' | 'live')");
  });

  it('falls back to the indexed select type when the analyzer could not type the column', async () => {
    // `Selectthings['ref']` is exact by construction: `Selectthings` is `$inferSelect`, so the
    // parameter has whatever type drizzle infers for the column, and `eq` accepts it.
    const text = await emit(things);
    expect(text).toContain("static async getById(id: Selectthings['ref'])");
    expect(text).toContain('eq(things.ref, id)');
  });

  it('types the stub signatures from the same key column', async () => {
    const text = await emit(books, { mode: 'stub' });
    expect(text).toContain('static async getById(id: string)');
    expect(text).toContain('static async update(id: string, data: Updatebooks)');
    expect(text).toContain('static async delete(id: string)');
    // No select type to index into in stub mode: the honest spelling is unknown.
    expect(await emit(things, { mode: 'stub' })).toContain('static async getById(id: unknown)');
  });
});

describe('a composite key becomes one parameter per key column, in key order', () => {
  it('addresses the row by every key column, not the first one', async () => {
    const text = await emit(memberships);
    expect(text).toContain(
      'static async getById(orgId: number, userId: string): Promise<Selectmemberships | null> {'
    );
    expect(text).toContain(
      'static async update(orgId: number, userId: string, data: Updatememberships): Promise<Selectmemberships> {'
    );
    expect(text).toContain('static async delete(orgId: number, userId: string): Promise<boolean> {');
    expect(text).toContain('and(eq(memberships.orgId, orgId), eq(memberships.userId, userId))');
    expect(text).toContain("import { and, eq } from 'drizzle-orm';");
  });

  it('omits every key column from the update patch, not the first one', async () => {
    const text = await emit(memberships);
    expect(text).toContain("Partial<Omit<typeof memberships.$inferInsert, 'orgId' | 'userId'>>");
  });

  it('keeps the database parameter first in injection mode', async () => {
    const text = await emit(memberships, { injection: true });
    expect(text).toContain('static async getById(db: Database, orgId: number, userId: string)');
    expect(text).toContain('static async update(db: Database, orgId: number, userId: string, data: Updatememberships)');
  });

  it('does the same in stub mode', async () => {
    const text = await emit(memberships, { mode: 'stub' });
    expect(text).toContain('static async getById(orgId: number, userId: string)');
  });
});

describe('a table with no primary key loses the methods that need one', () => {
  it('emits getAll and create only, and no eq import, in drizzle mode', async () => {
    const text = await emit(auditLog);
    expect(text).toContain('static async getAll(');
    expect(text).toContain('static async create(');
    expect(text).not.toContain('getById');
    expect(text).not.toContain('static async update');
    expect(text).not.toContain('static async delete');
    // Nothing addresses a row, so nothing needs eq, and the patch type has no method left to use it.
    expect(text).not.toContain("from 'drizzle-orm'");
    expect(text).not.toContain('type UpdateauditLog');
  });

  it('prunes the stub the same way, including its type imports', async () => {
    const text = await emit(auditLog, { mode: 'stub' });
    expect(text).not.toContain('getById');
    expect(text).not.toContain('UpdateauditLog');
    expect(text).toContain("import type { InsertauditLog, SelectauditLog } from './types/auditLog.js';");
  });
});

describe('the mysql read-back paths carry the same typing', () => {
  it('keeps the single-key $returningId shape, typed from the key', async () => {
    const text = await emit(books, { dialect: 'mysql' });
    expect(text).toContain('static async getById(id: string)');
    expect(text).toContain('$returningId()');
    expect(text).toContain('ids[0] ? ids[0].isbn : (input as Selectbooks).isbn');
  });

  it('reads a composite-keyed row back by every key column from the input', async () => {
    // $returningId() reports nothing for a composite key (measured by the BN change), so the
    // emitted create does not call it: the input already carries every part of the key. The
    // emitted comment may still name it, so the assertion is on the call.
    const text = await emit(memberships, { dialect: 'mysql' });
    expect(text).not.toContain('.$returningId()');
    expect(text).toContain('await db.insert(memberships).values(input);');
    expect(text).toContain('const key = input as Selectmemberships;');
    expect(text).toContain('and(eq(memberships.orgId, key.orgId), eq(memberships.userId, key.userId))');
    expect(text).toContain('static async update(orgId: number, userId: string, data: Updatememberships)');
  });

  it('throws from create when a composite member is database-generated', async () => {
    const text = await emit(genPair, { dialect: 'mysql' });
    expect(text).toContain('database-generated');
    expect(text).toContain('genPair.b');
    expect(text).not.toContain('$returningId');
  });

  it('throws from create for a keyless table instead of inventing a read-back', async () => {
    const text = await emit(auditLog, { dialect: 'mysql' });
    expect(text).not.toContain('getById');
    expect(text).not.toContain('$returningId');
    expect(text).toContain('has no primary key');
    expect(text).toContain('throw new Error');
  });
});

// ---------------------------------------------------------------------------------------------
// End to end: a real schema through the real analyzer, compiled against a REAL typed database
// object with strict nodenext tsc, on both drizzle majors. This is the leg the packed gate's
// `db = {} as any` fixture could never exercise, which is how BP stayed invisible.
// ---------------------------------------------------------------------------------------------

const PG_SCHEMA = `import { pgTable, serial, integer, text, primaryKey } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
});
export const books = pgTable('books', {
  isbn: text('isbn').primaryKey(),
  title: text('title').notNull(),
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

const SQLITE_SCHEMA = `import { sqliteTable, integer, text, primaryKey } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull(),
});
export const books = sqliteTable('books', {
  isbn: text('isbn').primaryKey(),
  title: text('title').notNull(),
});
export const memberships = sqliteTable(
  'memberships',
  {
    orgId: integer('org_id').notNull(),
    userId: text('user_id').notNull(),
    role: text('role').notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })]
);
export const logs = sqliteTable('logs', {
  at: integer('at').notNull(),
  what: text('what').notNull(),
});
`;

/**
 * A driverless typed database object per dialect, the BM gate-stage shape. The two majors
 * disagree about the pg type's name and arity: 0.45.x exports `PgDatabase<HKT, Schema, Rels>`
 * and 1.0.0-rc.4 renamed the async side to `PgAsyncDatabase<HKT, Rels?>`, so the module is
 * chosen per major. `BetterSQLite3Database` exists on both.
 */
const DB_MODULES: Record<string, string> = {
  'pg-drizzle-orm':
    "import type { PgDatabase } from 'drizzle-orm/pg-core';\nexport const db = null as unknown as PgDatabase<any, any, any>;\n",
  'pg-drizzle-orm-v1':
    "import type { PgAsyncDatabase } from 'drizzle-orm/pg-core';\nexport const db = null as unknown as PgAsyncDatabase<any>;\n",
  'sqlite-drizzle-orm':
    "import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';\nexport const db = null as unknown as BetterSQLite3Database;\n",
  'sqlite-drizzle-orm-v1':
    "import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';\nexport const db = null as unknown as BetterSQLite3Database;\n",
};
const INJECTION: Record<string, { databaseType: string; databaseTypeImport: { name: string; from: string } }> = {
  'pg-drizzle-orm': {
    databaseType: 'PgDatabase<any, any, any>',
    databaseTypeImport: { name: 'PgDatabase', from: 'drizzle-orm/pg-core' },
  },
  'pg-drizzle-orm-v1': {
    databaseType: 'PgAsyncDatabase<any>',
    databaseTypeImport: { name: 'PgAsyncDatabase', from: 'drizzle-orm/pg-core' },
  },
  'sqlite-drizzle-orm': {
    databaseType: 'BetterSQLite3Database',
    databaseTypeImport: { name: 'BetterSQLite3Database', from: 'drizzle-orm/better-sqlite3' },
  },
  'sqlite-drizzle-orm-v1': {
    databaseType: 'BetterSQLite3Database',
    databaseTypeImport: { name: 'BetterSQLite3Database', from: 'drizzle-orm/better-sqlite3' },
  },
};

interface Tree {
  dir: string;
  compileOut: string;
}

async function buildTree(
  name: string,
  majorPkg: string,
  kind: 'pg' | 'sqlite',
  schemaText: string
): Promise<Tree> {
  const dir = path.join(ROOT, name);
  await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
  const link = path.join(dir, 'node_modules', 'drizzle-orm');
  await fs.rm(link, { recursive: true, force: true });
  await fs.symlink(path.join(pkgRoot, 'node_modules', majorPkg), link, 'dir');
  await fs.writeFile(path.join(dir, 'package.json'), '{"name":"probe","private":true,"type":"module"}');
  await fs.writeFile(path.join(dir, 'schema.ts'), schemaText);
  await fs.writeFile(path.join(dir, 'db.ts'), DB_MODULES[`${kind}-${majorPkg}`]);

  const a = await new SchemaAnalyzer(rel(path.join(dir, 'schema.ts'))).analyze({});
  expect(a.tables.length, `no tables analyzed: ${JSON.stringify(a.issues)}`).toBe(4);

  const flavor = `${kind}-${majorPkg}`;
  const gen = new ServiceGenerator(a);
  await gen.generate({
    outDir: rel(path.join(dir, 'services')),
    dataAccess: 'drizzle',
    dbImportPath: rel(path.join(dir, 'db')),
    schemaImportPath: rel(path.join(dir, 'schema')),
    importExtension: 'js',
  });
  await gen.generate({
    outDir: rel(path.join(dir, 'services-injection')),
    dataAccess: 'drizzle',
    schemaImportPath: rel(path.join(dir, 'schema')),
    databaseInjection: { enabled: true, ...INJECTION[flavor] },
    importExtension: 'js',
  });
  await gen.generate({
    outDir: rel(path.join(dir, 'services-run')),
    dataAccess: 'drizzle',
    schemaImportPath: rel(path.join(dir, 'schema')),
    databaseInjection: { enabled: true, ...INJECTION[flavor] },
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
      include: ['schema.ts', 'db.ts', 'services/**/*.ts', 'services-injection/**/*.ts'],
    })
  );
  let compileOut = '';
  try {
    execFileSync(tsc, ['-p', path.join(dir, 'tsconfig.json')], { cwd: dir, stdio: 'pipe' });
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer };
    compileOut = `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`;
  }
  return { dir, compileOut };
}

let pg045: Tree;
let pg1: Tree;
let sq045: Tree;
let sq1: Tree;

beforeAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
  pg045 = await buildTree('pg-v045', 'drizzle-orm', 'pg', PG_SCHEMA);
  pg1 = await buildTree('pg-v1', 'drizzle-orm-v1', 'pg', PG_SCHEMA);
  sq045 = await buildTree('sqlite-v045', 'drizzle-orm', 'sqlite', SQLITE_SCHEMA);
  sq1 = await buildTree('sqlite-v1', 'drizzle-orm-v1', 'sqlite', SQLITE_SCHEMA);
}, 300_000);

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe.each([
  ['pg on drizzle-orm 0.45.2', () => pg045],
  ['pg on drizzle-orm 1.0.0-rc.4', () => pg1],
  ['sqlite on drizzle-orm 0.45.2', () => sq045],
  ['sqlite on drizzle-orm 1.0.0-rc.4', () => sq1],
])('%s', (_label, tree) => {
  it('compiles natural, composite and keyless tables against a real typed db', () => {
    expect(tree().compileOut).toBe('');
  });
});

describe('runtime against a real better-sqlite3', () => {
  it.each([
    ['0.45.2', () => sq045],
    ['1.0.0-rc.4', () => sq1],
  ])(
    'addresses rows by their real keys on drizzle-orm %s',
    async (label, tree) => {
      const { default: Database } = await import('better-sqlite3');
      const sqlite = new Database(':memory:');
      sqlite.exec('CREATE TABLE books (isbn text PRIMARY KEY, title text NOT NULL)');
      sqlite.exec(
        'CREATE TABLE memberships (org_id integer NOT NULL, user_id text NOT NULL, role text NOT NULL, PRIMARY KEY (org_id, user_id))'
      );
      sqlite.exec('CREATE TABLE logs (at integer NOT NULL, what text NOT NULL)');
      let db: unknown;
      if (label === '0.45.2') {
        const { drizzle } = await import('drizzle-orm/better-sqlite3');
        db = drizzle(sqlite);
      } else {
        const { drizzle } = await import('drizzle-orm-v1/better-sqlite3');
        db = drizzle({ client: sqlite });
      }
      try {
        const svc = (name: string) => import(path.join(tree().dir, 'services-run', name));
        const { BookService } = await svc('bookService.ts');
        const { MembershipService } = await svc('membershipService.ts');
        const { LogService } = await svc('logService.ts');

        // A supplied string key: create returns the row, and the row is addressable by it.
        const created = await BookService.create(db, { isbn: '978-3', title: 'SICP' });
        expect(created, label).toEqual({ isbn: '978-3', title: 'SICP' });
        expect(await BookService.getById(db, '978-3'), label).toEqual(created);
        const renamed = await BookService.update(db, '978-3', { title: 'SICP 2e' });
        expect(renamed, label).toEqual({ isbn: '978-3', title: 'SICP 2e' });
        expect(await BookService.delete(db, '978-3'), label).toBe(true);
        expect(await BookService.getById(db, '978-3'), label).toBeNull();

        // Two rows sharing the first key column: the full key must tell them apart. Under the
        // defect every method addressed by orgId alone, so getById returned an arbitrary
        // sibling and update/delete hit both rows.
        await MembershipService.create(db, { orgId: 1, userId: 'a', role: 'admin' });
        await MembershipService.create(db, { orgId: 1, userId: 'b', role: 'viewer' });
        expect(await MembershipService.getById(db, 1, 'b'), label).toEqual({
          orgId: 1,
          userId: 'b',
          role: 'viewer',
        });
        const promoted = await MembershipService.update(db, 1, 'b', { role: 'editor' });
        expect(promoted, label).toEqual({ orgId: 1, userId: 'b', role: 'editor' });
        expect(await MembershipService.getById(db, 1, 'a'), label).toEqual({
          orgId: 1,
          userId: 'a',
          role: 'admin',
        });
        expect(await MembershipService.delete(db, 1, 'a'), label).toBe(true);
        expect(await MembershipService.getById(db, 1, 'a'), label).toBeNull();
        expect(await MembershipService.getById(db, 1, 'b'), label).not.toBeNull();

        // Keyless: the class carries no addressing methods at all, and create still returns
        // the created row because sqlite has RETURNING.
        expect(LogService.getById, label).toBeUndefined();
        expect(LogService.update, label).toBeUndefined();
        expect(LogService.delete, label).toBeUndefined();
        const logged = await LogService.create(db, { at: 7, what: 'boot' });
        expect(logged, label).toEqual({ at: 7, what: 'boot' });
        expect(await LogService.getAll(db), label).toHaveLength(1);
      } finally {
        sqlite.close();
      }
    },
    60_000
  );
});
