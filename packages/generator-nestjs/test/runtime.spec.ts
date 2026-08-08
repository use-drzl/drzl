/**
 * The emitted DTOs run through Nest's real machinery, not a simulation of it: the consumer tree
 * (generated DTOs plus a controller written the way the docs show) is compiled by a real `tsc`
 * with the standard Nest flags (`experimentalDecorators`, `emitDecoratorMetadata`), the
 * compiled JavaScript is booted with `NestFactory.create` on the default Express adapter, and
 * every assertion is an HTTP request against the listening server. That path is chosen over a
 * standalone `pipe.transform()` call because the claims under test are about Nest's wiring as
 * much as the pipe: the metatype reaching the pipe through `design:paramtypes`, the
 * `BadRequestException` becoming a 400 on the wire, and the parsed output being what the
 * controller actually receives. A vitest-transpiled controller could not prove any of that,
 * because esbuild does not emit decorator metadata and the metatype would silently be
 * undefined, which is exactly the kind of vacuous pass this suite must not contain.
 *
 * Every rejection is paired with an acceptance that proves the validator was in the loop: the
 * controllers echo what the pipe handed them, so a 201 carries the parsed body and the
 * assertions can see the transform happened (a numeric key arriving as a real number, an
 * undeclared key already stripped) rather than assume it.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { NestJSGenerator } from '../src';
import { analysis, books, dailyTotals, events, memberships, users } from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const consumer = path.join(pkgRoot, 'test', 'tmp', 'runtime', 'consumer');
const tsc = path.join(pkgRoot, 'node_modules', '.bin', 'tsc');

const LIBS = ['zod', 'valibot', 'arktype'] as const;
type LibName = (typeof LIBS)[number];

/**
 * The consumer's own controller, identical for every library: the DTO surface is the same, so
 * the only difference between the three apps is which api directory the imports come from.
 * `bigint-hazard` returns a real bigint on purpose, to pin why the DTOs keep bigint columns as
 * strings: Express's res.json throws on it and the response is a 500.
 */
const appSource = (lib: LibName) => `import 'reflect-metadata';
import { Body, Controller, Get, Module, Param, Patch, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import {
  CreateUsersDto,
  UpdateUsersDto,
  UsersParamsDto,
  MembershipsParamsDto,
  BooksParamsDto,
  CreateEventsDto,
  DailyTotalsEntity,
  SchemaValidationPipe,
} from './api-${lib}/index.js';

class ForeignDto {
  anything!: unknown;
}

@Controller('users')
class UsersController {
  @Post()
  create(@Body() body: CreateUsersDto) {
    return { got: body };
  }

  @Patch(':id')
  update(@Param() params: UsersParamsDto, @Body() body: UpdateUsersDto) {
    return { id: params.id, got: body };
  }

  @Get(':id')
  byId(@Param() params: UsersParamsDto) {
    return { id: params.id, type: typeof params.id };
  }
}

@Controller('memberships')
class MembershipsController {
  @Get(':orgId/:userId')
  byKey(@Param() params: MembershipsParamsDto) {
    return { orgId: params.orgId, userId: params.userId };
  }
}

@Controller('books')
class BooksController {
  @Get(':isbn')
  byId(@Param() params: BooksParamsDto) {
    return { isbn: params.isbn, type: typeof params.isbn };
  }
}

@Controller('events')
class EventsController {
  @Post()
  create(@Body() body: CreateEventsDto) {
    return {
      atIsDate: body.at instanceof Date,
      atIso: body.at instanceof Date ? body.at.toISOString() : null,
      big: body.big,
      bigType: typeof body.big,
      note: body.note,
    };
  }
}

@Controller('dailyTotals')
class DailyTotalsController {
  @Get()
  list(): DailyTotalsEntity[] {
    return [];
  }
}

@Controller('hazards')
class HazardsController {
  @Get('bigint')
  bigintHazard() {
    return { big: 1n };
  }

  @Post('foreign')
  foreign(@Body() body: ForeignDto) {
    return { got: body };
  }
}

@Module({
  controllers: [
    UsersController,
    MembershipsController,
    BooksController,
    EventsController,
    DailyTotalsController,
    HazardsController,
  ],
})
class AppModule {}

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new SchemaValidationPipe());
  await app.listen(0);
  return app;
}
`;

const apps = new Map<LibName, { app: INestApplication; base: string }>();

