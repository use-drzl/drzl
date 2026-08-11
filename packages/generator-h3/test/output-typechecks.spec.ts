/**
 * The emitted tree compiles against both real h3 majors.
 *
 * This is the load-bearing test, because the whole design of this generator is the version split
 * and nothing else can see it. v1 has no Standard Schema overload on any of its validation
 * helpers, so a schema handed over directly is a type error there and correct in v2; the adapter is
 * what makes v1 work, and it is emitted only for v1. Compiling both is what proves each half.
 *
 * `h3-v2` is an npm alias in this package's manifest, since the two majors cannot both be called
 * `h3` in one `node_modules`. The emitted code always imports `'h3'`, so the v2 case rewrites the
 * specifier before compiling rather than the generator emitting an alias no consumer would have.
 *
 * `noUnusedLocals` and `noUnusedParameters` are on. Every stub reads its validated values into
 * locals it does not use, which is why each one is `void`ed rather than left to be reported.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { H3Generator } from '../src';
import { activeUsers, analysis, auditLog, books, memberships, users } from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const workRoot = path.join(pkgRoot, 'test', 'tmp', 'typecheck');
const tsc = path.join(pkgRoot, 'node_modules', '.bin', 'tsc');
const TSC_TIMEOUT = 180_000;

const tables = [users, books, memberships, auditLog, activeUsers];

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

async function compile(
  label: string,
  lib: 'zod' | 'valibot' | 'arktype',
  version: 'v1' | 'v2',
  probe = ''
) {
  const dir = path.join(workRoot, label);
  const shared = path.join(dir, 'validators');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(shared, { recursive: true });
  await fs.writeFile(path.join(shared, 'index.ts'), sharedSource(lib), 'utf8');
  await fs.mkdir(path.join(dir, 'routes'), { recursive: true });

  await new H3Generator(analysis(tables)).generate({
    outputDir: path.join(dir, 'routes'),
    h3: version,
    validation: {
      library: lib,
      useShared: true,
      importPath: path.relative(process.cwd(), shared),
    },
  } as never);
  if (probe) await fs.writeFile(path.join(dir, 'routes', 'probe.ts'), probe, 'utf8');

  // The v2 case compiles against the aliased install, because two majors cannot share a name.
  if (version === 'v2') {
    for (const name of await fs.readdir(path.join(dir, 'routes'))) {
      const file = path.join(dir, 'routes', name);
      const text = await fs.readFile(file, 'utf8');
      await fs.writeFile(file, text.replace(/ from 'h3';/g, " from 'h3-v2';"), 'utf8');
    }
  }

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

  for (const version of ['v1', 'v2'] as const) {
    for (const library of ['zod', 'valibot', 'arktype'] as const) {
      it(
        `compiles against h3 ${version} with ${library}`,
        async () => {
          expect(await compile(`${version}-${library}`, library, version)).toBe('');
        },
        TSC_TIMEOUT
      );
    }
  }

  it(
    'would have said so if the tree did not compile',
    async () => {
      // Every case above passes by producing no output, which a compiler that never ran also does.
      const probe = `import { getUsers } from './users.js';
// A handler is an h3 event handler, not a function taking a row.
export const bad = getUsers({ id: 1 });
`;
      const out = await compile('canary', 'zod', 'v1', probe);
      expect(out).not.toBe('');
      expect(out).toMatch(/probe\.ts/);
    },
    TSC_TIMEOUT
  );
});

describe('the version split', () => {
  it('emits the adapter for v1 and not for v2', async () => {
    const v1 = await fs.readFile(path.join(workRoot, 'v1-zod', 'routes', 'users.ts'), 'utf8');
    const v2 = await fs.readFile(path.join(workRoot, 'v2-zod', 'routes', 'users.ts'), 'utf8');
    expect(v1).toContain('function drzlValidate');
    expect(v1).toContain('drzlValidate(InsertusersSchema)');
    expect(v2).not.toContain('drzlValidate');
    // v2 takes the schema straight, which is the whole reason it needs no adapter.
    expect(v2).toContain('readValidatedBody(event, InsertusersSchema)');
  });

  /**
   * The must-fire half of the split.
   *
   * Without this, emitting the adapter for both versions would pass every case above, and so would
   * emitting it for neither if v1 happened to accept a schema. This asserts the constraint is real:
   * handing a schema straight to v1 does not compile.
   */
  it(
    'is what makes v1 compile at all',
    async () => {
      const dir = path.join(workRoot, 'v1-unadapted');
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'probe.ts'),
        [
          "import { defineEventHandler, readValidatedBody } from 'h3';",
          "import { z } from 'zod';",
          'const Schema = z.object({ email: z.string() });',
          'export const handler = defineEventHandler(async (event) => {',
          '  const body = await readValidatedBody(event, Schema);',
          '  return body;',
          '});',
          '',
        ].join('\n'),
        'utf8'
      );
      await fs.writeFile(
        path.join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'es2022',
            lib: ['es2023', 'dom'],
            module: 'preserve',
            moduleResolution: 'bundler',
            skipLibCheck: true,
          },
          include: ['probe.ts'],
        })
      );
      await fs.writeFile(path.join(dir, 'package.json'), '{"name":"probe","type":"module"}');

      let out = '';
      try {
        execFileSync(tsc, ['-p', path.join(dir, 'tsconfig.json')], { cwd: dir, stdio: 'pipe' });
      } catch (e) {
        const err = e as { stdout?: Buffer; stderr?: Buffer };
        out = `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`;
      }
      expect(out, 'h3 v1 accepted a Standard Schema, so the adapter is no longer needed').not.toBe(
        ''
      );
    },
    TSC_TIMEOUT
  );

  it('says which major it emitted for, in the barrel', async () => {
    const v1 = await fs.readFile(path.join(workRoot, 'v1-zod', 'routes', 'index.ts'), 'utf8');
    expect(v1).toContain('Emitted for h3 v1.');
  });
});

