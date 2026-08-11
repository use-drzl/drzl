/**
 * The emitted server is stood up and driven by a real MCP client.
 *
 * Everything this generator claims is a claim about a running server, and none of it is visible in
 * the text: whether a schema handed to `registerTool` produces a tool whose arguments are actually
 * advertised, whether a bound survives the conversion into the JSON Schema a model reads, whether
 * an out-of-range argument is refused before the handler runs or merely described as invalid in a
 * comment, and whether a key column arrives as a number rather than as the string an HTTP path
 * would have carried. A text assertion can see none of those, and the valibot case in particular
 * fails silently: a schema with no `~standard.jsonSchema` registers cleanly and advertises a tool
 * with no arguments at all.
 *
 * No subprocess and no stdio. `InMemoryTransport.createLinkedPair()` is the SDK's own in-process
 * transport, so the client and server exchange real JSON-RPC messages over the same code path a
 * stdio server takes, with the serialization included.
 *
 * `importExtension: 'none'` because this module graph is loaded by vite, which resolves `./users`
 * to `./users.ts`. The `.js` default is the form a real `tsc` resolves, and it is compiled under
 * all four moduleResolution settings in output-typechecks.spec.ts.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { MCPGenerator } from '../src';
import {
  analysis,
  auditLog,
  books,
  dailyTotals,
  events,
  memberships,
  products,
  users,
} from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');

type Lib = 'zod' | 'valibot' | 'arktype';

/** The tables every case is built from, so one listing answers every question about coverage. */
const TABLES = [users, products, books, memberships, auditLog, dailyTotals, events];

async function connect(lib: Lib, dir: string, extra: Record<string, unknown> = {}): Promise<Client> {
  const out = path.join(pkgRoot, 'test', 'tmp', 'runtime', dir);
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(out, { recursive: true });
  const gen = new MCPGenerator(analysis(TABLES));
  await gen.generate({
    outputDir: path.relative(process.cwd(), out),
    importExtension: 'none',
    validation: { library: lib },
    ...extra,
  });
  const mod = await import(pathToFileURL(path.join(out, 'index.ts')).href);
  const server = mod.createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'drzl-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

/** The advertised JSON Schema of one tool's arguments, which is what a model reads. */
async function inputSchemaOf(client: Client, name: string): Promise<Record<string, any>> {
  const listed = await client.listTools();
  const tool = listed.tools.find((t) => t.name === name);
  expect(tool, `no tool named ${name} in ${listed.tools.map((t) => t.name).join(', ')}`).toBeTruthy();
  return tool!.inputSchema as Record<string, any>;
}

function textOf(result: any): string {
  return (result.content ?? []).map((c: any) => c.text ?? '').join('\n');
}

describe.each(['zod', 'valibot', 'arktype'] as const)('a generated server (%s)', (lib) => {
  let client: Client;
  beforeAll(async () => {
    client = await connect(lib, lib);
  }, 30_000);

  it('advertises five tools for a writable table with a key', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'users_list',
        'users_get',
        'users_create',
        'users_update',
        'users_delete',
      ])
    );
  });

  it('gives a keyless table nothing that addresses a row, but keeps its create', async () => {
    // Inserting a row does not require being able to address one afterwards, which is why create
    // survives here and get, update and delete do not.
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => n.startsWith('auditLog_')).sort()).toEqual([
      'auditLog_create',
      'auditLog_list',
    ]);
  });

  it('gives a read-only table no write tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    const daily = names.filter((n) => n.startsWith('daily_totals_'));
    expect(daily).toEqual(['daily_totals_list']);
  });

  it('advertises the arguments of every tool, rather than an empty object', async () => {
    // The valibot failure this catches is silent: a schema with no `~standard.jsonSchema` is
    // accepted by `registerTool` and produces `{"type":"object","properties":{}}`, so the model is
    // told the tool takes nothing and every call it makes is empty.
    const schema = await inputSchemaOf(client, 'users_create');
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(['email', 'bio', 'seenAt'])
    );
  });

  it('carries the page-size bounds into the schema a model reads', async () => {
    const schema = await inputSchemaOf(client, 'users_list');
    expect(schema.properties.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 200 });
  });

  it('refuses an out-of-range argument before the handler runs', async () => {
    const bad: any = await client.callTool({ name: 'users_list', arguments: { limit: 5000 } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/validation|invalid/i);
    // And the same tool with an in-range value runs the handler, so the refusal above is the
    // bound talking rather than the tool being broken.
    const ok: any = await client.callTool({ name: 'users_list', arguments: { limit: 10 } });
    expect(ok.isError ?? false).toBe(false);
    expect(JSON.parse(textOf(ok))).toEqual([]);
  });

  it('applies the page-size default when the model omits it', async () => {
    const ok: any = await client.callTool({ name: 'users_list', arguments: {} });
    expect(ok.isError ?? false).toBe(false);
  });

  it('takes a numeric key as a number, not as the string an HTTP path would carry', async () => {
    const schema = await inputSchemaOf(client, 'users_get');
    expect(schema.properties.id).toMatchObject({ type: 'number' });
    const ok: any = await client.callTool({ name: 'users_get', arguments: { id: 1 } });
    expect(ok.isError ?? false).toBe(false);
    const bad: any = await client.callTool({ name: 'users_get', arguments: { id: '1' } });
    expect(bad.isError, 'a string was accepted for a numeric key').toBe(true);
  });

  it('addresses a composite key by every one of its columns', async () => {
    const schema = await inputSchemaOf(client, 'memberships_get');
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['orgId', 'userId']);
    const partial: any = await client.callTool({
      name: 'memberships_get',
      arguments: { orgId: 1 },
    });
    expect(partial.isError, 'half a composite key addressed a row').toBe(true);
  });

  it('keeps a natural string key as a string', async () => {
    const schema = await inputSchemaOf(client, 'books_get');
    expect(schema.properties.isbn).toMatchObject({ type: 'string' });
  });

  it('takes a date column as an ISO string', async () => {
    const schema = await inputSchemaOf(client, 'users_create');
    // Whatever each library spells it as, the advertised type is a string and never an object,
    // which is the whole reason the tool schemas are built from the wire modes.
    const seenAt = JSON.stringify(schema.properties.seenAt);
    expect(seenAt).toContain('"string"');
    const bad: any = await client.callTool({
      name: 'users_create',
      arguments: { email: 'a@b.c', seenAt: 'not-a-date' },
    });
    expect(bad.isError).toBe(true);
    expect(textOf(bad), 'a bad date reached the handler').not.toMatch(/Not implemented/);
  });

  it('reaches the handler once the arguments are valid', async () => {
    const r: any = await client.callTool({
      name: 'users_create',
      arguments: { email: 'a@b.c', seenAt: '2026-08-11T00:00:00Z' },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Not implemented: create users/);
  });

  it('separates the addressing half of an update from the patch', async () => {
    const schema = await inputSchemaOf(client, 'users_update');
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['data', 'where']);
    const bad: any = await client.callTool({
      name: 'users_update',
      arguments: { where: {}, data: { email: 'a@b.c' } },
    });
    expect(bad.isError, 'an update with no key addressed a row').toBe(true);
  });

  it('names the CHECK constraints a schema cannot express', async () => {
    const listed = await client.listTools();
    const create = listed.tools.find((t) => t.name === 'products_create');
    // `price > cost` compares two columns, so no per-field JSON Schema keyword can carry it and
    // the description is the only place a model can learn it exists.
    expect(create?.description).toContain('price > cost');
    expect(create?.description).toContain('margin');
  });

  it('marks a delete destructive and a read read-only', async () => {
    const listed = await client.listTools();
    const byName = new Map(listed.tools.map((t) => [t.name, t]));
    expect(byName.get('users_delete')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(byName.get('users_list')?.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.get('users_create')?.annotations).toMatchObject({ destructiveHint: false });
  });

  it('advertises an enum column as its own values', async () => {
    const schema = await inputSchemaOf(client, 'events_create');
    expect(JSON.stringify(schema.properties.kind)).toContain('created');
  });
});

