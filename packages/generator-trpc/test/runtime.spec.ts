/**
 * The emitted router is stood up as a real tRPC server and driven over HTTP.
 *
 * A generated module that looks right and does not run is the recurring failure in this
 * repository, and typechecking cannot see any of it: whether `export const router = t.router`
 * survives being destructured off the builder, whether a router built in one module can be nested
 * by another, whether `.input()` actually rejects a bad payload rather than merely being present,
 * whether the barrel loads at all. So this generates, writes a real service layer beside it,
 * starts `@trpc/server`'s standalone adapter on a real port, and makes real requests.
 *
 * `importExtension: 'none'` because the module graph here is loaded by vite, which resolves
 * `./trpc` to `./trpc.ts`. The `.js` form the default emits is the one that resolves under a real
 * `tsc`, and it is compiled under all four moduleResolution settings in output-typechecks.spec.ts.
 */
import type { Server } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRPCGenerator } from '../src';
import { analysis, users } from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const workDir = path.join('test', 'tmp', 'runtime');
const absWork = path.join(pkgRoot, workDir);

/** An in-memory stand-in for what `@drzl/generator-service` writes, with the same signatures. */
const SERVICE = `
export interface Row { id: number; email: string; bio: string | null }
const rows: Row[] = [];
let next = 1;

export class UserService {
  static async getAll(): Promise<Row[]> {
    return rows;
  }
  static async getById(id: number): Promise<Row | null> {
    return rows.find((r) => r.id === id) ?? null;
  }
  static async create(input: { email: string; bio?: string | null }): Promise<Row> {
    const row: Row = { id: next++, email: input.email, bio: input.bio ?? null };
    rows.push(row);
    return row;
  }
  static async update(id: number, data: { email?: string; bio?: string | null }): Promise<Row> {
    const row = rows.find((r) => r.id === id);
    if (!row) throw new Error('no such row');
    Object.assign(row, data);
    return row;
  }
  static async delete(id: number): Promise<boolean> {
    const at = rows.findIndex((r) => r.id === id);
    if (at !== -1) rows.splice(at, 1);
    return at !== -1;
  }
}
`;

let server: Server;
let origin: string;
/** Every request and response, printed when the suite runs with DRZL_TRPC_TRANSCRIPT set. */
const transcript: string[] = [];

async function call(
  method: 'GET' | 'POST',
  procedure: string,
  input?: unknown
): Promise<{ status: number; body: any }> {
  const url =
    method === 'GET'
      ? `${origin}/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`
      : `${origin}/${procedure}`;
  const res = await fetch(url, {
    method,
    ...(method === 'POST'
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input ?? {}) }
      : {}),
  });
  const body = await res.json();
  transcript.push(
    `${method} /${procedure}${input === undefined ? '' : ` ${JSON.stringify(input)}`}\n` +
      `  -> ${res.status} ${JSON.stringify(body)}`
  );
  return { status: res.status, body };
}

beforeAll(async () => {
  await fs.rm(absWork, { recursive: true, force: true });
  await fs.mkdir(path.join(absWork, 'services'), { recursive: true });
  await fs.writeFile(path.join(absWork, 'services', 'userService.ts'), SERVICE, 'utf8');

  await new TRPCGenerator(analysis([users])).generate({
    outputDir: path.join(workDir, 'api'),
    template: 'service',
    servicesDir: path.join(workDir, 'services'),
    importExtension: 'none',
  });

  const barrel = pathToFileURL(path.join(absWork, 'api', 'index.ts')).href;
  // `any` because the module is generated at run time: there is no declaration for it to resolve
  // against, and its real types are checked by `tsc` in output-typechecks.spec.ts instead.
  const { appRouter } = (await import(/* @vite-ignore */ barrel)) as { appRouter: any };
  const { createHTTPServer } = await import('@trpc/server/adapters/standalone');
  // The adapter hands back the `node:http` server, so it is listened on directly rather than
  // through the adapter's own `listen`, which does not report when it is ready.
  server = createHTTPServer({ router: appRouter, createContext: () => ({}) }) as unknown as Server;
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (process.env.DRZL_TRPC_TRANSCRIPT) console.log(transcript.join('\n'));
  await fs.rm(absWork, { recursive: true, force: true });
});

