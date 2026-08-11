/**
 * The emitted tree compiles under a real `tsc`, with `noUnusedLocals` and `noUnusedParameters` on.
 *
 * Those two are load-bearing rather than decoration here. Every action names `_prev` and never
 * reads it, which is legal only because a leading underscore exempts a *parameter*; and the delete
 * stub's `where` is a local, which the same underscore would not have rescued, so it is used in the
 * thrown message rather than voided.
 *
 * The `'use server'` directive is asserted here too. A Next build is what really reads it, and that
 * is not something to stand up per case, but the directive must at least be the first thing in the
 * file, ahead of the licence banner, and that is checkable without one.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NextGenerator } from '../src';
import {
  activeUsers,
  analysis,
  auditLog,
  books,
  dailyTotals,
  memberships,
  profile,
  users,
} from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const workRoot = path.join(pkgRoot, 'test', 'tmp', 'typecheck');
const tsc = path.join(pkgRoot, 'node_modules', '.bin', 'tsc');

/** Every table shape this generator has a branch for, compiled together. */
const tables = [users, profile, books, memberships, auditLog, activeUsers, dailyTotals];

afterAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
});

/** A shared schema module wide enough for every fixture table, in the given library. */
function sharedSource(lib: 'zod' | 'valibot' | 'arktype'): string {
  const names = tables.flatMap((t) =>
    t.readOnly ? [] : [`Insert${t.tsName}Schema`, `Update${t.tsName}Schema`]
  );
  if (lib === 'zod') {
    return [
      "import { z } from 'zod';",
      ...names.map((n) => `export const ${n} = z.looseObject({});`),
      '',
    ].join('\n');
  }
  if (lib === 'valibot') {
    return [
      "import * as v from 'valibot';",
      ...names.map((n) => `export const ${n} = v.looseObject({});`),
      '',
    ].join('\n');
  }
  return [
    "import { type } from 'arktype';",
    ...names.map((n) => `export const ${n} = type({ '+': 'delete' });`),
    '',
  ].join('\n');
}

async function compile(label: string, lib: 'zod' | 'valibot' | 'arktype') {
  const dir = path.join(workRoot, label);
  const shared = path.join(dir, 'validators');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(shared, { recursive: true });
  await fs.writeFile(path.join(shared, 'index.ts'), sharedSource(lib), 'utf8');
  await fs.mkdir(path.join(dir, 'actions'), { recursive: true });

  await new NextGenerator(analysis(tables)).generate({
    outputDir: path.join(dir, 'actions'),
    validation: {
      library: lib,
      useShared: true,
      importPath: path.relative(process.cwd(), shared),
    },
  });

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
          module: 'nodenext',
          moduleResolution: 'nodenext',
          skipLibCheck: true,
        },
        include: ['actions/**/*.ts', 'validators/**/*.ts'],
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

  for (const library of ['zod', 'valibot', 'arktype'] as const) {
    it(`compiles under strict nodenext with ${library}`, async () => {
      expect(await compile(library, library)).toBe('');
    });
  }

  it('puts the use server directive first, ahead of the licence banner', async () => {
    const file = path.join(workRoot, 'zod', 'actions', 'users.ts');
    const text = await fs.readFile(file, 'utf8');
    expect(text.split('\n')[0]).toBe("'use server';");
  });

  it('leaves the shared module free of the directive, since it exports a const', async () => {
    // A `'use server'` file may export only async functions, and `EMPTY_FORM_STATE` is a const.
    // That is the whole reason the state lives in its own module.
    const text = await fs.readFile(path.join(workRoot, 'zod', 'actions', 'form-state.ts'), 'utf8');
    expect(text.split('\n')[0]).not.toBe("'use server';");
    expect(text).toContain('export const EMPTY_FORM_STATE');
  });

  it('writes no module at all for a table that refuses every write', async () => {
    // A materialized view has no mutation to define. Emitting one produced a file whose only
    // content was imports, which `noUnusedLocals` reported.
    const written = await fs.readdir(path.join(workRoot, 'zod', 'actions'));
    expect(written).not.toContain('activeUsers.ts');
    expect(written).not.toContain('daily_totals.ts');
    expect(written).toContain('users.ts');
  });

  it('leaves the barrel free of it too, so re-exporting an action stays legal', async () => {
    const text = await fs.readFile(path.join(workRoot, 'zod', 'actions', 'index.ts'), 'utf8');
    // The first line, not the whole file: the barrel's own comment explains why it carries no
    // directive, so it says the words without being one.
    expect(text.split('\n')[0]).not.toBe("'use server';");
    expect(text).toContain("export * from './users.js';");
  });
});
