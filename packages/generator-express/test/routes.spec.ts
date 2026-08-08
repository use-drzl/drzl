/**
 * Which routes exist for which table shape, and what addresses a row.
 *
 * The design decisions are `@drzl/generator-hono`'s, which took them from the tRPC generator: the
 * key comes off the table's real `primaryKey` at its real types, a keyless table loses the
 * addressed routes rather than gaining a fictional `id`, and a read-only table loses every write.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ExpressGenerator } from '../src';
import {
  activeUsers,
  analysis,
  auditLog,
  books,
  dailyTotals,
  memberships,
  posts,
  users,
} from './fixtures';
import type { Table } from '@drzl/analyzer';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const workRoot = path.join(pkgRoot, 'test', 'tmp', 'routes');

afterAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
});

let n = 0;
async function emit(tables: Table[], opts: Record<string, unknown> = {}) {
  const dir = path.join(workRoot, `case-${n++}`);
  await fs.rm(dir, { recursive: true, force: true });
  const { files } = await new ExpressGenerator(analysis(tables)).generate({
    outputDir: dir,
    ...opts,
  } as never);
  const read = async (name: string) => fs.readFile(path.join(dir, name), 'utf8');
  return { dir, files, read };
}

/**
 * Every `.method('path'` pair in a route module, in emitted order.
 *
 * Not anchored to the start of a line, for the reason the Hono spec records: prettier wraps a
 * call with several arguments across lines, and an anchored pattern then reads a generator that
 * never emitted the route.
 */
function routesOf(source: string): string[] {
  return [...source.matchAll(/\.(get|post|patch|delete)\(\s*'([^']*)'/g)].map(
    (m) => `${m[1].toUpperCase()} ${m[2]}`
  );
}

describe('a table with a serial primary key', () => {
  it('gets the whole CRUD surface, addressed by the real key column', async () => {
    const { read } = await emit([users]);
    expect(routesOf(await read('users.ts'))).toEqual([
      'GET /',
      'GET /:id',
      'POST /',
      'PATCH /:id',
      'DELETE /:id',
    ]);
  });

  it('types the enum column as its members, not as a bare string', async () => {
    const { read } = await emit([users]);
    expect(await read('users.ts')).toContain(`z.enum(['admin', 'member'] as const)`);
  });
});

