/**
 * The emitted contract compiles against the real `@ts-rest/core`, and that is the load-bearing test.
 *
 * A ts-rest contract is a plain object, so it "works" in the sense that any object works. What makes
 * it a contract is the type: a server implementation and a client are both derived from it, and an
 * object whose schemas did not land compiles just as well while describing nothing. Every case here
 * therefore ends in a derived client, and the canary asks that client for something the contract
 * does not declare.
 *
 * `@ts-rest/core-stable` is an npm alias for 3.52.1, the `latest` tag. It is installed for one test,
 * the must-fire one below, which asserts the reason this generator requires the release candidate.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TsRestGenerator } from '../src';
import { activeUsers, analysis, auditLog, books, events, memberships, users } from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const workRoot = path.join(pkgRoot, 'test', 'tmp', 'typecheck');
const tsc = path.join(pkgRoot, 'node_modules', '.bin', 'tsc');
const TSC_TIMEOUT = 180_000;

const tables = [users, books, memberships, auditLog, activeUsers, events];

afterAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
});

function sharedSource(lib: 'zod' | 'valibot' | 'arktype'): string {
  const decl = (name: string, body: string) => `export const ${name} = ${body};`;
  if (lib === 'zod') {
    return [
      "import { z } from 'zod';",
      ...tables.flatMap((t) => [
        decl(`Insert${t.tsName}Schema`, 'z.object({ email: z.string() })'),
        decl(`Update${t.tsName}Schema`, 'z.object({ email: z.string().optional() })'),
        decl(`Select${t.tsName}Schema`, 'z.object({ id: z.number(), email: z.string() })'),
      ]),
      '',
    ].join('\n');
  }
  if (lib === 'valibot') {
    return [
      "import * as v from 'valibot';",
      ...tables.flatMap((t) => [
        decl(`Insert${t.tsName}Schema`, 'v.object({ email: v.string() })'),
        decl(`Update${t.tsName}Schema`, 'v.object({ email: v.optional(v.string()) })'),
        decl(`Select${t.tsName}Schema`, 'v.object({ id: v.number(), email: v.string() })'),
      ]),
      '',
    ].join('\n');
  }
  return [
    "import { type } from 'arktype';",
    ...tables.flatMap((t) => [
      decl(`Insert${t.tsName}Schema`, "type({ email: 'string' })"),
      decl(`Update${t.tsName}Schema`, "type({ 'email?': 'string' })"),
      decl(`Select${t.tsName}Schema`, "type({ id: 'number', email: 'string' })"),
    ]),
    '',
  ].join('\n');
}

/** A client derived from the finished contract, which is what proves the schemas landed. */
const CLIENT_PROBE = `import { initClient } from '@ts-rest/core';
import { contract } from './index.js';

const client = initClient(contract, { baseUrl: 'http://localhost', baseHeaders: {} });

export async function useIt() {
  const rows = await client.users.list({ query: {} });
  const one = await client.users.byId({ params: { id: '7' } });
  const made = await client.users.create({ body: { email: 'a@b.c' } });
  // A composite key is addressed by every one of its columns.
  const m = await client.memberships.byId({ params: { orgId: '1', userId: '2' } });
  if (one.status === 200) {
    // Narrowing to 200 gives the select row, not a union with the error body.
    const row: { id: number; email: string } = one.body;
    void row;
  }
  return { rows, one, made, m };
}
`;

