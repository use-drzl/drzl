/**
 * The emitted routers are mounted on a real Express app and driven over real HTTP.
 *
 * A generated module that looks right and does not run is the recurring failure in this
 * repository, and no amount of text matching can see any of it: whether `json()` actually sits in
 * front of the body validator, whether the middleware rejects a bad payload rather than merely
 * being present, whether a path parameter that arrives as the string `"1"` survives a schema
 * written for a `number` column, whether Express 5 really turns a throwing stub into a 500.
 *
 * Unlike Hono there is no `app.request()`: an Express app is a Node request listener, so it is
 * given a real socket with `app.listen(0)` and driven with `fetch`. That is the same code path a
 * deployed server takes, default error handler included, which matters twice here: a rejected
 * async stub must become a 500 (Express 5's promise handling; on Express 4 the same stub kills
 * the process), and a body that fails to parse must become a 400 (body-parser's SyntaxError
 * carries status 400 into the default handler).
 *
 * `importExtension: 'none'` because this module graph is loaded by vite, which resolves `./users`
 * to `./users.ts`. The `.js` default is the form that resolves under a real `tsc`, and it is
 * compiled in output-typechecks.spec.ts.
 */
import type { Server } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExpressGenerator } from '../src';
import { analysis, auditLog, books, dailyTotals, memberships, users } from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');

type Lib = 'zod' | 'valibot' | 'arktype';

const servers: Server[] = [];

