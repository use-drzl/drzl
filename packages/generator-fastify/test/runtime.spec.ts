/**
 * The emitted plugins are registered on a real Fastify instance and driven through
 * `fastify.inject()`, which is Fastify's own light-my-request pipeline: routing, content-type
 * parsing, AJV validation, the handler, hooks and fast-json-stringify serialization all run
 * exactly as over a socket, so it is the full pipeline this generator's claims are about, and it
 * is the idiomatic way Fastify itself tells its users to test routes.
 *
 * Two behaviours here are this generator's whole reason to have a runtime suite:
 *
 * 1. The serializer. fast-json-stringify OMITS properties absent from the response schema, so a
 *    select schema that missed one column would silently delete that column from every response
 *    with no error anywhere. The round-trip block proves a full row comes back with every column
 *    present and correctly typed, through the emitted route's own response schema, and then
 *    demonstrates the omission and the measured violation behaviours on purpose.
 *
 * 2. The coercion policy. Fastify's default AJV coerces, and the params grid in src/index.ts is
 *    enforced here over HTTP: the spaced segment must not address row 0. Body coercion keeps
 *    Fastify's own semantics, which diverge from the Hono and Express generators, and the
 *    divergent cases are pinned as tests so a change in Fastify's defaults fails loudly here
 *    rather than silently changing the policy.
 *
 * Every 400 is paired with the load-bearing 500 of a valid payload reaching the throwing stub:
 * a missing validator also lets a bad payload through to a handler that throws, so only the pair
 * of statuses proves the schema is attached and accepted this payload.
 *
 * `importExtension: 'none'` because this module graph is loaded by vite, which resolves
 * `./users` to `./users.ts`. The `.js` default is the form that resolves under a real `tsc`, and
 * it is compiled in output-typechecks.spec.ts.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FastifyGenerator } from '../src';
import { analysis, auditLog, books, dailyTotals, events, memberships, users } from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');

const apps: FastifyInstance[] = [];

afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
});

async function emitApp(dir: string): Promise<Record<string, unknown>> {
  const out = path.join(pkgRoot, 'test', 'tmp', 'runtime', dir);
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(out, { recursive: true });
  const gen = new FastifyGenerator(
    analysis([users, books, memberships, auditLog, dailyTotals, events])
  );
  await gen.generate({
    outputDir: path.relative(process.cwd(), out),
    importExtension: 'none',
  });
  return (await import(pathToFileURL(path.join(out, 'index.ts')).href)) as Record<
    string,
    unknown
  >;
}

const json = (payload: string) => ({
  headers: { 'content-type': 'application/json' },
  payload,
});

describe('the emitted plugins, registered on a real Fastify instance', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const mod = await emitApp('main');
    app = Fastify();
    await app.register(mod.routes as FastifyPluginAsync);
    await app.ready();
    apps.push(app);
  });

  it('serves a valid request', async () => {
    const res = await app.inject({ method: 'GET', url: '/users' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('lets a valid key through to the stub, whose answer is the declared 404', async () => {
    // Not the router's 404: the stub found no row and says so through its own response schema.
    // The router's 404 for a route that does not exist names the route instead, which is what
    // keeps the two apart in this file.
    const res = await app.inject({ method: 'GET', url: '/users/1' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ message: 'users row not found' });
  });

  it('rejects a key that is not numeric, naming the field', async () => {
    const res = await app.inject({ method: 'GET', url: '/users/abc' });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('id');
  });

  it('rejects the spaced segment %20 rather than addressing row 0', async () => {
    // Number(' ') is 0, and Fastify's own AJV coercion on { type: integer } params reads
    // GET /users/%20 as row 0 (measured, grid in src/index.ts). The emitted strict string
    // schema refuses it, asserted over HTTP because the URL decoding that turns %20 back into
    // a space is part of what is being tested.
    const res = await app.inject({ method: 'GET', url: '/users/%20' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects the hex and exponent spellings AJV coercion would accept', async () => {
    expect((await app.inject({ method: 'GET', url: '/users/0x10' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/users/1e5' })).statusCode).toBe(400);
  });

  it('keeps the fractional spelling the other route generators keep', async () => {
    // The shared NUMERIC_SEGMENT pattern admits 1.5, exactly as the Hono and Express grids do,
    // so the segment reaches the stub and gets its not-found answer.
    const res = await app.inject({ method: 'GET', url: '/users/1.5' });
    expect(res.statusCode).toBe(404);
  });

  it('serves the list for a trailing slash rather than reading an empty key', async () => {
    // Fastify's prefixTrailingSlash defaults to 'both', so /users/ is the list route; there is
    // no route where an empty segment could become a key at all.
    const res = await app.inject({ method: 'GET', url: '/users/' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  /**
   * The one that separates "the validator ran and passed" from "the validator never ran".
   *
   * The create handler is a stub that throws, so a valid body produces a 500 and an invalid one
   * produces a 400. Asserting only the 400s would pass just as well against routes with no
   * schema attached, because a missing validator also lets a bad body through to a handler that
   * throws. The pair of statuses is what proves the schema is compiled into the route and that
   * it accepted this payload; the 500 also proves Fastify routed the rejected promise to its
   * error handling rather than leaving the request hanging.
   */
  it('lets a valid body reach the handler, which is the unimplemented stub', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/users',
      ...json(JSON.stringify({ email: 'a@b.c', bio: null })),
    });
    expect(res.statusCode).toBe(500);
  });

  it('accepts an insert that omits generated and defaulted columns', async () => {
    // id is generated and role has a default, so both may be absent; bio may not be, see below.
    const res = await app.inject({
      method: 'POST',
      url: '/users',
      ...json(JSON.stringify({ email: 'a@b.c', bio: null })),
    });
    // 500 and not 400: the schema accepted it, the stub then threw.
    expect(res.statusCode).toBe(500);
  });

  it('accepts an absent nullable column, the inherited json-schema semantics', async () => {
    // @drzl/generator-json-schema's insert schemas mark a nullable no-default column omissible,
    // because the database accepts an INSERT that omits it and stores NULL (its against-ajv spec
    // pins that). This generator runs the same builder, so it inherits the rule, and all five
    // generators now agree. 500 and not 201: the schema accepted it, the stub then threw, which
    // is this file's convention for "passed validation".
    const res = await app.inject({
      method: 'POST',
      url: '/users',
      ...json(JSON.stringify({ email: 'a@b.c' })),
    });
    expect(res.statusCode).toBe(500);
  });

  it('rejects a body missing a required field, naming the field', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/users',
      ...json(JSON.stringify({ bio: 'no email here' })),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('email');
  });

  it('rejects an enum member the column does not have, naming the field', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/users',
      ...json(JSON.stringify({ email: 'a@b.c', bio: null, role: 'boss' })),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('role');
  });

  it('accepts a valid enum member', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/users',
      ...json(JSON.stringify({ email: 'a@b.c', bio: null, role: 'member' })),
    });
    expect(res.statusCode).toBe(500);
  });

  it('rejects a body value no coercion can repair', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/users',
      ...json(JSON.stringify({ email: {}, bio: null })),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('email');
  });

  describe("Fastify's own body semantics, pinned as the documented divergence", () => {
    // The Hono and Express generators answer 400 to both of these. Fastify's default AJV runs
    // coerceTypes: 'array' and removeAdditional: true, and feeding Fastify's own machinery is
    // this generator's whole point, so the divergence is documented in src/index.ts and the docs
    // page, and pinned here: if a Fastify release changes these defaults, this fails loudly
    // instead of the policy drifting in silence.
    it('coerces a number into a declared string, and the stub answers 500', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/users',
        ...json(JSON.stringify({ email: 123, bio: null })),
      });
      expect(res.statusCode).toBe(500);
    });

    it('strips a key the schema does not name, and the stub answers 500', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/users',
        ...json(JSON.stringify({ email: 'a@b.c', bio: null, zzz: 'stripped' })),
      });
      expect(res.statusCode).toBe(500);
    });
  });

  it('answers 400 for a body that is not JSON at all', async () => {
    // This 400 comes from Fastify's content-type parser, before validation is reached.
    const res = await app.inject({ method: 'POST', url: '/users', ...json('{not json') });
    expect(res.statusCode).toBe(400);
  });

  it('answers 415 for a content type it has no parser for', async () => {
    // application/xml, not text/plain: Fastify ships parsers for application/json AND
    // text/plain, so a text/plain body reaches validation as a string and is a 400, which the
    // first run of this file measured.
    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { 'content-type': 'application/xml' },
      payload: '<email>a@b.c</email>',
    });
    expect(res.statusCode).toBe(415);
  });

  it('answers 400 for an empty body with a JSON content type', async () => {
    const res = await app.inject({ method: 'POST', url: '/users', ...json('') });
    expect(res.statusCode).toBe(400);
  });

  it('reaches the throwing stub through the PATCH pipeline too', async () => {
    const bad = await app.inject({
      method: 'PATCH',
      url: '/users/1',
      ...json(JSON.stringify({ role: 'boss' })),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain('role');
    const badKey = await app.inject({
      method: 'PATCH',
      url: '/users/abc',
      ...json(JSON.stringify({})),
    });
    expect(badKey.statusCode).toBe(400);
    const ok = await app.inject({
      method: 'PATCH',
      url: '/users/1',
      ...json(JSON.stringify({ email: 'new@b.c' })),
    });
    expect(ok.statusCode).toBe(500);
  });

  it('serves a delete on a real key, serialized by the boolean response schema', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/users/1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBe(true);
  });

  it('does not coerce a string primary key into a number', async () => {
    const res = await app.inject({ method: 'GET', url: '/books/978-0-13-235088-4' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ message: 'books row not found' });
  });

  it('accepts a space in a string key, which is a valid string', async () => {
    const res = await app.inject({ method: 'GET', url: '/books/%20' });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain('books row not found');
  });

  it('addresses a composite key through every segment of the path', async () => {
    const ok = await app.inject({ method: 'GET', url: '/memberships/1/2' });
    expect(ok.statusCode).toBe(404);
    expect(ok.json()).toEqual({ message: 'memberships row not found' });
    const bad = await app.inject({ method: 'GET', url: '/memberships/1/nope' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain('userId');
  });

  describe('a table with no primary key', () => {
    it('still lists', async () => {
      const res = await app.inject({ method: 'GET', url: '/auditLog' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it('still creates', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auditLog',
        ...json(JSON.stringify({ at: 'now', what: 'thing' })),
      });
      expect(res.statusCode).toBe(500);
    });

    it('has no route that addresses one row', async () => {
      // The router's own 404, telling itself apart from a stub's: it names the route.
      const res = await app.inject({ method: 'GET', url: '/auditLog/1' });
      expect(res.statusCode).toBe(404);
      expect(res.json().message).toContain('Route');
      expect((await app.inject({ method: 'DELETE', url: '/auditLog/1' })).statusCode).toBe(404);
      expect(
        (await app.inject({ method: 'PATCH', url: '/auditLog/1', ...json('{}') })).statusCode
      ).toBe(404);
    });
  });

  describe('a read-only table', () => {
    it('lists', async () => {
      expect((await app.inject({ method: 'GET', url: '/dailyTotals' })).statusCode).toBe(200);
    });

    it('refuses every write, because no such route exists', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/dailyTotals',
        ...json(JSON.stringify({ day: 'x', total: 1 })),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('the request schemas the builder shaped beyond plain types', () => {
    it('enforces the date-time format, because ajv-formats is in the default compiler', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/events',
        ...json(
          JSON.stringify({
            at: 'garbage',
            flag: true,
            big: '9007199254740993',
            point: [1, 2],
            note: null,
          })
        ),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('at');
    });

    it('enforces the respelled tuple: member type and both length bounds', async () => {
      const base = {
        at: '2026-01-02T03:04:05.000Z',
        flag: true,
        big: '9007199254740993',
        note: null,
      };
      const wrongMember = await app.inject({
        method: 'POST',
        url: '/events',
        ...json(JSON.stringify({ ...base, point: [1, 'x'] })),
      });
      expect(wrongMember.statusCode).toBe(400);
      const tooLong = await app.inject({
        method: 'POST',
        url: '/events',
        ...json(JSON.stringify({ ...base, point: [1, 2, 3] })),
      });
      expect(tooLong.statusCode).toBe(400);
      const ok = await app.inject({
        method: 'POST',
        url: '/events',
        ...json(JSON.stringify({ ...base, point: [1, 2] })),
      });
      expect(ok.statusCode).toBe(500);
    });

    it('enforces the bigint string spelling on the way in', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/events',
        ...json(
          JSON.stringify({
            at: '2026-01-02T03:04:05.000Z',
            flag: true,
            big: 'not-digits',
            point: [1, 2],
            note: null,
          })
        ),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('big');
    });
  });
});

/**
 * The serializer round-trip: the load-bearing test of this whole design.
 *
 * fast-json-stringify writes only what the response schema names, so the proof that no column is
 * lost has to be a full row travelling through the emitted route's own response schema. The
 * emitted handler is an honest stub returning an empty list, so the row is injected through a
 * preSerialization hook in a wrapper plugin: measured on fastify 5.11.2, the payload a
 * preSerialization hook returns is what the route's serializer then runs on, so the bytes on the
 * wire are produced by the emitted schema, not by the hook.
 */
describe('the full-row serialization round-trip', () => {
  let app: FastifyInstance;
  let replacement: unknown[] | null = null;

  beforeAll(async () => {
    const mod = await emitApp('roundtrip');
    app = Fastify();
    await app.register(async (scope) => {
      scope.addHook('preSerialization', async (req, _reply, payload) => {
        if (req.url.startsWith('/events') && Array.isArray(payload) && replacement) {
          return replacement;
        }
        return payload;
      });
      await scope.register(
        (mod as { eventsRoutes: FastifyPluginAsync }).eventsRoutes as FastifyPluginAsync,
        { prefix: '/events' }
      );
    });
    await app.ready();
    apps.push(app);
  });

  it('returns every column of an insert-shaped row, correctly typed', async () => {
    replacement = [
      {
        id: 7,
        at: new Date('2026-01-02T03:04:05.000Z'),
        flag: true,
        big: 9007199254740993n,
        point: [1.5, -2.25],
        note: null,
      },
    ];
    const res = await app.inject({ method: 'GET', url: '/events' });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<Record<string, unknown>>;
    // Deep equality over the whole row: a select schema missing any column fails here, because
    // the serializer would have omitted it without any error.
    expect(rows).toEqual([
      {
        id: 7,
        at: '2026-01-02T03:04:05.000Z',
        flag: true,
        big: '9007199254740993',
        point: [1.5, -2.25],
        note: null,
      },
    ]);
    // Types asserted beside values: JSON formatting renames NaN and the infinities to null, so
    // equality alone has fooled a debugging session in this repo before.
    const row = rows[0];
    expect(typeof row.id).toBe('number');
    expect(typeof row.at).toBe('string');
    expect(typeof row.flag).toBe('boolean');
    expect(typeof row.big).toBe('string');
    expect(Array.isArray(row.point)).toBe(true);
    expect(row.note).toBeNull();
  });

  it('omits a property the schema does not name, silently, as measured', async () => {
    replacement = [
      {
        id: 7,
        at: new Date('2026-01-02T03:04:05.000Z'),
        flag: true,
        big: 1n,
        point: [0, 0],
        note: null,
        leaked: 'must not appear',
      },
    ];
    const res = await app.inject({ method: 'GET', url: '/events' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('leaked');
    expect(res.body).not.toContain('must not appear');
  });

  it('turns a value the schema cannot convert into a 500, not into silence', async () => {
    // The measured violation behaviour: a non-numeric string where integer is declared throws
    // inside fast-json-stringify and Fastify answers 500. The quieter violations (float
    // truncation, null becoming "", enum outsiders passing through) are recorded in
    // src/index.ts; this is the one that is observable as a status.
    replacement = [
      {
        id: 'abc',
        at: new Date('2026-01-02T03:04:05.000Z'),
        flag: true,
        big: 1n,
        point: [0, 0],
        note: null,
      },
    ];
    const res = await app.inject({ method: 'GET', url: '/events' });
    expect(res.statusCode).toBe(500);
    expect(res.json().message).toContain('cannot be converted');
  });
});