beforeAll(async () => {
  await fs.rm(path.join(pkgRoot, 'test', 'tmp', 'runtime'), { recursive: true, force: true });
  await fs.mkdir(consumer, { recursive: true });
  const tableSet = [users, books, memberships, dailyTotals, events];
  for (const lib of LIBS) {
    await new NestJSGenerator(analysis(tableSet)).generate({
      outputDir: path.join(consumer, `api-${lib}`),
      validation: { library: lib },
    });
    await fs.writeFile(path.join(consumer, `app-${lib}.ts`), appSource(lib));
  }
  await fs.writeFile(path.join(consumer, 'package.json'), '{"name":"consumer","type":"module"}');
  await fs.writeFile(
    path.join(consumer, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: 'es2022',
          module: 'nodenext',
          moduleResolution: 'nodenext',
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          skipLibCheck: true,
          outDir: 'dist',
          rootDir: '.',
        },
        include: ['api-zod', 'api-valibot', 'api-arktype', 'app-*.ts'],
      },
      null,
      2
    )
  );
  execFileSync(tsc, ['-p', path.join(consumer, 'tsconfig.json')], { cwd: consumer, stdio: 'pipe' });
  for (const lib of LIBS) {
    const mod = (await import(
      pathToFileURL(path.join(consumer, 'dist', `app-${lib}.js`)).href
    )) as { createApp: () => Promise<INestApplication> };
    const app = await mod.createApp();
    const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    apps.set(lib, { app, base });
  }
}, 120_000);

afterAll(async () => {
  await Promise.all([...apps.values()].map(({ app }) => app.close()));
  await fs.rm(path.join(pkgRoot, 'test', 'tmp', 'runtime'), { recursive: true, force: true });
});

async function req(lib: LibName, method: string, url: string, body?: unknown) {
  const { base } = apps.get(lib)!;
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // A non-JSON error page; the status is what the assertion reads.
  }
  return { status: res.status, json, text };
}

describe('the zod app, the full policy grid', () => {
  const lib = 'zod' as const;

  it('parses a valid create body and hands the controller exactly the declared shape', async () => {
    const res = await req(lib, 'POST', '/users', { email: 'a@b.c', bio: null, zzz: 'extra' });
    expect(res.status).toBe(201);
    // The undeclared key is stripped by the schema, not assumed away: it must be absent from
    // what the controller echoed back.
    expect(res.json).toEqual({ got: { email: 'a@b.c', bio: null } });
  });

  it('requires a nullable no-default column to be present: {} is not sending null', async () => {
    const res = await req(lib, 'POST', '/users', { email: 'a@b.c' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('bio');
  });

  it('rejects a body missing a required field, naming the field', async () => {
    const res = await req(lib, 'POST', '/users', { bio: 'no email here' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('email');
  });

  it('rejects an enum outsider naming the column, and accepts a member', async () => {
    const bad = await req(lib, 'POST', '/users', { email: 'a@b.c', bio: null, role: 'boss' });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain('role');
    const ok = await req(lib, 'POST', '/users', { email: 'a@b.c', bio: null, role: 'member' });
    expect(ok.status).toBe(201);
    expect(ok.json).toEqual({ got: { email: 'a@b.c', bio: null, role: 'member' } });
  });

  it('does not coerce a number into a declared string', async () => {
    // The Fastify generator inherits AJV coercion and accepts this; these DTOs are on the
    // strict side with Hono and Express, and the divergence is documented.
    const res = await req(lib, 'POST', '/users', { email: 123, bio: null });
    expect(res.status).toBe(400);
    expect(res.text).toContain('email');
  });

  it('parses a numeric key into a real number', async () => {
    const res = await req(lib, 'GET', '/users/1');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ id: 1, type: 'number' });
  });

  it('rejects the segments Number() would misread', async () => {
    // Number(' ') is 0, so an idiomatic coercion reads GET /users/%20 as row 0. The strict
    // segment grid, asserted over HTTP because the URL decoding is part of what is tested.
    for (const seg of ['%20', '0x10', '1e5', 'abc']) {
      expect((await req(lib, 'GET', `/users/${seg}`)).status, seg).toBe(400);
    }
  });

  it('keeps the fractional spelling the route generators keep', async () => {
    const res = await req(lib, 'GET', '/users/1.5');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ id: 1.5, type: 'number' });
  });

  it('accepts an empty patch, rejects a bad one, and never lets the primary key through', async () => {
    const empty = await req(lib, 'PATCH', '/users/1', {});
    expect(empty.status).toBe(200);
    expect(empty.json).toEqual({ id: 1, got: {} });
    const bad = await req(lib, 'PATCH', '/users/1', { role: 'boss' });
    expect(bad.status).toBe(400);
    // The update schema excludes the key columns, so an id in the body is an undeclared key
    // and is stripped: the controller sees the path's id and no body id.
    const sneaky = await req(lib, 'PATCH', '/users/1', { id: 99, email: 'new@b.c' });
    expect(sneaky.status).toBe(200);
    expect(sneaky.json).toEqual({ id: 1, got: { email: 'new@b.c' } });
  });

  it('addresses a composite key through every segment of the path', async () => {
    const ok = await req(lib, 'GET', '/memberships/1/2');
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ orgId: 1, userId: 2 });
    const bad = await req(lib, 'GET', '/memberships/1/nope');
    expect(bad.status).toBe(400);
    expect(bad.text).toContain('userId');
  });

  it('accepts a space in a string key, which is a valid string', async () => {
    const res = await req(lib, 'GET', '/books/%20');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ isbn: ' ', type: 'string' });
  });

  it('parses a Date column from its strict ISO form and hands the controller a real Date', async () => {
    const res = await req(lib, 'POST', '/events', {
      at: '2026-01-02T03:04:05.000Z',
      flag: true,
      big: '9007199254740993',
      point: [1, 2],
      note: null,
    });
    expect(res.status).toBe(201);
    const body = res.json as Record<string, unknown>;
    expect(body.atIsDate).toBe(true);
    expect(body.atIso).toBe('2026-01-02T03:04:05.000Z');
    // The bigint wire form survives exactly: no Number() rounding of 9007199254740993.
    expect(body.big).toBe('9007199254740993');
    expect(body.bigType).toBe('string');
    expect(body.note).toBeNull();
  });

  it('rejects the Date spellings new Date() would misread', async () => {
    const base = { flag: true, big: '1', point: [1, 2], note: null };
    for (const at of ['garbage', '1', '2026-01-02']) {
      // new Date('1') is the year 2001 and new Date('2026-01-02') a midnight the sender never
      // wrote; the class-validator path accepts both (measured, docs grid). The strict ISO
      // datetime spelling refuses them.
      const res = await req(lib, 'POST', '/events', { ...base, at });
      expect(res.status, at).toBe(400);
      expect(res.text).toContain('at');
    }
  });

  it('rejects a bigint column that is not decimal digits', async () => {
    const base = { at: '2026-01-02T03:04:05.000Z', flag: true, point: [1, 2], note: null };
    expect((await req(lib, 'POST', '/events', { ...base, big: 'abc' })).status).toBe(400);
    expect((await req(lib, 'POST', '/events', { ...base, big: 12 })).status).toBe(400);
  });

  it('pins why bigint stays a string: a real bigint cannot be serialized at all', async () => {
    const res = await req(lib, 'GET', '/hazards/bigint');
    expect(res.status).toBe(500);
  });

  it('has no create route for the read-only table, because there is no create DTO', async () => {
    const res = await req(lib, 'POST', '/dailyTotals', { day: 'x', total: 1 });
    expect(res.status).toBe(404);
    const list = await req(lib, 'GET', '/dailyTotals');
    expect(list.status).toBe(200);
    expect(list.json).toEqual([]);
  });

  it('passes a foreign DTO through untouched, so the pipe coexists with the rest of the app', async () => {
    const res = await req(lib, 'POST', '/hazards/foreign', { x: 1, keep: 'me' });
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ got: { x: 1, keep: 'me' } });
  });

  it('answers 400 for a body that is not JSON at all', async () => {
    const res = await req(lib, 'POST', '/users', '{not json');
    expect(res.status).toBe(400);
  });
});

