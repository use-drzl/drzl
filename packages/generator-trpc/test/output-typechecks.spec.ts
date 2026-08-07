/**
 * The emitted tree compiles, with the real tRPC and the real validator installed.
 *
 * This is the check that was missing from the oRPC generator for its entire life. Its `create` and
 * `update` stubs declared `.output(SelectSchema)` and returned the input, which is the *insert*
 * shape, so every generated router failed `tsc --strict` and nothing noticed because nothing ever
 * compiled the output. tRPC constrains a handler's return against its output parser in exactly the
 * same way, measured, so the same mistake would be the same defect here.
 *
 * Real `tsc`, real `node_modules`, under `strict` and `moduleResolution: nodenext`, which is the
 * combination the generated `.js` specifiers exist for.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TRPCGenerator } from '../src';
import {
  activeUsers,
  analysis,
  auditLog,
  books,
  memberships,
  posts,
  users,
} from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const workRoot = path.join(pkgRoot, 'test', 'tmp', 'typecheck');
const tsc = path.join(pkgRoot, 'node_modules', '.bin', 'tsc');

/** Every table shape this generator has a branch for, compiled together. */
const tables = [users, posts, books, memberships, auditLog, activeUsers];

afterAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
});

/**
 * Emit into a directory under this package, so Node's resolver reaches the `@trpc/server`, `zod`,
 * `valibot` and `arktype` this package installs. A temp directory elsewhere would resolve none of
 * them and the compile would prove nothing.
 */
async function compile(label: string, opts: Record<string, unknown>) {
  const dir = path.join(workRoot, label);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await new TRPCGenerator(analysis(tables)).generate({
    outputDir: path.join(dir, 'api'),
    ...opts,
  } as never);

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

  it('compiles with relation lookups', async () => {
    expect(await compile('relations', { includeRelations: true })).toBe('');
  });

  it('compiles with the database middleware', async () => {
    expect(
      await compile('injected', {
        databaseInjection: { enabled: true, databaseType: '{ readonly tag: "db" }' },
      })
    ).toBe('');
  });

  it('compiles with no unused locals or parameters anywhere', async () => {
    // Asserted by the tsconfig above rather than by a separate case: `noUnusedLocals` is what
    // turns a spare import into a compile error, and it is on for every case in this file.
    expect(await compile('unused', { includeRelations: true })).toBe('');
  });

  it('would have said so if the tree did not compile', async () => {
    // Every case above passes by producing no output, which a compiler that never ran also does.
    // So the exact mistake that shipped in the oRPC generator is planted into a compiling tree
    // and has to be reported: `create` returning its input, which is the insert shape where the
    // declared output is the select shape.
    const dir = path.join(workRoot, 'canary');
    await compile('canary', {});
    const router = path.join(dir, 'api', 'users.ts');
    const source = await fs.readFile(router, 'utf8');
    // Quote style is whatever prettier resolved from the nearest config, so the pattern cannot
    // assume one. A silent no-match here would leave a compiling tree and pass this test on it.
    const planted = source.replace(
      /throw new Error\(['"]Not implemented: create users\.['"]\);/,
      'return _input;'
    );
    expect(planted, 'the mistake was never planted').not.toBe(source);
    await fs.writeFile(router, planted);
    let diagnostics = '';
    try {
      execFileSync(tsc, ['-p', path.join(dir, 'tsconfig.json')], { cwd: dir, stdio: 'pipe' });
    } catch (e) {
      const err = e as { stdout?: Buffer };
      diagnostics = err.stdout?.toString() ?? '';
    }
    expect(diagnostics, 'tsc accepted the insert shape where select was declared').toContain(
      'is not assignable'
    );
    expect(diagnostics).toContain('users.ts');
  });
}, 180_000);
