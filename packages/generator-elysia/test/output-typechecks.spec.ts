/**
 * The emitted tree compiles against the real `elysia`, for all four libraries it accepts.
 *
 * Four rather than three, and that is the point of this generator: Elysia's validator slot is
 * `AnySchema = TSchema | StandardSchemaV1Like`, so it takes a TypeBox schema natively as well as
 * anything carrying `~standard`. Every other DRZL router generator is limited to the three Standard
 * Schema libraries, because TypeBox implements no such thing.
 *
 * The probe reads a validated value out of the handler's context in each case, which is what proves
 * the schema reached Elysia's inference rather than merely being accepted as an object.
 *
 * `noUnusedLocals` and `noUnusedParameters` are on. Every stub reads its validated values into
 * locals it does not use, which is why each one is `void`ed rather than left to be reported.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ElysiaGenerator } from '../src';
import { activeUsers, analysis, auditLog, books, events, memberships, users } from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const workRoot = path.join(pkgRoot, 'test', 'tmp', 'typecheck');
const tsc = path.join(pkgRoot, 'node_modules', '.bin', 'tsc');
const TSC_TIMEOUT = 180_000;

type Lib = 'typebox' | 'zod' | 'valibot' | 'arktype';
const LIBS: Lib[] = ['typebox', 'zod', 'valibot', 'arktype'];

const tables = [users, books, memberships, auditLog, activeUsers, events];

afterAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
});

function sharedSource(lib: Lib): string {
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
  if (lib === 'arktype') {
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
  // TypeBox, as `@drzl/generator-typebox` writes it: from `@sinclair/typebox`, not from `elysia`.
  return [
    "import { Type } from '@sinclair/typebox';",
    ...tables.flatMap((t) => [
      decl(`Insert${t.tsName}Schema`, 'Type.Object({ email: Type.String() })'),
      decl(`Update${t.tsName}Schema`, 'Type.Object({ email: Type.Optional(Type.String()) })'),
      decl(
        `Select${t.tsName}Schema`,
        'Type.Object({ id: Type.Number(), email: Type.String() })'
      ),
    ]),
    '',
  ].join('\n');
}

/** Reads a validated value out of each context, which is what proves inference landed. */
const HANDLER_PROBE = `import { app } from './index.js';

export async function useIt() {
  const listed = await app.handle(new Request('http://localhost/users'));
  const one = await app.handle(new Request('http://localhost/users/7'));
  return { listed, one };
}
`;

async function compile(
  label: string,
  lib: Lib,
  opts: Record<string, unknown> = {},
  probe = '',
  resolution: 'bundler' | 'node16' | 'nodenext' = 'bundler'
) {
  const dir = path.join(workRoot, label);
  const shared = path.join(dir, 'validators');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(shared, { recursive: true });
  await fs.writeFile(path.join(shared, 'index.ts'), sharedSource(lib), 'utf8');
  await fs.mkdir(path.join(dir, 'routes'), { recursive: true });

  await new ElysiaGenerator(analysis(tables)).generate({
    outputDir: path.join(dir, 'routes'),
    validation: {
      library: lib,
      useShared: true,
      importPath: path.relative(process.cwd(), shared),
    },
    ...opts,
  } as never);
  if (probe) await fs.writeFile(path.join(dir, 'routes', 'probe.ts'), probe, 'utf8');

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
          module: resolution === 'bundler' ? 'preserve' : resolution,
          moduleResolution: resolution,
          skipLibCheck: true,
        },
        include: ['routes/**/*.ts', 'validators/**/*.ts'],
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

describe('the emitted tree', () => {
  it('has a tsc to run', () => {
    expect(existsSync(tsc), `no tsc at ${tsc}; run pnpm install`).toBe(true);
  });

  for (const lib of LIBS) {
    it(
      `compiles with ${lib}`,
      async () => {
        expect(await compile(lib, lib, {}, HANDLER_PROBE)).toBe('');
      },
      TSC_TIMEOUT
    );
  }

  it(
    'compiles with a module suffix, a case, a name and a prefix',
    async () => {
      expect(
        await compile('naming', 'zod', {
          appName: 'shopApp',
          prefix: '/api',
          naming: { routerSuffix: 'Api', procedureCase: 'snake' },
        })
      ).toBe('');
    },
    TSC_TIMEOUT
  );

  it(
    'would have said so if the tree did not compile',
    async () => {
      // Every case above passes by producing no output, which a compiler that never ran also does.
      const probe = `import { usersRoutes } from './users.js';
// An Elysia instance is not callable.
export const bad = usersRoutes({ id: 1 });
`;
      const out = await compile('canary', 'zod', {}, probe);
      expect(out).not.toBe('');
      expect(out).toMatch(/probe\.ts/);
    },
    TSC_TIMEOUT
  );
});