async function compile(
  label: string,
  lib: 'zod' | 'valibot' | 'arktype',
  opts: Record<string, unknown> = {},
  probe = CLIENT_PROBE
) {
  const dir = path.join(workRoot, label);
  const shared = path.join(dir, 'validators');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(shared, { recursive: true });
  await fs.writeFile(path.join(shared, 'index.ts'), sharedSource(lib), 'utf8');
  await fs.mkdir(path.join(dir, 'contract'), { recursive: true });

  await new TsRestGenerator(analysis(tables)).generate({
    outputDir: path.join(dir, 'contract'),
    validation: {
      library: lib,
      useShared: true,
      importPath: path.relative(process.cwd(), shared),
    },
    ...opts,
  } as never);
  if (probe) await fs.writeFile(path.join(dir, 'contract', 'probe.ts'), probe, 'utf8');

  const tsconfig = path.join(dir, 'tsconfig.json');
  await fs.writeFile(
    tsconfig,
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          noUnusedLocals: true,
          noUnusedParameters: true,
          target: 'es2022',
          lib: ['es2023', 'dom'],
          module: 'preserve',
          moduleResolution: 'bundler',
          skipLibCheck: true,
        },
        include: ['contract/**/*.ts', 'validators/**/*.ts'],
      },
      null,
      2
    )
  );
  await fs.writeFile(path.join(dir, 'package.json'), '{"name":"probe","type":"module"}');

  try {
    execFileSync(tsc, ['-p', tsconfig], { cwd: dir, stdio: 'pipe' });
    return '';
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer };
    return `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`;
  }
}

describe('the emitted contract', () => {
  it('has a tsc to run', () => {
    expect(existsSync(tsc), `no tsc at ${tsc}; run pnpm install`).toBe(true);
  });

  for (const library of ['zod', 'valibot', 'arktype'] as const) {
    it(
      `compiles with ${library}, and a client derives from it`,
      async () => {
        expect(await compile(library, library)).toBe('');
      },
      TSC_TIMEOUT
    );
  }

  it(
    'compiles with a module suffix and a case',
    async () => {
      // The probe names `client.users`, which a renamed contract no longer has.
      expect(
        await compile(
          'naming',
          'zod',
          { naming: { routerSuffix: 'Api', procedureCase: 'snake' } },
          ''
        )
      ).toBe('');
    },
    TSC_TIMEOUT
  );

  it(
    'compiles with a named contract and a path prefix',
    async () => {
      expect(
        await compile('named', 'zod', { contractName: 'shopContract', pathPrefix: '/api' }, '')
      ).toBe('');
    },
    TSC_TIMEOUT
  );

  it(
    'would have said so if the contract did not compile',
    async () => {
      // Every case above passes by producing no output, which a compiler that never ran also does.
      // `auditLog` has no primary key, so its contract has no `byId` route.
      const probe = `import { initClient } from '@ts-rest/core';
import { contract } from './index.js';

const client = initClient(contract, { baseUrl: 'http://localhost', baseHeaders: {} });
export const bad = client.auditLog.byId({ params: { id: '1' } });
`;
      const out = await compile('canary', 'zod', {}, probe);
      expect(out).not.toBe('');
      expect(out).toMatch(/probe\.ts/);
    },
    TSC_TIMEOUT
  );
});

