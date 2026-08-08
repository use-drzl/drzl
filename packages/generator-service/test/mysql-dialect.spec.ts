/**
 * The MySQL emission, end to end: a real drizzle mysql schema through the real analyzer and the
 * real service generator, with the emitted tree compiled by a real tsc against both drizzle
 * majors and, when MYSQL_URL names a server, run against a real MySQL.
 *
 * The defect this pins (plan addendum BN): `dataAccess: 'drizzle'` emitted `.returning()`
 * unconditionally, and drizzle's MySQL insert/update/delete builders have no such method on
 * either major (measured: `typeof builder.returning === 'undefined'` on 0.45.2 and 1.0.0-rc.4),
 * so the emitted service failed tsc against every MySQL schema. The whole dialect was unusable.
 *
 * The dialect comes from the analysis, which records it from drizzle's own entityKind marks.
 * Nothing here sniffs class names.
 *
 * What replaces `.returning()` is what the dialect really offers, measured on MySQL 8.4.11
 * through mysql2 on both majors:
 *
 *   - insert:  `$returningId()` reports `[{ <pk>: v }]` per row for an AUTO_INCREMENT pk and
 *     for a `$defaultFn` pk. For a caller-supplied pk and for a composite pk it reports `[]`,
 *     and the input already carries the key, so the emitted create falls back to it. Either
 *     way the created row is then read back by that key.
 *   - update:  awaiting the builder yields `[ResultSetHeader, undefined]` (affectedRows and
 *     friends), never the row, so the emitted update writes and then reads the row back.
 *   - delete:  unchanged; the service never used RETURNING on delete for any dialect.
 *
 * Plan addendum BP extended this file's schema with a varchar key, a keyless table and the
 * composite disambiguation checks: the read-back paths above must carry the key at its real
 * type (a supplied string key comes back by that string), a composite key must address by
 * every column, and a keyless table has nothing to read a created row back by, so its create
 * throws with an explanation the same way a database-generated key's does.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SchemaAnalyzer } from '@drzl/analyzer';
import type { Analysis } from '@drzl/analyzer';
import { ServiceGenerator } from '../src';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const ROOT = path.join(pkgRoot, 'test', '.tmp-mysql-dialect');
const tsc = path.join(pkgRoot, 'node_modules', '.bin', 'tsc');
const MYSQL_URL = process.env.MYSQL_URL;

if (!MYSQL_URL) {
  console.warn(
    '[mysql-dialect.spec] MYSQL_URL is not set: the runtime stage is SKIPPED. ' +
      'The emit and compile stages still ran. CI provides a server; locally: ' +
      'docker run -d --rm -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=d -p 33061:3306 mysql:8.4 ' +
      'and export MYSQL_URL=mysql://root:root@127.0.0.1:33061/d'
  );
}

/**
 * Every pk flavor the emission branches on. Table names are prefixed so the CI database,
 * which other stages share, cannot collide; the ts names stay plain so the emitted service
 * names read naturally (users -> UserService).
 */
const MYSQL_SCHEMA = `import { mysqlTable, int, varchar, primaryKey } from 'drizzle-orm/mysql-core';
import { sql } from 'drizzle-orm';

export const users = mysqlTable('svc_users', {
  id: int('id').autoincrement().primaryKey(),
  email: varchar('email', { length: 190 }).notNull(),
  nickname: varchar('nickname', { length: 50 }),
});

export const codes = mysqlTable('svc_codes', {
  code: int('code').primaryKey(),
  label: varchar('label', { length: 50 }).notNull(),
});

export const widgets = mysqlTable('svc_widgets', {
  id: int('id').primaryKey().$defaultFn(() => Math.trunc(Math.random() * 1e9)),
  name: varchar('name', { length: 50 }).notNull(),
});

export const pairs = mysqlTable(
  'svc_pairs',
  {
    a: int('a').notNull(),
    b: int('b').notNull(),
    note: varchar('note', { length: 20 }),
  },
  (t) => [primaryKey({ columns: [t.a, t.b] })]
);

export const gen = mysqlTable('svc_gen', {
  a: int('a').notNull(),
  b: int('b').generatedAlwaysAs(sql\`a * 2\`, { mode: 'stored' }).primaryKey(),
});

export const books = mysqlTable('svc_books', {
  isbn: varchar('isbn', { length: 20 }).primaryKey(),
  title: varchar('title', { length: 100 }).notNull(),
});

export const logs = mysqlTable('svc_logs', {
  at: int('at').notNull(),
  what: varchar('what', { length: 50 }).notNull(),
});
`;