describe('a table with a non-numeric primary key', () => {
  it('addresses it by its own column name, not by a fabricated id', async () => {
    const { read } = await emit([books]);
    const source = await read('books.ts');
    expect(routesOf(source)).toEqual([
      'GET /',
      'GET /:isbn',
      'POST /',
      'PATCH /:isbn',
      'DELETE /:isbn',
    ]);
    expect(source).not.toMatch(/\bid\b/);
  });

  it('does not try to turn the segment into a number', async () => {
    const { read } = await emit([books]);
    expect(await read('books.ts')).toMatch(/BooksParamsSchema = z\.object\(\{ isbn: z\.string\(\)/);
  });
});

describe('a table with a composite primary key', () => {
  it('puts every column of the key in the path', async () => {
    const { read } = await emit([memberships]);
    expect(routesOf(await read('memberships.ts'))).toEqual([
      'GET /',
      'GET /:orgId/:userId',
      'POST /',
      'PATCH /:orgId/:userId',
      'DELETE /:orgId/:userId',
    ]);
  });
});

describe('a table with no primary key', () => {
  it('loses every route that would have addressed a row, and keeps the rest', async () => {
    const { read } = await emit([auditLog]);
    const source = await read('auditLog.ts');
    expect(routesOf(source)).toEqual(['GET /', 'POST /']);
  });

  it('invents no id column anywhere in the module', async () => {
    const { read } = await emit([auditLog]);
    expect(await read('auditLog.ts')).not.toMatch(/\bid\b/);
  });

  it('declares no params schema, because nothing addresses a row', async () => {
    const { read } = await emit([auditLog]);
    expect(await read('auditLog.ts')).not.toContain('ParamsSchema');
  });
});

describe('a read-only table', () => {
  it('keeps its addressed read and loses every write', async () => {
    const { read } = await emit([activeUsers]);
    expect(routesOf(await read('activeUsers.ts'))).toEqual(['GET /', 'GET /:id']);
  });

  it('declares neither an insert nor an update schema', async () => {
    const { read } = await emit([activeUsers]);
    const source = await read('activeUsers.ts');
    expect(source).not.toContain('InsertactiveUsersSchema');
    expect(source).not.toContain('UpdateactiveUsersSchema');
  });

  it('is left with a single route when it is also keyless', async () => {
    const { read } = await emit([dailyTotals]);
    expect(routesOf(await read('dailyTotals.ts'))).toEqual(['GET /']);
  });
});

describe('relation lookups', () => {
  it('are absent unless asked for', async () => {
    const { read } = await emit([posts]);
    expect(await read('posts.ts')).not.toContain('by-authorId');
  });

  it('take a literal prefix, so they cannot shadow the primary-key route', async () => {
    const { read } = await emit([posts], { includeRelations: true });
    const found = routesOf(await read('posts.ts'));
    expect(found).toContain('GET /by-author-id/:authorId');
    expect(found.filter((r) => /^GET \/:[^/]+$/.test(r))).toEqual(['GET /:id']);
  });
});

describe('the body parser', () => {
  it('is mounted per write route, so a router works mounted into any app', async () => {
    // Express does not parse JSON bodies by default, and the barrel's app is not the only place
    // these routers can be mounted: they are exported one per table precisely so a consumer can
    // mount one into an app of their own. An app-level `app.use(json())` would leave that consumer
    // validating `undefined`.
    const { read } = await emit([users]);
    const source = await read('users.ts');
    expect(source).toMatch(/\.post\(\s*'\/',\s*json\(\)/);
    expect(source).toMatch(
      /\.patch\(\s*'\/:id',\s*validate\('params', UsersParamsSchema\),\s*json\(\),\s*validate\('body', UpdateusersSchema\)/
    );
  });

  it('is absent from routes that read no body', async () => {
    const { read } = await emit([activeUsers]);
    expect(await read('activeUsers.ts')).not.toContain('json()');
  });
});

describe('the emitted file set', () => {
  it('is one module per table, the middleware, then the barrel, in that order', async () => {
    const { files, dir } = await emit([users, posts]);
    expect(files.map((f) => path.relative(dir, f))).toEqual([
      'users.ts',
      'posts.ts',
      'validation.ts',
      'index.ts',
    ]);
  });

  it('emits no middleware module when nothing validates', async () => {
    // The read-only keyless table has one route and it takes no input, so a validation.ts would
    // be a file nothing imports.
    const { files, dir } = await emit([dailyTotals]);
    expect(files.map((f) => path.relative(dir, f))).toEqual(['dailyTotals.ts', 'index.ts']);
  });

  it('mounts every table under its own path and re-exports the modules', async () => {
    const { read } = await emit([users, auditLog]);
    const barrel = await read('index.ts');
    expect(barrel).toContain(`app.use('/users', usersRoutes);`);
    expect(barrel).toContain(`app.use('/auditLog', auditLogRoutes);`);
    expect(barrel).toContain(`export * from './users.js';`);
  });

  it('takes a kebab mount path from procedureCase, which a URL can carry', async () => {
    const { read } = await emit([auditLog], { naming: { procedureCase: 'kebab' } });
    const barrel = await read('index.ts');
    expect(barrel).toContain(`app.use('/audit-log',`);
    // The identifier cannot be kebab, so it falls back to camel rather than emitting a hyphen.
    expect(barrel).toContain('auditLogRoutes');
  });

  it('still emits a loadable barrel for an empty schema', async () => {
    const { read } = await emit([]);
    const barrel = await read('index.ts');
    expect(barrel).toContain('export const app = express();');
  });

  it('refuses to write a table over its own barrel, and names the way out', async () => {
    const clash = { ...users, name: 'index', tsName: 'index' } as Table;
    await expect(emit([clash])).rejects.toThrow(/naming\.routerSuffix/);
  });

  it('refuses to write a table over the middleware module, and names the way out', async () => {
    const clash = { ...users, name: 'validation', tsName: 'validation' } as Table;
    await expect(emit([clash])).rejects.toThrow(/naming\.routerSuffix/);
  });
});

describe('the response contract', () => {
  it('states the select shape on every route that returns rows', async () => {
    const { read } = await emit([users]);
    const source = await read('users.ts');
    expect(source).toContain('export type SelectusersRow = z.output<typeof SelectusersSchema>;');
    expect(source).toContain('const rows: SelectusersRow[] = [];');
    expect(source).toContain('const row: SelectusersRow | null = null;');
    // Express infers nothing from a handler, so the response type is stated where Express can
    // hold the handler to it: the res parameter.
    expect(source).toContain('res: Response<SelectusersRow[]>');
    expect(source).toContain('res: Response<SelectusersRow | null>');
  });

  it('throws from the write stubs rather than returning the input', async () => {
    // The input is the insert shape, where a generated column is absent; the declared response is
    // the select shape, where it is required. Returning the input is a type error, so the stub
    // says plainly that the work is not done instead.
    const { read } = await emit([users]);
    const source = await read('users.ts');
    expect(source).toContain("throw new Error('Not implemented: create users.');");
    expect(source).toContain("throw new Error('Not implemented: update users.');");
  });
});