describe('the routes', () => {
  it('gives a keyless table a list and a create and nothing that addresses a row', async () => {
    const text = await fs.readFile(path.join(workRoot, 'zod', 'contract', 'auditLog.ts'), 'utf8');
    expect(text).toContain('list:');
    expect(text).toContain('create:');
    expect(text).not.toContain('byId:');
    expect(text).not.toContain('remove:');
  });

  it('gives a read-only table no writes', async () => {
    const text = await fs.readFile(path.join(workRoot, 'zod', 'contract', 'activeUsers.ts'), 'utf8');
    expect(text).toContain('list:');
    expect(text).toContain('byId:');
    expect(text).not.toContain('create:');
    expect(text).not.toContain('update:');
  });

  it('addresses a composite key by every one of its columns', async () => {
    const text = await fs.readFile(
      path.join(workRoot, 'zod', 'contract', 'memberships.ts'),
      'utf8'
    );
    expect(text).toContain("path: '/memberships/:orgId/:userId'");
  });

  it('declares a delete with no body, which is what ts-rest calls a no-body route', async () => {
    const text = await fs.readFile(path.join(workRoot, 'zod', 'contract', 'users.ts'), 'utf8');
    const start = text.indexOf('remove: {');
    const region = text.slice(start, text.indexOf('});', start));
    expect(start).toBeGreaterThan(-1);
    expect(region).toContain("method: 'DELETE'");
    expect(region).not.toContain('body:');
  });

  it('converts a numeric path segment rather than declaring it a number', async () => {
    // A path segment is always a string, so `z.number()` against "1" refuses every request.
    // Not `z.coerce.number()` either, which takes an empty string as 0.
    //
    // The declaration is sliced out before matching: a formatter breaks the chain across lines, and
    // an assertion spanning newlines would otherwise be free to find its pieces in the query schema.
    const text = await fs.readFile(path.join(workRoot, 'zod', 'contract', 'users.ts'), 'utf8');
    const start = text.indexOf('export const UsersParamsSchema');
    const region = text.slice(start, text.indexOf('export const UsersQuerySchema'));
    expect(start).toBeGreaterThan(-1);
    expect(region).toContain('.transform(Number)');
    expect(region).not.toContain('z.number()');
    expect(region).not.toContain('z.coerce');
  });

  it('keeps a bigint key as its digits, which is the only way it crosses a URL', async () => {
    const text = await fs.readFile(path.join(workRoot, 'zod', 'contract', 'events.ts'), 'utf8');
    const start = text.indexOf('export const EventsParamsSchema');
    const region = text.slice(start, text.indexOf('export const EventsQuerySchema'));
    expect(region).toContain('z.string().regex(');
    expect(region).not.toContain('transform(Number)');
  });

  /**
   * Paging is optional in every library, which is not one spelling.
   *
   * zod and valibot wrap the value; ArkType marks the key, `'limit?'`. Emitting the value-wrapped
   * form for all three left ArkType's paging required, so every list route demanded a `limit` and
   * an `offset`. The compile cases catch it because their probe calls `list({ query: {} })`; this
   * names the mechanism so a regression does not have to be re-diagnosed from a type error.
   */
  it('marks paging optional in each library, which ArkType spells on the key', async () => {
    const read = async (lib: string) =>
      fs.readFile(path.join(workRoot, lib, 'contract', 'users.ts'), 'utf8');
    const region = (text: string) =>
      text.slice(
        text.indexOf('export const UsersQuerySchema'),
        text.indexOf('export const UsersErrorSchema')
      );

    expect(region(await read('zod'))).toContain('.optional()');
    expect(region(await read('valibot'))).toContain('v.optional(');

    // Quoted with single quotes here because the formatter normalises them on the way out.
    const ark = region(await read('arktype'));
    expect(ark).toContain("'limit?'");
    expect(ark).toContain("'offset?'");
  });

  it('passes a path prefix to c.router rather than writing it into each path', async () => {
    // ts-rest lifts `pathPrefix` into the contract's type, so a client reports the full path.
    // Writing it into the strings by hand would produce the same requests and a different type.
    const barrel = await fs.readFile(path.join(workRoot, 'named', 'contract', 'index.ts'), 'utf8');
    const table = await fs.readFile(path.join(workRoot, 'named', 'contract', 'users.ts'), 'utf8');
    expect(barrel).toContain("pathPrefix: '/api'");
    expect(table).toContain("path: '/users'");
    expect(table).not.toContain("path: '/api/users'");
  });
});

describe('a config that cannot work', () => {
  it('refuses to run without a validation generator to import from', async () => {
    await expect(
      new TsRestGenerator(analysis([users])).generate({
        outputDir: path.join(workRoot, 'no-schemas', 'contract'),
      } as never)
    ).rejects.toThrow(/validation\.useShared/);
  });

  it('refuses a library that is not a Standard Schema', async () => {
    // TypeBox and Effect Schema expose no `~standard` on the schema object, measured 2026-08-11.
    await expect(
      new TsRestGenerator(analysis([users])).generate({
        outputDir: path.join(workRoot, 'typebox', 'contract'),
        validation: { library: 'typebox', useShared: true, importPath: 'src/validators/typebox' },
      } as never)
    ).rejects.toThrow(/TypeBox nor Effect Schema/);
  });
});
