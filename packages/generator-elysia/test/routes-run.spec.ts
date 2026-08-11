/**
 * The emitted app is driven for real, in-process, on plain Node.
 *
 * Every other DRZL router generator leans on the compile for most of its claims, because their
 * targets want a server. Elysia hands out `app.handle(request) => Promise<Response>`, so the whole
 * request path can be exercised here: routing, validation, coercion and the error shape.
 *
 * Two things this file pins that reading the types cannot.
 *
 * The URL must have a multi-label hostname. `app.handle(new Request('http://x/users'))` returns
 * `404 NOT_FOUND` for an app whose route is registered and answering, because Elysia scans the URL
 * string for the path rather than going through `new URL()` and a one-label host throws off the
 * offset. Everything 404s, which reads exactly like a router that never built. Measured against
 * elysia@1.4.29 and asserted below, so the day it is fixed this says so.
 *
 * And validation really happens, per library. That is not a given: h3 v1 needs an emitted adapter
 * to validate at all, and `@ts-rest/core` 3.52.1 passes an unrecognised schema straight through as
 * valid, which is the defect `@drzl/generator-ts-rest` exists to route around.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ElysiaGenerator } from '../src';
import { analysis, memberships, users } from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const workRoot = path.join(pkgRoot, 'test', 'tmp', 'run');

type Lib = 'typebox' | 'zod' | 'valibot' | 'arktype';
const LIBS: Lib[] = ['typebox', 'zod', 'valibot', 'arktype'];

const tables = [users, memberships];

/** Schemas that reject a number where a string belongs, in each library's own spelling. */
function sharedSource(lib: Lib): string {
  const per = (t: string, insert: string, update: string, select: string) =>
    [
      `export const Insert${t}Schema = ${insert};`,
      `export const Update${t}Schema = ${update};`,
      `export const Select${t}Schema = ${select};`,
    ].join('\n');
  const names = tables.map((t) => t.tsName);
  if (lib === 'zod') {
    return [
      "import { z } from 'zod';",
      ...names.map((t) =>
        per(
          t,
          'z.object({ email: z.string() })',
          'z.object({ email: z.string().optional() })',
          'z.object({ id: z.number(), email: z.string() })'
        )
      ),
      '',
    ].join('\n');
  }
  if (lib === 'valibot') {
    return [
      "import * as v from 'valibot';",
      ...names.map((t) =>
        per(
          t,
          'v.object({ email: v.string() })',
          'v.object({ email: v.optional(v.string()) })',
          'v.object({ id: v.number(), email: v.string() })'
        )
      ),
      '',
    ].join('\n');
  }
  if (lib === 'arktype') {
    return [
      "import { type } from 'arktype';",
      ...names.map((t) =>
        per(
          t,
          "type({ email: 'string' })",
          "type({ 'email?': 'string' })",
          "type({ id: 'number', email: 'string' })"
        )
      ),
      '',
    ].join('\n');
  }
  return [
    "import { Type } from '@sinclair/typebox';",
    ...names.map((t) =>
      per(
        t,
        'Type.Object({ email: Type.String() })',
        'Type.Object({ email: Type.Optional(Type.String()) })',
        'Type.Object({ id: Type.Number(), email: Type.String() })'
      )
    ),
    '',
  ].join('\n');
}

interface App {
  handle: (request: Request) => Promise<Response>;
}

const apps = new Map<Lib, App>();

beforeAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
  for (const lib of LIBS) {
    const dir = path.join(workRoot, lib);
    const shared = path.join(dir, 'validators');
    await fs.mkdir(shared, { recursive: true });
    await fs.writeFile(path.join(shared, 'index.ts'), sharedSource(lib), 'utf8');
    await fs.mkdir(path.join(dir, 'routes'), { recursive: true });

    await new ElysiaGenerator(analysis(tables)).generate({
      outputDir: path.join(dir, 'routes'),
      // `.ts`, because these modules are imported by vitest rather than compiled first.
      importExtension: 'ts',
      validation: {
        library: lib,
        useShared: true,
        importPath: path.relative(process.cwd(), shared),
      },
    } as never);

    const mod = (await import(
      /* @vite-ignore */ path.join(dir, 'routes', 'index.ts')
    )) as { app: App };
    apps.set(lib, mod.app);
  }
}, 120_000);

afterAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
});

