/**
 * The emitted tree compiles, with the real fastify installed.
 *
 * Real `tsc`, real `node_modules`, under `strict`, `noUnusedLocals`, `noUnusedParameters` and
 * `moduleResolution: nodenext`, which is the combination the generated `.js` specifiers exist
 * for. The `Reply` route generics are load-bearing here: they are the one place Fastify's types
 * hold a handler to its declared reply without a type provider, and the canary at the bottom
 * proves the compiler actually looks.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FastifyGenerator } from '../src';
import {
  activeUsers,
  analysis,
  auditLog,
  books,
  dailyTotals,
  events,
  memberships,
  posts,
  users,
} from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const workRoot = path.join(pkgRoot, 'test', 'tmp', 'typecheck');
const tsc = path.join(pkgRoot, 'node_modules', '.bin', 'tsc');

/** Every table shape this generator has a branch for, compiled together. */
const tables = [users, posts, books, memberships, auditLog, activeUsers, dailyTotals, events];

afterAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
});

/**
 * Emit into a directory under this package, so Node's resolver reaches the `fastify` this
 * package installs. A temp directory elsewhere would resolve nothing and the compile would prove
 * nothing.
 */
async function compile(label: string, opts: Record<string, unknown>, extra = '') {
  const dir = path.join(workRoot, label);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'api'), { recursive: true });
  await new FastifyGenerator(analysis(tables)).generate({
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

  it('compiles under strict nodenext', async () => {
    expect(await compile('default', {})).toBe('');
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
   * The row types flow out of the barrel, at their real member types: an enum column is its
   * members, not a bare string, or the literal below would not typecheck.
   */
  it('exports row types a consumer can build values against', async () => {
    const probe = `import type { SelectusersRow, SelecteventsRow } from './index.js';

const row: SelectusersRow = { id: 1, email: 'a@b.c', bio: null, role: 'admin' };
const event: SelecteventsRow = {
  id: 1,
  at: new Date(),
  flag: true,
  big: 1n,
  point: [1, 2],
  note: null,
};
export const values = [row, event] as const;
`;
    expect(await compile('rowtype', {}, probe)).toBe('');
  });

  it('exports the schemas as data a consumer can hand back to Fastify', async () => {
    const probe = `import { InsertusersSchema, UsersParamsSchema } from './index.js';

export const schemas = [InsertusersSchema, UsersParamsSchema] as const;
`;
    expect(await compile('schemas', {}, probe)).toBe('');
  });

  it('would have said so if the tree did not compile', async () => {
    // Every case above passes by producing no output, which a compiler that never ran also does.
    // So a mistake of exactly the shape this generator avoids is planted into a compiling tree
    // and has to be reported: the read-only table has no insert schema, so naming one is an
    // error.
    const probe = `import { InsertdailyTotalsSchema } from './index.js';

export const schema = InsertdailyTotalsSchema;
`;
    const out = await compile('canary', {}, probe);
    expect(out).not.toBe('');
    expect(out).toMatch(/probe\.ts/);
  });

  it('rejects an enum member the column does not have', async () => {
    const probe = `import type { SelectusersRow } from './index.js';

export const row: SelectusersRow = { id: 1, email: 'a@b.c', bio: null, role: 'boss' };
`;
    const out = await compile('enum-canary', {}, probe);
    expect(out).not.toBe('');
    expect(out).toMatch(/probe\.ts/);
  });

  /**
   * The Reply generic really is enforcement, not decoration: a plugin whose handler returns a
   * row with an enum outsider must fail to compile, the exact shape the emitted stubs rely on.
   * Measured on fastify 5.11.2's typings before this generator was written; asserted here so a
   * typings change that stops looking at handler returns fails this file rather than silently
   * downgrading every emitted contract.
   */
  it('holds a handler to its Reply generic', async () => {
    const probe = `import type { FastifyPluginAsync } from 'fastify';
import type { SelectusersRow } from './index.js';

export const bad: FastifyPluginAsync = async (app) => {
  app.get<{ Reply: SelectusersRow[] }>('/probe', async () => {
    return [{ id: 1, email: 'a@b.c', bio: null, role: 'boss' }];
  });
};
`;
    const out = await compile('reply-canary', {}, probe);
    expect(out).not.toBe('');
    expect(out).toMatch(/probe\.ts/);
  });
});