describe('the shared-schema path', () => {
  /**
   * The constraint story, end to end.
   *
   * A DRZL zod schema for a column with a `CHECK (age BETWEEN 18 AND 120)` carries `.min(18)` and
   * `.max(120)`, and this asserts that such a schema, imported through `validation.useShared`,
   * reaches `tools/list` as `{"minimum":18,"maximum":120}` and refuses 7 before the handler runs.
   * That is the difference between a model that guesses and a model that is told.
   *
   * The shared module is written by the test rather than by `@drzl/generator-zod`, deliberately:
   * this is a test of *this* package's wiring, and depending on a sibling package's `dist` here
   * would make a green run mean "the last build of the zod generator was fine" instead.
   */
  it('carries a constrained schema all the way into the advertised bounds', async () => {
    const out = path.join(pkgRoot, 'test', 'tmp', 'runtime', 'shared');
    const shared = path.join(out, 'schemas');
    await fs.rm(out, { recursive: true, force: true });
    await fs.mkdir(shared, { recursive: true });
    await fs.writeFile(
      path.join(shared, 'index.ts'),
      [
        "import { z } from 'zod';",
        'export const InsertusersSchema = z.object({',
        '  email: z.string().max(320),',
        '  age: z.number().int().min(18).max(120),',
        '});',
        'export const UpdateusersSchema = InsertusersSchema.partial();',
        'export const SelectusersSchema = InsertusersSchema.extend({ id: z.number() });',
        '',
      ].join('\n'),
      'utf8'
    );

    const gen = new MCPGenerator(analysis([users]));
    await gen.generate({
      outputDir: path.relative(process.cwd(), out),
      importExtension: 'none',
      validation: { library: 'zod', useShared: true, importPath: path.relative(process.cwd(), shared) },
    });

    const mod = await import(pathToFileURL(path.join(out, 'index.ts')).href);
    const server = mod.createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'drzl-test', version: '0.0.0' });
    await client.connect(clientTransport);

    const schema = await inputSchemaOf(client, 'users_create');
    expect(schema.properties.age).toMatchObject({ type: 'integer', minimum: 18, maximum: 120 });
    expect(schema.properties.email).toMatchObject({ maxLength: 320 });

    const bad: any = await client.callTool({
      name: 'users_create',
      arguments: { email: 'a@b.c', age: 7 },
    });
    expect(bad.isError).toBe(true);
    expect(textOf(bad), 'an age below the CHECK bound reached the handler').not.toMatch(
      /Not implemented/
    );

    const ok: any = await client.callTool({
      name: 'users_create',
      arguments: { email: 'a@b.c', age: 30 },
    });
    expect(textOf(ok)).toMatch(/Not implemented: create users/);
    await client.close();
  }, 30_000);
});
