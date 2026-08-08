/**
 * The emitted tree compiles, with the real Hono, the real middleware and the real validator
 * installed.
 *
 * `noUnusedLocals` and `noUnusedParameters` are on, and they are not decoration here: they are the
 * two settings that caught the first draft of this generator. It emitted
 * `const _params = c.req.valid('param');` into every addressed route, copying the tRPC
 * generator's `{ input: _input }` convention, and the exemption does not transfer. Measured on
 * TypeScript 5.9: `noUnusedParameters` exempts a leading underscore, `noUnusedLocals` does not.
 * The same run reported the unused `c` in every stub whose body is a bare `throw`.
 *
 * Real `tsc`, real `node_modules`, under `strict` and `moduleResolution: nodenext`, which is the
 * combination the generated `.js` specifiers exist for.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HonoGenerator } from '../src';
import {
  activeUsers,
  analysis,
  auditLog,
  books,
  dailyTotals,
  memberships,
  posts,
  users,
} from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const workRoot = path.join(pkgRoot, 'test', 'tmp', 'typecheck');
const tsc = path.join(pkgRoot, 'node_modules', '.bin', 'tsc');

/** Every table shape this generator has a branch for, compiled together. */
const tables = [users, posts, books, memberships, auditLog, activeUsers, dailyTotals];

afterAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
});

/**
 * Emit into a directory under this package, so Node's resolver reaches the `hono`,
 * `@hono/standard-validator`, `@hono/zod-validator`, `zod`, `valibot` and `arktype` this package
 * installs. A temp directory elsewhere would resolve none of them and the compile would prove
 * nothing.
 */
async function compile(label: string, opts: Record<string, unknown>, extra = '') {
  const dir = path.join(workRoot, label);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'api'), { recursive: true });
  await new HonoGenerator(analysis(tables)).generate({
    outputDir: path.join(dir, 'api'),
    ...opts,
  } as never);
  if (extra) await fs.writeFile(path.join(dir, 'api', 'probe.ts'), extra);

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
          module: 'nodenext',
          moduleResolution: 'nodenext',
          skipLibCheck: true,
        },
        include: ['api/**/*.ts'],
      },
      null,
      2
    )
  );
  // The generated `.js` specifiers only resolve under nodenext from a module package.
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
    // Without this the cases below would report an empty diagnostic list for a compiler that
    // never started, and pass on nothing at all.
    expect(existsSync(tsc), `no tsc at ${tsc}; run pnpm install`).toBe(true);
  });

  for (const library of ['zod', 'valibot', 'arktype'] as const) {
    it(`compiles under strict nodenext with ${library}`, async () => {
      expect(await compile(library, { validation: { library } })).toBe('');
    });
  }

  it('compiles behind the zod-specific middleware', async () => {
    expect(await compile('zod-mw', { validator: 'zod', validation: { library: 'zod' } })).toBe('');
  });

  it('compiles with relation lookups', async () => {
    expect(await compile('relations', { includeRelations: true })).toBe('');
  });

  it('compiles with no unused locals or parameters anywhere', async () => {
    // Asserted by the tsconfig above rather than by a separate case: `noUnusedLocals` is what
    // turns a spare local into a compile error, and it is on for every case in this file.
    expect(await compile('unused', { includeRelations: true })).toBe('');
  });

  /**
   * The barrel's `AppType` is the whole point of chaining, so it is asked to prove it carries a
   * route rather than being an empty app that happens to have the right name.
   */
  it('produces an AppType a Hono client can be built from', async () => {
    const probe = `import { hc } from 'hono/client';
import type { AppType } from './index.js';

const client = hc<AppType>('http://localhost');
// Fails to compile if the chain did not accumulate: an app with no routes has no \`users\` key.
export const url = client.users.$url();
`;
    expect(await compile('apptype', {}, probe)).toBe('');
  });

  it('would have said so if the tree did not compile', async () => {
    // Every case above passes by producing no output, which a compiler that never ran also does.
    // So a mistake of exactly the shape this generator avoids is planted into a compiling tree and
    // has to be reported: the keyless table has no addressable route, so naming one is an error.
    const probe = `import { hc } from 'hono/client';
import type { AppType } from './index.js';

const client = hc<AppType>('http://localhost');
export const url = client.auditLog[':at'].$url();
`;
    const out = await compile('canary', {}, probe);
    expect(out).not.toBe('');
    expect(out).toMatch(/probe\.ts/);
  });
});
