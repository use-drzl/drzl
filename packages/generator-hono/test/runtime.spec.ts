/**
 * The emitted routes are mounted on a real Hono app and driven over real HTTP.
 *
 * A generated module that looks right and does not run is the recurring failure in this
 * repository, and no amount of text matching can see any of it: whether the chained `new Hono()`
 * actually carries the routes, whether the validator middleware rejects a bad payload rather than
 * merely being present, whether a path parameter that arrives as the string `"1"` survives a
 * schema written for a `number` column, whether a keyless table really has no addressable route or
 * merely has one that is never called in a test.
 *
 * No server binary and no port. Hono is a fetch handler, and `app.request()` runs the whole
 * pipeline, middleware included, against a real `Request` and returns a real `Response`. That is
 * the same code path a deployed worker takes.
 *
 * `importExtension: 'none'` because this module graph is loaded by vite, which resolves `./users`
 * to `./users.ts`. The `.js` default is the form that resolves under a real `tsc`, and it is
 * compiled under all four moduleResolution settings in output-typechecks.spec.ts.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { HonoGenerator } from '../src';
import { analysis, auditLog, books, dailyTotals, memberships, users } from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');

type Lib = 'zod' | 'valibot' | 'arktype';
type Middleware = 'standard' | 'zod';

interface App {
  request(input: string, init?: RequestInit): Promise<Response>;
}

async function buildApp(lib: Lib, validator: Middleware, dir: string): Promise<App> {
  const out = path.join(pkgRoot, 'test', 'tmp', 'runtime', dir);
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(out, { recursive: true });
  const gen = new HonoGenerator(analysis([users, books, memberships, auditLog, dailyTotals]));
  await gen.generate({
    outputDir: path.relative(process.cwd(), out),
    importExtension: 'none',
    validator,
    validation: { library: lib },
  });
  const mod = await import(pathToFileURL(path.join(out, 'index.ts')).href);
  return mod.app as App;
}

describe('the emitted routes, mounted on a real Hono app', () => {
  let app: App;
  beforeAll(async () => {
    app = await buildApp('zod', 'standard', 'zod-standard');
  });

  it('serves a valid request', async () => {
    const res = await app.request('/users');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('coerces a numeric path parameter, which arrives as a string', async () => {
    const res = await app.request('/users/1');
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it('rejects a path parameter that is not a number, with a field error', async () => {
    const res = await app.request('/users/abc');
    expect(res.status).toBe(400);
    const body = JSON.stringify(await res.json());
    expect(body).toContain('id');
  });

  it('rejects a body whose field has the wrong type, naming the field', async () => {
    const res = await app.request('/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 123 }),
    });
    expect(res.status).toBe(400);
    const body = JSON.stringify(await res.json());
    expect(body).toContain('email');
  });

  it('rejects a body missing a required field', async () => {
    const res = await app.request('/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bio: 'no email here' }),
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('email');
  });

  /**
   * The one that separates "the validator ran and passed" from "the validator never ran".
   *
   * The create handler is a stub that throws, so a valid body produces a 500 and an invalid one
   * produces a 400. Asserting only the 400 above would pass just as well against a route with no
   * middleware on it at all, because a missing validator also lets a bad body through to a handler
   * that throws. The pair of statuses is what proves the middleware is in the chain and that it
   * accepted this payload.
   */
  it('lets a valid body reach the handler, which is the unimplemented stub', async () => {
    const res = await app.request('/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.c' }),
    });
    expect(res.status).toBe(500);
  });

  it('accepts an insert that omits a generated column', async () => {
    const res = await app.request('/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.c', bio: null }),
    });
    // 500 and not 400: the schema accepted it, the stub then threw.
    expect(res.status).toBe(500);
  });

  it('serves a delete on a real key', async () => {
    const res = await app.request('/users/1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toBe(true);
  });

  it('does not coerce a string primary key into a number', async () => {
    const res = await app.request('/books/978-0-13-235088-4');
    expect(res.status).toBe(200);
  });

  it('addresses a composite key through every segment of the path', async () => {
    const ok = await app.request('/memberships/1/2');
    expect(ok.status).toBe(200);
    const bad = await app.request('/memberships/1/nope');
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await bad.json())).toContain('userId');
  });

  describe('a table with no primary key', () => {
    it('still lists', async () => {
      const res = await app.request('/auditLog');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    it('still creates', async () => {
      const res = await app.request('/auditLog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ at: 'now', what: 'thing' }),
      });
      expect(res.status).toBe(500);
    });

    it('has no route that addresses one row', async () => {
      expect((await app.request('/auditLog/1')).status).toBe(404);
      expect((await app.request('/auditLog/1', { method: 'DELETE' })).status).toBe(404);
      expect(
        (
          await app.request('/auditLog/1', {
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
      expect((await app.request('/dailyTotals')).status).toBe(200);
    });

    it('refuses every write, because no such route exists', async () => {
      const res = await app.request('/dailyTotals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ day: 'x', total: 1 }),
      });
      expect(res.status).toBe(404);
    });
  });
});

/**
 * The same contract under every library and both middlewares.
 *
 * The path-parameter coercion is the reason this matrix exists rather than one representative
 * case. Each library needed a different expression, and two of the three obvious spellings accept
 * `NaN`: `z.coerce.number()` is safe only because zod's `number()` rejects `NaN`, and valibot's
 * `v.pipe(v.string(), v.transform(Number), v.number())` is not safe at all, because the pipe step
 * sees the previous step's output and by then `"abc"` is already `NaN`. A generator cannot be
 * trusted to have got that right from reading; it has to be asked.
 */
describe.each([
  ['zod', 'standard'],
  ['zod', 'zod'],
  ['valibot', 'standard'],
  ['arktype', 'standard'],
] as Array<[Lib, Middleware]>)('%s schemas behind the %s validator', (lib, validator) => {
  let app: App;
  beforeAll(async () => {
    app = await buildApp(lib, validator, `${lib}-${validator}`);
  });

  it('accepts a numeric path parameter', async () => {
    expect((await app.request('/users/1')).status).toBe(200);
  });

  it('rejects a non-numeric path parameter rather than passing NaN to the handler', async () => {
    expect((await app.request('/users/abc')).status).toBe(400);
  });

  it('rejects a body with the wrong field type', async () => {
    const res = await app.request('/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 123 }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts a valid body', async () => {
    const res = await app.request('/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.c' }),
    });
    expect(res.status).toBe(500);
  });
});
