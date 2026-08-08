/**
 * Which routes exist for which table shape, and what addresses a row.
 *
 * The design decisions are `@drzl/generator-hono`'s and `@drzl/generator-express`'s, which took
 * them from the tRPC generator: the key comes off the table's real `primaryKey` at its real
 * types, a keyless table loses the addressed routes rather than gaining a fictional `id`, and a
 * read-only table loses every write.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { tableSchemas } from '@drzl/generator-json-schema';
import { FastifyGenerator } from '../src';
import {
  activeUsers,
  analysis,
  auditLog,
  books,
  dailyTotals,
  events,
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
  const { files } = await new FastifyGenerator(analysis(tables)).generate({
    outputDir: dir,
    ...opts,
  } as never);
  const read = async (name: string) => fs.readFile(path.join(dir, name), 'utf8');
  return { dir, files, read };
}

/**
 * Every `.method<Generics>('path'` in a route module, in emitted order.
 *
 * Not anchored to the start of a line, for the reason the Hono spec records: prettier wraps a
 * call with several arguments across lines, and an anchored pattern then reads a generator that
 * never emitted the route. The generic part carries no parenthesis, so `[^(]*` spans exactly the
 * `<{ Reply: ... }>` between the method and its call.
 */
function routesOf(source: string): string[] {
  return [...source.matchAll(/\.(get|post|patch|delete)<[^(]*>\(\s*'([^']*)'/g)].map(
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

  it('types the enum column as its members, in the schema and in the row type', async () => {
    const { read } = await emit([users]);
    const source = await read('users.ts');
    expect(source).toContain(`enum: ['admin', 'member']`);
    expect(source).toContain(`role: 'admin' | 'member';`);
  });

  it('validates numeric key segments as strict strings, not by AJV coercion', async () => {
    // Fastify's default AJV coerces params, and `{ type: 'integer' }` reads `%20` as row 0,
    // `0x10` as 16 and `1e5` as 100000 (grid in src/index.ts). The emitted spelling is the
    // strict string one; the runtime spec proves the grid over HTTP.
    const { read } = await emit([users]);
    const source = await read('users.ts');
    expect(source).toMatch(/UsersParamsSchema = \{/);
    expect(source).toContain(`type: 'string'`);
    expect(source).toContain('pattern:');
    expect(source).not.toContain(`id: { type: 'integer' }`);
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

  it('does not constrain the segment to look like a number', async () => {
    const { read } = await emit([books]);
    const source = await read('books.ts');
    expect(source).toMatch(/BooksParamsSchema[\s\S]*?isbn: \{\s*type: 'string',?\s*\}/);
    expect(source).not.toContain('pattern');
  });

  it('leaves the key out of the update schema, which the shared builder decides', async () => {
    // validation-core's updateColumns excludes primary key columns: the key of the row being
    // patched comes from the path, and a body that could rename it is a different operation.
    // The Express generator's inline update keeps the key as optional; this one runs the shared
    // builder, so the difference is pinned rather than discovered.
    const { read } = await emit([books]);
    const source = await read('books.ts');
    expect(source).toMatch(/UpdatebooksSchema = \{[\s\S]*?\} as const;/);
    const update = source.match(/UpdatebooksSchema = \{[\s\S]*?\} as const;/)![0];
    expect(update).not.toContain('isbn');
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
    expect(routesOf(await read('auditLog.ts'))).toEqual(['GET /', 'POST /']);
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

  it('take a literal prefix, which find-my-way makes load-bearing', async () => {
    // Measured on fastify 5.11.2: a bare `/:authorId` beside `/:id` throws
    // "Method 'GET' already declared for route" at registration, so without the prefix the
    // emitted plugin would not even load.
    const { read } = await emit([posts], { includeRelations: true });
    const found = routesOf(await read('posts.ts'));
    expect(found).toContain('GET /by-author-id/:authorId');
    expect(found.filter((r) => /^GET \/:[^/]+$/.test(r))).toEqual(['GET /:id']);
  });
});

describe('the schemas, adapted for the AJV instance Fastify actually runs', () => {
  it('carries no $schema and no $id, which that AJV refuses or misreads', async () => {
    // Measured on fastify 5.11.2: a body schema with `$schema` naming draft 2020-12 fails
    // app.ready() with 'no schema with key or ref'.
    const { read } = await emit([users]);
    const source = await read('users.ts');
    expect(source).not.toContain('$schema');
    expect(source).not.toContain('$id');
  });

  it('respells prefixItems as homogeneous items with the same bounds', async () => {
    // Measured on fastify 5.11.2: `prefixItems` fails app.ready() with 'strict mode: unknown
    // keyword'. The rewrite is exactly equivalent because the builder only emits identical
    // members, which the premise test below holds it to.
    const { read } = await emit([events]);
    const source = await read('events.ts');
    expect(source).not.toContain('prefixItems');
    expect(source).toMatch(/point:[\s\S]*?items:[\s\S]*?type: 'number'/);
    expect(source).toContain('minItems: 2');
    expect(source).toContain('maxItems: 2');
  });

  it('rests on a builder that emits identical tuple members, asserted not assumed', () => {
    const built = tableSchemas(events).select as {
      properties: Record<string, { prefixItems?: unknown[] }>;
    };
    const prefix = built.properties.point.prefixItems;
    expect(Array.isArray(prefix)).toBe(true);
    expect(prefix!.length).toBe(2);
    for (const member of prefix!) {
      expect(JSON.stringify(member)).toBe(JSON.stringify(prefix![0]));
    }
  });

  it('keeps the bigint string spelling and the date-time format, which are enforced', async () => {
    const { read } = await emit([events]);
    const source = await read('events.ts');
    expect(source).toMatch(/big: \{\s*type: 'string',\s*pattern: '\^-\?\\\\d\+\$',?\s*\}/);
    expect(source).toContain(`format: 'date-time'`);
  });
});

describe('the emitted file set', () => {
  it('is one module per table, then the barrel, and nothing else', async () => {
    // Unlike the Express generator there is no middleware module to emit: the schemas ARE the
    // validation, and Fastify compiles them itself.
    const { files, dir } = await emit([users, posts]);
    expect(files.map((f) => path.relative(dir, f))).toEqual(['users.ts', 'posts.ts', 'index.ts']);
  });

  it('registers every table under its own prefix and re-exports the modules', async () => {
    const { read } = await emit([users, auditLog]);
    const barrel = await read('index.ts');
    expect(barrel).toContain(`app.register(usersRoutes, { prefix: '/users' });`);
    expect(barrel).toContain(`app.register(auditLogRoutes, { prefix: '/auditLog' });`);
    expect(barrel).toContain(`export * from './users.js';`);
  });

  it('takes a kebab prefix from procedureCase, which a URL can carry', async () => {
    const { read } = await emit([auditLog], { naming: { procedureCase: 'kebab' } });
    const barrel = await read('index.ts');
    expect(barrel).toContain(`{ prefix: '/audit-log' }`);
    // The identifier cannot be kebab, so it falls back to camel rather than emitting a hyphen.
    expect(barrel).toContain('auditLogRoutes');
  });

  it('still emits a loadable barrel for an empty schema', async () => {
    const { read } = await emit([]);
    const barrel = await read('index.ts');
    expect(barrel).toContain('export const routes: FastifyPluginAsync = async () => {};');
  });

  it('refuses to write a table over its own barrel, and names the way out', async () => {
    const clash = { ...users, name: 'index', tsName: 'index' } as Table;
    await expect(emit([clash])).rejects.toThrow(/naming\.routerSuffix/);
  });
});

describe('the response contract', () => {
  it('states the select schema on every route that returns rows, and 404 on byId', async () => {
    const { read } = await emit([users]);
    const source = await read('users.ts');
    expect(source).toContain(`response: { 200: { type: 'array', items: SelectusersSchema } }`);
    expect(source).toMatch(/response: \{\s*200: SelectusersSchema,\s*404: \{/);
  });

  it('holds every handler to its reply through the route generics', async () => {
    const { read } = await emit([users]);
    const source = await read('users.ts');
    expect(source).toContain('app.get<{ Reply: SelectusersRow[] }>');
    expect(source).toContain('app.get<{ Reply: SelectusersRow | { message: string } }>');
    expect(source).toContain('app.post<{ Reply: SelectusersRow }>');
    expect(source).toContain('app.delete<{ Reply: boolean }>');
  });

  it('answers 404 from the byId stub rather than serializing null into {}', async () => {
    // Measured on fastify 5.11.2: a null payload under an object response schema serializes as
    // {}, so the Express generator's `res.json(null)` idiom is not honest here.
    const { read } = await emit([users]);
    const source = await read('users.ts');
    expect(source).toContain(`reply.code(404).send({ message: 'users row not found' })`);
  });

  it('throws from the write stubs rather than returning the input', async () => {
    const { read } = await emit([users]);
    const source = await read('users.ts');
    expect(source).toContain("throw new Error('Not implemented: create users.');");
    expect(source).toContain("throw new Error('Not implemented: update users.');");
  });
});