const PG_SCHEMA = `import { pgTable, serial, text } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
  nickname: text('nickname'),
});
`;

interface Tree {
  dir: string;
  analysis: Analysis;
  compileOut: string;
  /** emitted text by relative path, e.g. 'services-injection/userService.ts' */
  texts: Record<string, string>;
}

const rel = (p: string) => path.relative(process.cwd(), p);

async function readTexts(dir: string, sub: string, out: Record<string, string>) {
  for (const f of await fs.readdir(path.join(dir, sub))) {
    if (!f.endsWith('.ts')) continue;
    out[`${sub}/${f}`] = await fs.readFile(path.join(dir, sub, f), 'utf8');
  }
}

/**
 * A tree whose bare `drizzle-orm` is one specific major, the way a consumer's project has one:
 * a node_modules with a single `drizzle-orm` entry, symlinked to this package's copy of that
 * major. tsc, the analyzer and vitest all resolve upward from the file, so schema, emitted
 * services and the compiler agree on the major without any import rewriting.
 */
async function buildTree(name: string, majorPkg: string): Promise<Tree> {
  const dir = path.join(ROOT, name);
  await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
  const link = path.join(dir, 'node_modules', 'drizzle-orm');
  await fs.rm(link, { recursive: true, force: true });
  await fs.symlink(path.join(pkgRoot, 'node_modules', majorPkg), link, 'dir');
  await fs.writeFile(path.join(dir, 'package.json'), '{"name":"probe","private":true,"type":"module"}');
  await fs.writeFile(path.join(dir, 'schema.ts'), MYSQL_SCHEMA);
  // Traditional mode imports a project db module; a typed one, so the compile stage actually
  // checks the builder calls instead of collapsing everything to any.
  await fs.writeFile(
    path.join(dir, 'db.ts'),
    "import type { MySql2Database } from 'drizzle-orm/mysql2';\nexport const db = null as unknown as MySql2Database;\n"
  );

  const analysis = await new SchemaAnalyzer(rel(path.join(dir, 'schema.ts'))).analyze({});
  expect(analysis.tables.length, `no tables analyzed: ${JSON.stringify(analysis.issues)}`).toBe(7);

  const gen = new ServiceGenerator(analysis);
  await gen.generate({
    outDir: rel(path.join(dir, 'services')),
    dataAccess: 'drizzle',
    dbImportPath: rel(path.join(dir, 'db')),
    schemaImportPath: rel(path.join(dir, 'schema')),
    importExtension: 'js',
  });
  const injection = {
    enabled: true,
    databaseType: 'MySql2Database',
    databaseTypeImport: { name: 'MySql2Database', from: 'drizzle-orm/mysql2' },
  };
  await gen.generate({
    outDir: rel(path.join(dir, 'services-injection')),
    dataAccess: 'drizzle',
    schemaImportPath: rel(path.join(dir, 'schema')),
    databaseInjection: injection,
    importExtension: 'js',
  });
  // The tree the runtime stage imports: same emission, extensionless specifiers, because the
  // compile tree's `.js` specifiers name files that only exist as `.ts` here.
  await gen.generate({
    outDir: rel(path.join(dir, 'services-run')),
    dataAccess: 'drizzle',
    schemaImportPath: rel(path.join(dir, 'schema')),
    databaseInjection: injection,
    importExtension: 'none',
  });

  const texts: Record<string, string> = {};
  await readTexts(dir, 'services', texts);
  await readTexts(dir, 'services-injection', texts);

  await fs.writeFile(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'es2022',
          module: 'nodenext',
          moduleResolution: 'nodenext',
          skipLibCheck: true,
        },
        include: ['schema.ts', 'db.ts', 'services/**/*.ts', 'services-injection/**/*.ts'],
      },
      null,
      2
    )
  );

  let compileOut = '';
  try {
    execFileSync(tsc, ['-p', path.join(dir, 'tsconfig.json')], { cwd: dir, stdio: 'pipe' });
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer };
    compileOut = `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`;
  }
  return { dir, analysis, compileOut, texts };
}