const post = (app: App, p: string, body: unknown) =>
  app.handle(
    new Request(`http://localhost${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

describe('every library validates a body for real', () => {
  for (const lib of LIBS) {
    it(`rejects a number where ${lib} declared a string`, async () => {
      const res = await post(apps.get(lib)!, '/users', { email: 12345 });
      expect(res.status, await res.text()).toBe(422);
    });

    it(`accepts a valid body under ${lib}`, async () => {
      // The stub throws `Not implemented`, which is a 500 and is the point: reaching the handler
      // at all means the body passed validation. A 422 would mean it never got there.
      const res = await post(apps.get(lib)!, '/users', { email: 'a@b.c' });
      expect(res.status).toBe(500);
    });
  }
});

describe('a numeric path segment', () => {
  for (const lib of LIBS) {
    it(`converts under ${lib}, and refuses a segment that is not a number`, async () => {
      const app = apps.get(lib)!;
      const ok = await app.handle(new Request('http://localhost/users/42'));
      expect(ok.status, await ok.text()).toBe(200);

      const bad = await app.handle(new Request('http://localhost/users/abc'));
      expect(bad.status).toBe(422);
    });
  }

  it('addresses a composite key by every one of its columns', async () => {
    const app = apps.get('zod')!;
    expect((await app.handle(new Request('http://localhost/memberships/1/2'))).status).toBe(200);
    // One segment short is a different route, and there is not one.
    expect((await app.handle(new Request('http://localhost/memberships/1'))).status).toBe(404);
  });
});

describe('the hostname trap, which cost an hour', () => {
  /**
   * A single-label hostname 404s every route.
   *
   * This is a must-fire test rather than a description. If Elysia ever routes `http://x/users`
   * correctly, this fails and the warning in the module comment can come out.
   */
  it('404s a single-label host and answers the identical request on localhost', async () => {
    const app = apps.get('zod')!;
    const short = await app.handle(new Request('http://x/users'));
    const long = await app.handle(new Request('http://localhost/users'));
    expect(short.status, 'elysia now routes a single-label host, so the warning can go').toBe(404);
    expect(long.status).toBe(200);
  });
});

describe('what the handler receives', () => {
  /**
   * ArkType keeps unknown keys where the other three strip them.
   *
   * A real difference in what a handler is handed, measured rather than assumed, and asserted here
   * so the generator's documentation can state it as fact. Elysia accepts the body either way; the
   * difference is what survives into the context.
   */
  it('strips an unknown key under zod, valibot and typebox, and keeps it under arktype', async () => {
    const { Elysia } = await import('elysia');
    const { z } = await import('zod');
    const v = await import('valibot');
    const { type } = await import('arktype');
    const { Type } = await import('@sinclair/typebox');

    const seen: Record<string, unknown> = {};
    const probe = new Elysia()
      .post('/z', ({ body }) => ((seen.zod = body), 'ok'), { body: z.object({ email: z.string() }) })
      .post('/v', ({ body }) => ((seen.valibot = body), 'ok'), {
        body: v.object({ email: v.string() }),
      })
      .post('/a', ({ body }) => ((seen.arktype = body), 'ok'), {
        body: type({ email: 'string' }),
      })
      .post('/t', ({ body }) => ((seen.typebox = body), 'ok'), {
        body: Type.Object({ email: Type.String() }),
      });

    for (const p of ['/z', '/v', '/a', '/t']) await post(probe as App, p, { email: 'a@b.c', wat: true });

    expect(seen.zod).toEqual({ email: 'a@b.c' });
    expect(seen.valibot).toEqual({ email: 'a@b.c' });
    expect(seen.typebox).toEqual({ email: 'a@b.c' });
    expect(seen.arktype).toEqual({ email: 'a@b.c', wat: true });
  });

  /**
   * `t.Numeric` is Elysia's, not TypeBox's.
   *
   * The compile spec asserts the emitted module imports `t` from `'elysia'`. This asserts the
   * reason: `Type.Numeric` does not exist, so importing `Type` instead would emit a call to
   * `undefined`.
   */
  it('has no Numeric in @sinclair/typebox, which is why t comes from elysia', async () => {
    const { Type } = await import('@sinclair/typebox');
    const { t } = await import('elysia');
    // `in` rather than a cast: TypeBox's builder is a class instance, so casting it to an index
    // signature is the kind of assertion tsc refuses outright.
    expect('Numeric' in Type).toBe(false);
    expect('Numeric' in t).toBe(true);
    expect(typeof t.Numeric).toBe('function');
  });
});

describe('the assembled app', () => {
  it('mounts every table, so one app answers for all of them', async () => {
    const app = apps.get('zod')!;
    expect((await app.handle(new Request('http://localhost/users'))).status).toBe(200);
    expect((await app.handle(new Request('http://localhost/memberships'))).status).toBe(200);
    expect((await app.handle(new Request('http://localhost/nope'))).status).toBe(404);
  });
});