describe.each(['valibot', 'arktype'] as const)('the %s app, the shared policy rows', (lib) => {
  it('parses a valid create body and strips the undeclared key', async () => {
    const res = await req(lib, 'POST', '/users', { email: 'a@b.c', bio: null, zzz: 'extra' });
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ got: { email: 'a@b.c', bio: null } });
  });

  it('requires the nullable no-default column to be present', async () => {
    const res = await req(lib, 'POST', '/users', { email: 'a@b.c' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('bio');
  });

  it('rejects an enum outsider and accepts a member', async () => {
    expect(
      (await req(lib, 'POST', '/users', { email: 'a@b.c', bio: null, role: 'boss' })).status
    ).toBe(400);
    const ok = await req(lib, 'POST', '/users', { email: 'a@b.c', bio: null, role: 'member' });
    expect(ok.status).toBe(201);
  });

  it('parses a numeric key and refuses the Number() family', async () => {
    const ok = await req(lib, 'GET', '/users/1');
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ id: 1, type: 'number' });
    for (const seg of ['%20', '0x10', '1e5', 'abc']) {
      expect((await req(lib, 'GET', `/users/${seg}`)).status, seg).toBe(400);
    }
  });

  it('holds the Date and bigint wire shapes', async () => {
    const good = await req(lib, 'POST', '/events', {
      at: '2026-01-02T03:04:05.000Z',
      flag: true,
      big: '9007199254740993',
      point: [1, 2],
      note: null,
    });
    expect(good.status).toBe(201);
    const body = good.json as Record<string, unknown>;
    expect(body.atIsDate).toBe(true);
    expect(body.big).toBe('9007199254740993');
    const base = { flag: true, big: '1', point: [1, 2], note: null };
    expect((await req(lib, 'POST', '/events', { ...base, at: 'garbage' })).status).toBe(400);
    expect(
      (
        await req(lib, 'POST', '/events', {
          ...base,
          at: '2026-01-02T03:04:05.000Z',
          big: 'abc',
        })
      ).status
    ).toBe(400);
  });

  it('pins where the ISO edges land for this library', async () => {
    // Measured divergence, documented on the docs page: valibot's isoTimestamp rejects a bare
    // date, arktype's string.date.iso accepts any ISO 8601 form including one. Pinned per
    // library so a release that moves either edge fails here instead of drifting in silence.
    const base = { flag: true, big: '1', point: [1, 2], note: null };
    const res = await req(lib, 'POST', '/events', { ...base, at: '2026-01-02' });
    expect(res.status).toBe(lib === 'arktype' ? 201 : 400);
  });
});