let v045: Tree;
let v1: Tree;
let pgTexts: Record<string, string> = {};

beforeAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
  v045 = await buildTree('v045', 'drizzle-orm');
  v1 = await buildTree('v1', 'drizzle-orm-v1');

  // The pg control, generated in the same run: the fix must not move a byte of it. Text-level
  // here; the packed gate compiles pg emission against a real consumer install.
  const pgDir = path.join(v045.dir, 'pg');
  await fs.mkdir(pgDir, { recursive: true });
  await fs.writeFile(path.join(pgDir, 'schema.ts'), PG_SCHEMA);
  const pgAnalysis = await new SchemaAnalyzer(rel(path.join(pgDir, 'schema.ts'))).analyze({});
  expect(pgAnalysis.dialect).toBe('postgres');
  await new ServiceGenerator(pgAnalysis).generate({
    outDir: rel(path.join(pgDir, 'services')),
    dataAccess: 'drizzle',
    dbImportPath: rel(path.join(pgDir, 'db')),
    schemaImportPath: rel(path.join(pgDir, 'schema')),
    importExtension: 'js',
  });
  pgTexts = {};
  await readTexts(pgDir, 'services', pgTexts);
}, 300_000);

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('the analysis carries the dialect the emission keys on', () => {
  it('has a tsc to run', () => {
    expect(existsSync(tsc), `no tsc at ${tsc}; run pnpm install`).toBe(true);
  });

  it('records mysql for a mysql schema, on both majors', () => {
    expect(v045.analysis.dialect).toBe('mysql');
    expect(v1.analysis.dialect).toBe('mysql');
  });
});

describe.each([
  ['0.45.2', () => v045],
  ['1.0.0-rc.4', () => v1],
])('emitted mysql services on drizzle-orm %s', (_label, tree) => {
  it('compiles under the tsconfig the packed gate constructs for documented configs', () => {
    expect(tree().compileOut).toBe('');
  });

  it('never calls .returning(), which this dialect does not have', () => {
    for (const [file, text] of Object.entries(tree().texts)) {
      expect(text.includes('.returning('), `${file} still calls .returning()`).toBe(false);
    }
  });

  it('reads the created row back via $returningId with the input key as fallback', () => {
    for (const sub of ['services', 'services-injection']) {
      const create = tree().texts[`${sub}/userService.ts`];
      expect(create).toContain('$returningId()');
      expect(create).toContain('ids[0] ? ids[0].id : (input as Selectusers).id');
    }
  });

  it('update writes and then reads the row back by its key', () => {
    const text = tree().texts['services-injection/userService.ts'];
    expect(text).toMatch(/update\(users\)\s*\.set\(data\)/);
    // the re-select that replaces RETURNING on this dialect
    const updateBody = text.slice(text.indexOf('static async update'));
    expect(updateBody).toContain('.select().from(users)');
  });

  it('create on a database-generated pk says so instead of emitting a lie', () => {
    const text = tree().texts['services-injection/genService.ts'];
    expect(text).toContain('database-generated');
    expect(text).not.toContain('$returningId');
  });

  it('types a varchar key as string on every method, including the read-back fallback', () => {
    for (const sub of ['services', 'services-injection']) {
      const text = tree().texts[`${sub}/bookService.ts`];
      expect(text).toContain('id: string');
      expect(text).not.toContain('id: number');
      expect(text).toContain('ids[0] ? ids[0].isbn : (input as Selectbooks).isbn');
    }
  });

  it('addresses a composite key by every column and reads create back from the input key', () => {
    const text = tree().texts['services-injection/pairService.ts'];
    expect(text).toContain('static async getById(db: MySql2Database, a: number, b: number)');
    expect(text).toContain('and(eq(pairs.a, a), eq(pairs.b, b))');
    // $returningId() reports nothing for a composite key (measured above), so create does not
    // call it: the input already carries every part of the key. The emitted comment may still
    // name it, so the assertion is on the call.
    expect(text).not.toContain('.$returningId()');
    expect(text).toContain('and(eq(pairs.a, key.a), eq(pairs.b, key.b))');
    expect(text).toContain("Partial<Omit<typeof pairs.$inferInsert, 'a' | 'b'>>");
  });

  it('drops the addressing methods for a keyless table and throws from its create', () => {
    const text = tree().texts['services-injection/logService.ts'];
    expect(text).not.toContain('getById');
    expect(text).not.toContain('static async update');
    expect(text).not.toContain('static async delete');
    expect(text).toContain('has no primary key');
    expect(text).not.toContain("from 'drizzle-orm'");
  });
});

