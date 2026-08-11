/**
 * The emitted tree compiles, with the real AI SDK installed.
 *
 * `noUnusedLocals` and `noUnusedParameters` are on and they are load-bearing rather than
 * decoration: every stub whose body is a bare `throw` never touches its argument, and the
 * underscore exemption applies to a parameter and not to a local. Measured on TypeScript 5.9.
 *
 * `satisfies ToolSet` is the assertion that matters most here. `tool()` infers `execute`'s argument
 * from the input schema, so a set that typechecks is a set whose handlers are typed rather than
 * `any`, and the barrel's spread is what proves every table's tools really landed in one object.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AIGenerator } from '../src';
import {
  activeUsers,
  analysis,
  auditLog,
  books,
  dailyTotals,
  events,
  memberships,
  posts,
  products,
  users,
} from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const workRoot = path.join(pkgRoot, 'test', 'tmp', 'typecheck');
const tsc = path.join(pkgRoot, 'node_modules', '.bin', 'tsc');

/** Every table shape this generator has a branch for, compiled together. */
const tables = [
  users,
  products,
  posts,
  books,
  memberships,
  auditLog,
  activeUsers,
  dailyTotals,
  events,
];

afterAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
});

/**
 * Emit into a directory under this package, so Node's resolver reaches the SDK, `zod`, `valibot`,
 * `arktype` and `@valibot/to-json-schema` this package installs. A temp directory elsewhere would
 * resolve none of them and the compile would prove nothing.
 */
async function compile(label: string, opts: Record<string, unknown>, extra = '') {
  const dir = path.join(workRoot, label);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'ai'), { recursive: true });
  await new AIGenerator(analysis(tables)).generate({
    outputDir: path.join(dir, 'ai'),
    ...opts,
  } as never);
  if (extra) await fs.writeFile(path.join(dir, 'ai', 'probe.ts'), extra);

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
        include: ['ai/**/*.ts'],
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
    expect(existsSync(tsc), `no tsc at ${tsc}; run pnpm install`).toBe(true);
  });

  for (const library of ['zod', 'valibot', 'arktype'] as const) {
    it(`compiles under strict nodenext with ${library}`, async () => {
      expect(await compile(library, { validation: { library } })).toBe('');
    });
  }

  it('compiles with a tool prefix and a module suffix', async () => {
    expect(await compile('naming', { naming: { toolPrefix: 'db_', routerSuffix: 'Tools' } })).toBe(
      ''
    );
  });

  /**
   * The row type is the contract a filled-in handler is held to, so it is asked to prove it
   * describes a real row rather than the insert shape: a generated key is present on the row and
   * absent from the insert, and a date column is a `Date` on the row and a string on the way in.
   */
  it('produces a row type carrying the generated key', async () => {
    const probe = `import type { UsersRow } from './users.js';
import { allTools } from './index.js';

const row: UsersRow = { id: 1, email: 'a@b.c', bio: null, seenAt: null };
export const id: number = row.id;
export const seen: Date | null = row.seenAt;
// Fails to compile if the barrel's spread did not accumulate.
export const names = Object.keys(allTools);
`;
    expect(await compile('rowtype', {}, probe)).toBe('');
  });

  it('would have said so if the tree did not compile', async () => {
    // Every case above passes by producing no output, which a compiler that never ran also does.
    // So a mistake of exactly the shape this generator avoids is planted into a compiling tree and
    // has to be reported: the row type carries the key, so assigning it a string is an error.
    const probe = `import type { UsersRow } from './users.js';

const row: UsersRow = { id: 'not a number', email: 'a@b.c', bio: null, seenAt: null };
export const id = row.id;
`;
    const out = await compile('canary', {}, probe);
    expect(out).not.toBe('');
    expect(out).toMatch(/probe\.ts/);
  });
});