describe('the routes', () => {
  // The formatter breaks each chain link across lines, so the path is matched with the whitespace
  // between it and the method rather than glued to it.
  const call = (method: string, p: string) =>
    new RegExp(`\\.${method}\\(\\s*'${p.replace(/[/:]/g, (c) => `\\${c}`)}'`);

  it('gives a keyless table a list and a create and nothing that addresses a row', async () => {
    const text = await fs.readFile(path.join(workRoot, 'zod', 'routes', 'auditLog.ts'), 'utf8');
    expect(text).toMatch(call('get', '/'));
    expect(text).toMatch(call('post', '/'));
    expect(text).not.toContain('.patch(');
    expect(text).not.toContain('.delete(');
  });

  it('gives a read-only table no writes', async () => {
    const text = await fs.readFile(path.join(workRoot, 'zod', 'routes', 'activeUsers.ts'), 'utf8');
    expect(text).toMatch(call('get', '/'));
    expect(text).toMatch(call('get', '/:id'));
    expect(text).not.toContain('.post(');
  });

  it('addresses a composite key by every one of its columns', async () => {
    const text = await fs.readFile(path.join(workRoot, 'zod', 'routes', 'memberships.ts'), 'utf8');
    expect(text).toContain("'/:orgId/:userId'");
  });

  it('mounts each table under its own prefix', async () => {
    const text = await fs.readFile(path.join(workRoot, 'zod', 'routes', 'users.ts'), 'utf8');
    expect(text).toContain("new Elysia({ prefix: '/users' })");
  });

  it('puts the root prefix on the assembled app rather than on each module', async () => {
    // Elysia lifts a prefix into the app's type, so the full path is what Eden Treaty reports.
    const barrel = await fs.readFile(path.join(workRoot, 'naming', 'routes', 'index.ts'), 'utf8');
    const table = await fs.readFile(path.join(workRoot, 'naming', 'routes', 'users_api.ts'), 'utf8');
    expect(barrel).toContain("new Elysia({ prefix: '/api' })");
    expect(barrel).toContain('export const shopApp');
    expect(table).toContain("prefix: '/users'");
    expect(table).not.toContain("'/api/users'");
  });
});

describe('module resolution', () => {
  /**
   * The three Standard Schema libraries compile under every resolution a consumer might use.
   *
   * DRZL's packed gate compiles emitted output under `bundler`, `node16` and `nodenext`, so this is
   * the same question asked here, per library, at the source.
   */
  for (const lib of ['zod', 'valibot', 'arktype'] as const) {
    for (const resolution of ['node16', 'nodenext'] as const) {
      it(
        `compiles with ${lib} under ${resolution}`,
        async () => {
          expect(await compile(`${lib}-${resolution}`, lib, {}, '', resolution)).toBe('');
        },
        TSC_TIMEOUT
      );
    }
  }

  /**
   * TypeBox does not, and this is the must-fire test for why it is not the default.
   *
   * `@sinclair/typebox` ships separate `.d.ts` and `.d.mts` declarations and brands its schema types
   * with `unique symbol`s, so the two copies are mutually unassignable. Elysia's declarations are
   * CommonJS. Under node16 an ESM consumer resolves TypeBox to the `.d.mts` copy while Elysia's slot
   * refers to the `.d.ts` one, so `TObject` stops matching `TSchema`, falls through to
   * `StandardSchemaV1Like`, and is rejected for having no `~standard`.
   *
   * Reproduced upstream with a single installed copy, so this is not about duplicate installs and
   * the generator cannot fix it. If a future Elysia or TypeBox does fix it, this test fails and the
   * default can move to `typebox`, which is what an Elysia project would otherwise want.
   */
  for (const resolution of ['node16', 'nodenext'] as const) {
    it(
      `still cannot compile typebox under ${resolution}, which is why zod is the default`,
      async () => {
        const out = await compile(`typebox-${resolution}`, 'typebox', {}, '', resolution);
        expect(out, 'elysia now accepts a TypeBox schema under ' + resolution).not.toBe('');
        expect(out).toMatch(/~standard|not assignable/);
      },
      TSC_TIMEOUT
    );
  }
});