describe('the compiler would have said so', () => {
  it('reports the exact defect class when .returning() is planted back in', async () => {
    const dir = v045.dir;
    await fs.writeFile(
      path.join(dir, 'canary.ts'),
      `import { users } from './schema.js';
import type { MySql2Database } from 'drizzle-orm/mysql2';
declare const db: MySql2Database;
export const bad = () => db.insert(users).values({ email: 'x' }).returning();
`
    );
    await fs.writeFile(
      path.join(dir, 'tsconfig.canary.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'es2022',
          module: 'nodenext',
          moduleResolution: 'nodenext',
          skipLibCheck: true,
        },
        include: ['schema.ts', 'canary.ts'],
      })
    );
    let out = '';
    try {
      execFileSync(tsc, ['-p', path.join(dir, 'tsconfig.canary.json')], { cwd: dir, stdio: 'pipe' });
    } catch (e) {
      const err = e as { stdout?: Buffer; stderr?: Buffer };
      out = `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`;
    }
    expect(out).toContain('returning');
    // TS2551 when the checker can suggest $returningId, TS2339 when it cannot.
    expect(out).toMatch(/TS2551|TS2339/);
  }, 120_000);
});

describe('the pg emission is not touched by any of this', () => {
  it('still returns rows through RETURNING and never mentions $returningId', () => {
    const text = pgTexts['services/userService.ts'];
    expect(text).toBeTruthy();
    expect(text.match(/\.returning\(\)/g)?.length).toBe(2);
    expect(text).not.toContain('$returningId');
  });
});