describe('a generated router, over HTTP', () => {
  it('answers a query before anything has been written', async () => {
    const { status, body } = await call('GET', 'users.list');
    expect(status).toBe(200);
    expect(body.result.data).toEqual([]);
  });

  it('accepts a mutation and returns the row it created', async () => {
    const { status, body } = await call('POST', 'users.create', { email: 'ada@example.com' });
    expect(status).toBe(200);
    // The row carries the generated `id` the input never had, which is the whole reason a stub
    // cannot answer this by returning its input.
    expect(body.result.data).toEqual({ id: 1, email: 'ada@example.com', bio: null });
  });

  it('reads back what the mutation wrote', async () => {
    await call('POST', 'users.create', { email: 'grace@example.com', bio: 'compiler' });
    const list = await call('GET', 'users.list');
    expect(list.body.result.data).toEqual([
      { id: 1, email: 'ada@example.com', bio: null },
      { id: 2, email: 'grace@example.com', bio: 'compiler' },
    ]);

    const one = await call('GET', 'users.byId', { id: 2 });
    expect(one.body.result.data).toEqual({ id: 2, email: 'grace@example.com', bio: 'compiler' });
  });

  it('answers byId with null for a row that is not there', async () => {
    const { body } = await call('GET', 'users.byId', { id: 999 });
    expect(body.result.data).toBeNull();
  });

  it('applies a patch through update', async () => {
    const { body } = await call('POST', 'users.update', { id: 1, data: { bio: 'analyst' } });
    expect(body.result.data).toEqual({ id: 1, email: 'ada@example.com', bio: 'analyst' });
  });

  it('deletes, and says so', async () => {
    expect((await call('POST', 'users.delete', { id: 1 })).body.result.data).toBe(true);
    expect((await call('GET', 'users.byId', { id: 1 })).body.result.data).toBeNull();
  });

  it('rejects a payload the input schema refuses, before the handler runs', async () => {
    // The point of wiring DRZL's schemas into `.input()`. A schema that is merely present, and
    // not enforced, looks identical in the source.
    const { status, body } = await call('POST', 'users.create', { email: 42 });
    expect(status).toBe(400);
    expect(body.error.data.code).toBe('BAD_REQUEST');
  });

  it('rejects a query missing its key', async () => {
    const { status, body } = await call('GET', 'users.byId', {});
    expect(status).toBe(400);
    expect(body.error.data.code).toBe('BAD_REQUEST');
  });

  it('refuses to serve a mutation over GET', async () => {
    // tRPC's own rule, and the reason `create` is declared a mutation rather than a query: a
    // proxy or a browser may cache a GET and must never cache a write.
    const res = await fetch(`${origin}/users.create?input=${encodeURIComponent('{"email":"x"}')}`);
    expect(res.status).toBe(405);
  });
});

describe('the generated module graph', () => {
  it('loads without side effects that throw', async () => {
    // Two defects in this repository were modules that threw on import. A second load of the
    // barrel, of the base and of a router has to be uneventful.
    for (const file of ['index.ts', 'trpc.ts', 'users.ts']) {
      const href = pathToFileURL(path.join(absWork, 'api', file)).href;
      await expect(import(/* @vite-ignore */ `${href}?reload`)).resolves.toBeTruthy();
    }
  });

  it('exports the app router type surface a client is built from', async () => {
    const barrel = pathToFileURL(path.join(absWork, 'api', 'index.ts')).href;
    const mod = (await import(/* @vite-ignore */ barrel)) as Record<string, unknown>;
    expect(Object.keys(mod).sort()).toEqual([
      'appRouter',
      'createCallerFactory',
      'publicProcedure',
      'router',
    ]);
  });

  it('can be called in-process through the exported caller factory', async () => {
    // The path SSR and server components take, which never goes near HTTP.
    const barrel = pathToFileURL(path.join(absWork, 'api', 'index.ts')).href;
    const { appRouter, createCallerFactory } = (await import(/* @vite-ignore */ barrel)) as any;
    const caller = createCallerFactory(appRouter)({});
    const created = await caller.users.create({ email: 'katherine@example.com' });
    expect(created.email).toBe('katherine@example.com');
    expect(await caller.users.byId({ id: created.id })).toEqual(created);
  });
});