describe('the TypeBox dialect, which is this generator alone', () => {
  /**
   * `t.Numeric()` does not exist in `@sinclair/typebox`.
   *
   * `Type.Numeric` is `undefined` there; it is one of fifteen types Elysia adds. So the params
   * schema has to reach for `t` from `'elysia'`, even though the table schemas beside it come from
   * `@sinclair/typebox`. The runtime spec asserts the same thing from the other side, by checking
   * that `Type.Numeric` really is missing.
   */
  it('takes t from elysia rather than Type from @sinclair/typebox', async () => {
    const text = await fs.readFile(path.join(workRoot, 'typebox', 'routes', 'users.ts'), 'utf8');
    expect(text).toContain("import { Elysia, t } from 'elysia';");
    expect(text).toContain("import type { Static } from '@sinclair/typebox';");

    const start = text.indexOf('export const UsersParamsSchema');
    const region = text.slice(start, text.indexOf('export const UsersQuerySchema'));
    expect(start).toBeGreaterThan(-1);
    expect(region).toContain('t.Numeric()');
  });

  it('imports nothing from elysia beyond Elysia itself for the other three', async () => {
    for (const lib of ['zod', 'valibot', 'arktype'] as const) {
      const text = await fs.readFile(path.join(workRoot, lib, 'routes', 'users.ts'), 'utf8');
      expect(text, lib).toContain("import { Elysia } from 'elysia';");
      expect(text, lib).not.toContain("from 'elysia';\nimport { t }");
    }
  });
});

describe('the path parameters', () => {
  it('converts a numeric segment rather than declaring it a number', async () => {
    // A path segment is always a string. The declaration is sliced out before matching, because a
    // formatter breaks the chain across lines and an assertion spanning newlines would be free to
    // find its pieces in the query schema below it.
    const text = await fs.readFile(path.join(workRoot, 'zod', 'routes', 'users.ts'), 'utf8');
    const start = text.indexOf('export const UsersParamsSchema');
    const region = text.slice(start, text.indexOf('export const UsersQuerySchema'));
    expect(start).toBeGreaterThan(-1);
    expect(region).toContain('.transform(Number)');
    expect(region).not.toContain('z.number()');
    expect(region).not.toContain('z.coerce');
  });

  it('marks paging optional in each library, which ArkType spells on the key', async () => {
    const region = (text: string) =>
      text.slice(
        text.indexOf('export const UsersQuerySchema'),
        text.indexOf('export type UsersRow')
      );
    const read = async (lib: Lib) =>
      region(await fs.readFile(path.join(workRoot, lib, 'routes', 'users.ts'), 'utf8'));

    expect(await read('zod')).toContain('.optional()');
    expect(await read('valibot')).toContain('v.optional(');
    expect(await read('typebox')).toContain('t.Optional(');
    // ArkType marks the key rather than wrapping the value.
    expect(await read('arktype')).toContain("'limit?'");
  });

  it('keeps a bigint key as its digits, which is the only way it crosses a URL', async () => {
    const text = await fs.readFile(path.join(workRoot, 'zod', 'routes', 'events.ts'), 'utf8');
    const start = text.indexOf('export const EventsParamsSchema');
    const region = text.slice(start, text.indexOf('export const EventsQuerySchema'));
    expect(region).toContain('z.string().regex(');
    expect(region).not.toContain('transform(Number)');
  });
});

describe('a config that cannot work', () => {
  it('refuses to run without a validation generator to import from', async () => {
    await expect(
      new ElysiaGenerator(analysis([users])).generate({
        outputDir: path.join(workRoot, 'no-schemas', 'routes'),
      } as never)
    ).rejects.toThrow(/validation\.useShared/);
  });

  it('refuses a library Elysia cannot validate with', async () => {
    await expect(
      new ElysiaGenerator(analysis([users])).generate({
        outputDir: path.join(workRoot, 'effect', 'routes'),
        validation: { library: 'effect', useShared: true, importPath: 'src/validators/effect' },
      } as never)
    ).rejects.toThrow(/TypeBox schema or anything carrying/);
  });
});