describe.skipIf(!MYSQL_URL)('runtime against a real MySQL', () => {
  it(
    'create returns the created row, update the updated one, delete true; both majors',
    async () => {
      const mysql = await import('mysql2/promise');
      const raw = await mysql.createConnection(MYSQL_URL!);
      const [[ver]] = (await raw.query('SELECT VERSION() AS v')) as unknown as [[{ v: string }]];
      console.log(`[mysql-dialect.spec] runtime stage against MySQL ${ver.v}`);

      const cleanups: Array<() => Promise<void> | void> = [() => raw.end()];
      try {
        for (const [label, tree] of [
          ['0.45.2', v045],
          ['1.0.0-rc.4', v1],
        ] as const) {
          for (const t of ['svc_users', 'svc_codes', 'svc_widgets', 'svc_pairs', 'svc_books', 'svc_logs']) {
            await raw.query(`DROP TABLE IF EXISTS ${t}`);
          }
          await raw.query(
            'CREATE TABLE svc_users (id int NOT NULL AUTO_INCREMENT PRIMARY KEY, email varchar(190) NOT NULL, nickname varchar(50) NULL)'
          );
          await raw.query('CREATE TABLE svc_codes (code int NOT NULL PRIMARY KEY, label varchar(50) NOT NULL)');
          await raw.query('CREATE TABLE svc_widgets (id int NOT NULL PRIMARY KEY, name varchar(50) NOT NULL)');
          await raw.query(
            'CREATE TABLE svc_pairs (a int NOT NULL, b int NOT NULL, note varchar(20) NULL, PRIMARY KEY (a, b))'
          );
          await raw.query(
            'CREATE TABLE svc_books (isbn varchar(20) NOT NULL PRIMARY KEY, title varchar(100) NOT NULL)'
          );
          await raw.query('CREATE TABLE svc_logs (at int NOT NULL, what varchar(50) NOT NULL)');

          let db: unknown;
          if (label === '0.45.2') {
            const { drizzle } = await import('drizzle-orm/mysql2');
            db = drizzle(raw);
          } else {
            const { createPool } = await import('mysql2');
            const pool = createPool(MYSQL_URL!);
            cleanups.push(() => new Promise<void>((res) => pool.end(() => res())));
            const { drizzle } = await import('drizzle-orm-v1/mysql2');
            db = drizzle({ client: pool });
          }

          const svc = (name: string) => import(path.join(tree.dir, 'services-run', name));
          const { UserService } = await svc('userService.ts');
          const { CodeService } = await svc('codeService.ts');
          const { WidgetService } = await svc('widgetService.ts');
          const { PairService } = await svc('pairService.ts');
          const { BookService } = await svc('bookService.ts');
          const { LogService } = await svc('logService.ts');

          // AUTO_INCREMENT pk: the database supplies the key and create hands the row back.
          const created = await UserService.create(db, { email: 'ada@x.io' });
          expect(created, label).toEqual({ id: 1, email: 'ada@x.io', nickname: null });
          const second = await UserService.create(db, { email: 'lin@x.io', nickname: 'Lin' });
          expect(second, label).toEqual({ id: 2, email: 'lin@x.io', nickname: 'Lin' });

          const updated = await UserService.update(db, 1, { nickname: 'Ada' });
          expect(updated, label).toEqual({ id: 1, email: 'ada@x.io', nickname: 'Ada' });
          // A missing id updates nothing and reads nothing back: the same undefined the pg
          // emission produces from rows[0] of an empty RETURNING.
          expect(await UserService.update(db, 9999, { nickname: 'X' }), label).toBeUndefined();

          expect(await UserService.getById(db, 1), label).toEqual({
            id: 1,
            email: 'ada@x.io',
            nickname: 'Ada',
          });
          expect(await UserService.getById(db, 9999), label).toBeNull();
          expect(await UserService.getAll(db), label).toHaveLength(2);

          expect(await UserService.delete(db, 2), label).toBe(true);
          expect(await UserService.getById(db, 2), label).toBeNull();
          expect(await UserService.delete(db, 9999), label).toBe(true);

          // Caller-supplied pk: $returningId reports nothing and the input key addresses the row.
          const code = await CodeService.create(db, { code: 7, label: 'seven' });
          expect(code, label).toEqual({ code: 7, label: 'seven' });

          // $defaultFn pk: drizzle generates the key client-side and reports it.
          const widget = await WidgetService.create(db, { name: 'sprocket' });
          expect(widget.name, label).toBe('sprocket');
          expect(typeof widget.id, label).toBe('number');
          expect(await WidgetService.getById(db, widget.id), label).toEqual(widget);

          // Composite pk: create reads the row back by every key column from the input, and the
          // full key is what tells two rows sharing a first column apart. Under the BP defect all
          // of these addressed by `a` alone, so getById returned an arbitrary sibling and
          // update hit both rows.
          const pair = await PairService.create(db, { a: 1, b: 2, note: 'n' });
          expect(pair, label).toEqual({ a: 1, b: 2, note: 'n' });
          const sibling = await PairService.create(db, { a: 1, b: 3, note: 'm' });
          expect(sibling, label).toEqual({ a: 1, b: 3, note: 'm' });
          expect(await PairService.getById(db, 1, 3), label).toEqual(sibling);
          const patched = await PairService.update(db, 1, 3, { note: 'z' });
          expect(patched, label).toEqual({ a: 1, b: 3, note: 'z' });
          expect(await PairService.getById(db, 1, 2), label).toEqual({ a: 1, b: 2, note: 'n' });
          expect(await PairService.delete(db, 1, 2), label).toBe(true);
          expect(await PairService.getById(db, 1, 2), label).toBeNull();
          expect(await PairService.getById(db, 1, 3), label).not.toBeNull();

          // A supplied string key: create returns the row by that key, typed as the string it is.
          const book = await BookService.create(db, { isbn: '978-3', title: 'SICP' });
          expect(book, label).toEqual({ isbn: '978-3', title: 'SICP' });
          expect(await BookService.getById(db, '978-3'), label).toEqual(book);
          const retitled = await BookService.update(db, '978-3', { title: 'SICP 2e' });
          expect(retitled, label).toEqual({ isbn: '978-3', title: 'SICP 2e' });
          expect(await BookService.delete(db, '978-3'), label).toBe(true);
          expect(await BookService.getById(db, '978-3'), label).toBeNull();

          // Keyless: nothing addresses a row and mysql cannot read a created one back, so the
          // class has no addressing methods and its create says why it cannot resolve.
          expect(LogService.getById, label).toBeUndefined();
          await expect(LogService.create(db, { at: 7, what: 'boot' }), label).rejects.toThrow(
            /no primary key/
          );
        }
      } finally {
        for (const c of cleanups.reverse()) await c();
      }
    },
    120_000
  );
});