describe('the routes', () => {
  it('gives a keyless table a list and a create and nothing that addresses a row', async () => {
    const text = await fs.readFile(path.join(workRoot, 'v1-zod', 'routes', 'auditLog.ts'), 'utf8');
    expect(text).toContain('listAuditLog');
    expect(text).toContain('createAuditLog');
    expect(text).not.toContain('updateAuditLog');
    expect(text).not.toContain('deleteAuditLog');
  });

  it('gives a read-only table no writes', async () => {
    const text = await fs.readFile(
      path.join(workRoot, 'v1-zod', 'routes', 'activeUsers.ts'),
      'utf8'
    );
    expect(text).toContain('listActiveUsers');
    expect(text).toContain('getActiveUsers');
    expect(text).not.toContain('createActiveUsers');
  });

  it('addresses a composite key by every one of its columns', async () => {
    const text = await fs.readFile(
      path.join(workRoot, 'v1-zod', 'routes', 'memberships.ts'),
      'utf8'
    );
    expect(text).toContain('/:orgId/:userId');
  });

  it('converts a numeric path segment rather than declaring it a number', async () => {
    // A path segment is always a string, so `z.number()` against "1" refuses every request.
    // Not `z.coerce.number()` either, which takes an empty string as 0.
    const text = await fs.readFile(path.join(workRoot, 'v1-zod', 'routes', 'users.ts'), 'utf8');

    // The params declaration is sliced out before matching. A formatter breaks the chain across
    // four lines, and an assertion spanning newlines would otherwise be free to find its pieces
    // in the query schema below it.
    const start = text.indexOf('export const UsersParamsSchema');
    const region = text.slice(start, text.indexOf('export const UsersQuerySchema'));
    expect(start).toBeGreaterThan(-1);
    expect(region).toContain('.string()');
    expect(region).toContain('.transform(Number)');
    expect(region).toContain(String.raw`.regex(/^-?\d+(\.\d+)?$/)`);
    expect(region).not.toContain('z.number()');
    expect(region).not.toContain('z.coerce');
  });
});