afterAll(async () => {
  await Promise.all(
    servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
});

async function buildApp(lib: Lib, dir: string): Promise<string> {
  const out = path.join(pkgRoot, 'test', 'tmp', 'runtime', dir);
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(out, { recursive: true });
  const gen = new ExpressGenerator(analysis([users, books, memberships, auditLog, dailyTotals]));
  await gen.generate({
    outputDir: path.relative(process.cwd(), out),
    importExtension: 'none',
    validation: { library: lib },
  });
  const mod = await import(pathToFileURL(path.join(out, 'index.ts')).href);
  const app = mod.app as { listen(port: number, cb: () => void): Server };
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port assigned');
  return `http://127.0.0.1:${address.port}`;
}

const post = (base: string, url: string, body: string): Promise<Response> =>
  fetch(base + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

describe('the emitted routers, mounted on a real Express app', () => {
  let base: string;
  beforeAll(async () => {
    base = await buildApp('zod', 'zod-main');
  });

  it('serves a valid request', async () => {
    const res = await fetch(`${base}/users`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('coerces a numeric path parameter, which arrives as a string', async () => {
    const res = await fetch(`${base}/users/1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it('rejects a path parameter that is not a number, with a field error', async () => {
    const res = await fetch(`${base}/users/abc`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; slot: string; issues: unknown[] };
    expect(body.error).toBe('Validation failed');
    expect(body.slot).toBe('params');
    expect(JSON.stringify(body.issues)).toContain('id');
  });

  it('rejects the spaced segment %20 rather than addressing row 0', async () => {
    // `Number(' ')` is 0, so every coercion built on `Number()` reads `GET /users/%20` as row 0.
    // The strict form refuses it, and this is asserted over HTTP because the URL decoding that
    // turns `%20` back into a space is part of what is being tested.
    const res = await fetch(`${base}/users/%20`);
    expect(res.status).toBe(400);
  });

  it('rejects a body whose field has the wrong type, naming the field', async () => {
    const res = await post(base, '/users', JSON.stringify({ email: 123 }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('email');
  });

  it('rejects a body missing a required field', async () => {
    const res = await post(base, '/users', JSON.stringify({ bio: 'no email here' }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('email');
  });

  it('rejects an enum member the column does not have, naming the field', async () => {
    const res = await post(base, '/users', JSON.stringify({ email: 'a@b.c', role: 'boss' }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('role');
  });

  it('answers 400 for a body that is not JSON at all', async () => {
    // This 400 comes from body-parser through Express's default error handler, not from the
    // emitted middleware: `json()` refuses the payload before validation is reached.
    const res = await post(base, '/users', '{not json');
    expect(res.status).toBe(400);
  });

  /**
   * The one that separates "the validator ran and passed" from "the validator never ran".
   *
   * The create handler is a stub that throws, so a valid body produces a 500 and an invalid one
   * produces a 400. Asserting only the 400 above would pass just as well against a router with no
   * middleware on it at all, because a missing validator also lets a bad body through to a
   * handler that throws. The pair of statuses is what proves the middleware is in the chain and
   * that it accepted this payload; the 500 also proves Express 5 routed the rejected promise to
   * its error handler rather than leaving the request hanging.
   */
  it('lets a valid body reach the handler, which is the unimplemented stub', async () => {
    const res = await post(base, '/users', JSON.stringify({ email: 'a@b.c' }));
    expect(res.status).toBe(500);
  });

  it('accepts an insert that omits generated and defaulted columns', async () => {
    const res = await post(base, '/users', JSON.stringify({ email: 'a@b.c', bio: null }));
    // 500 and not 400: the schema accepted it, the stub then threw.
    expect(res.status).toBe(500);
  });

  it('accepts a valid enum member', async () => {
    const res = await post(base, '/users', JSON.stringify({ email: 'a@b.c', role: 'member' }));
    expect(res.status).toBe(500);
  });

  it('reaches the throwing stub through the PATCH pipeline too', async () => {
    const bad = await fetch(`${base}/users/1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 123 }),
    });
    expect(bad.status).toBe(400);
    const ok = await fetch(`${base}/users/1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new@b.c' }),
    });
    expect(ok.status).toBe(500);
  });

  it('serves a delete on a real key', async () => {
    const res = await fetch(`${base}/users/1`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toBe(true);
  });

  it('does not coerce a string primary key into a number', async () => {
    const res = await fetch(`${base}/books/978-0-13-235088-4`);
    expect(res.status).toBe(200);
  });

  it('addresses a composite key through every segment of the path', async () => {
    const ok = await fetch(`${base}/memberships/1/2`);
    expect(ok.status).toBe(200);
    const bad = await fetch(`${base}/memberships/1/nope`);
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await bad.json())).toContain('userId');
  });

  describe('a table with no primary key', () => {
    it('still lists', async () => {
      const res = await fetch(`${base}/auditLog`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    it('still creates', async () => {
      const res = await post(base, '/auditLog', JSON.stringify({ at: 'now', what: 'thing' }));
      expect(res.status).toBe(500);
    });

    it('has no route that addresses one row', async () => {
      expect((await fetch(`${base}/auditLog/1`)).status).toBe(404);
      expect((await fetch(`${base}/auditLog/1`, { method: 'DELETE' })).status).toBe(404);
      expect(
        (
          await fetch(`${base}/auditLog/1`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        ).status
      ).toBe(404);
    });
  });

  describe('a read-only table', () => {
    it('lists', async () => {
      expect((await fetch(`${base}/dailyTotals`)).status).toBe(200);
    });

    it('refuses every write, because no such route exists', async () => {
      const res = await post(base, '/dailyTotals', JSON.stringify({ day: 'x', total: 1 }));
      expect(res.status).toBe(404);
    });
  });
});

/**
 * The same contract under every library.
 *
 * The path-parameter coercion is the reason this matrix exists rather than one representative
 * case: each library needs a different strict expression, and the loose spellings differ in
 * exactly which garbage they accept, so every library is asked the same questions over HTTP
 * rather than trusted to have been transcribed correctly from the Hono generator.
 */
describe.each(['zod', 'valibot', 'arktype'] as Lib[])('%s schemas behind validate()', (lib) => {
  let base: string;
  beforeAll(async () => {
    base = await buildApp(lib, lib);
  });

  it('accepts a numeric path parameter', async () => {
    expect((await fetch(`${base}/users/1`)).status).toBe(200);
  });

  it('rejects a non-numeric path parameter rather than passing NaN to the handler', async () => {
    expect((await fetch(`${base}/users/abc`)).status).toBe(400);
  });

  it('rejects the spaced segment, which Number() reads as 0', async () => {
    expect((await fetch(`${base}/users/%20`)).status).toBe(400);
  });

  it('rejects a body with the wrong field type', async () => {
    const res = await post(base, '/users', JSON.stringify({ email: 123 }));
    expect(res.status).toBe(400);
  });

  it('rejects an enum member the column does not have', async () => {
    const res = await post(base, '/users', JSON.stringify({ email: 'a@b.c', role: 'boss' }));
    expect(res.status).toBe(400);
  });

  it('accepts a valid body', async () => {
    const res = await post(base, '/users', JSON.stringify({ email: 'a@b.c' }));
    expect(res.status).toBe(500);
  });
});
