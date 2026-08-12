/**
 * The emitted client compiles against the real `openapi-fetch`, and that is the load-bearing test.
 *
 * The spec beside this one reads the emitted text. Text can say `SelectusersOutput` and still be a
 * module that does not compile, or one that compiles while typing every call as `any`. So each case
 * here writes the generator's own output to disk beside a stub validation module, points a probe at
 * it and runs `tsc`.
 *
 * **The trap this file is shaped around.** Measured 2026-08-12: when the validation import does not
 * resolve, every row type silently becomes an error type, every `@ts-expect-error` in the probe stops
 * firing, and `tsc` reports only `TS2307: Cannot find module`. A canary that has been disarmed that
 * way looks exactly like a canary that passed. So every run below asserts the *shape* of the failure
 * as well as its presence: a canary must fail for the reason it names, and a clean run must contain
 * no module resolution error at all.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Analysis, Column, Table } from '@drzl/analyzer';
import { OpenApiFetchGenerator } from '../src/index.js';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const workRoot = path.join(pkgRoot, 'test', 'tmp', 'typecheck');
const tsc = path.join(pkgRoot, 'node_modules', '.bin', 'tsc');
const TSC_TIMEOUT = 180_000;

afterAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
});

function col(name: string, tsType: string, over: Partial<Column> = {}): Column {
  return {
    name,
    tsType,
    dbType: tsType.toUpperCase(),
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  } as Column;
}

const users = {
  name: 'users',
  tsName: 'users',
  unique: [],
  indexes: [],
  columns: [
    col('id', 'number', { sqlType: 'integer' }),
    col('email', 'string', { sqlType: 'text' }),
    col('nickname', 'string', { sqlType: 'text', nullable: true }),
  ],
  primaryKey: { columns: ['id'] },
} as Table;

const analysis: Analysis = {
  dialect: 'postgres',
  tables: [users],
  enums: [],
  relations: [],
  issues: [],
} as Analysis;

/**
 * The types a validation generator exports, written by hand.
 *
 * Deliberately not generated: this file is about whether the *client* compiles against types of the
 * documented names and shapes, and generating them here would make a rename on either side invisible.
 */
const SCHEMAS = `
export interface InsertusersInput { email: string; nickname?: string | null }
export interface UpdateusersInput { email?: string; nickname?: string | null }
export interface SelectusersOutput { id: number; email: string; nickname: string | null }
`;

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      strict: true,
      target: 'ES2022',
      module: 'nodenext',
      moduleResolution: 'nodenext',
      noEmit: true,
      skipLibCheck: true,
      types: [],
    },
    include: ['**/*.ts'],
  },
  null,
  2
);

/** Write the generator's real output into a fresh tree, beside the stubs and a probe. */
async function project(name: string, probe: string): Promise<string> {
  const dir = path.join(workRoot, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'out'), { recursive: true });
  await fs.mkdir(path.join(dir, 'schemas'), { recursive: true });

  await fs.writeFile(path.join(dir, 'schemas', 'index.ts'), SCHEMAS, 'utf8');
  await fs.writeFile(path.join(dir, 'tsconfig.json'), TSCONFIG, 'utf8');
  await fs.writeFile(path.join(dir, 'probe.ts'), probe, 'utf8');

  await new OpenApiFetchGenerator(analysis).generate({
    outputDir: path.join(dir, 'out'),
    validation: { useShared: true, importPath: '../schemas' },
    format: { enabled: false },
  });
  return dir;
}

/** Run tsc and return its combined output, empty when it exits clean. */
function typecheck(dir: string): { ok: boolean; out: string } {
  try {
    execFileSync(tsc, ['-p', 'tsconfig.json'], {
      cwd: dir,
      timeout: TSC_TIMEOUT,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return { ok: true, out: '' };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const GOOD = `
import { createApiClient } from './out/client.js';

const client = createApiClient({ baseUrl: 'https://api.test' });

export async function useIt() {
  const list = await client.GET('/users');
  // The nullable column is nullable, all the way from the column definition.
  const nickname: string | null | undefined = list.data?.[0]?.nickname;

  const one = await client.GET('/users/{id}', { params: { path: { id: 1 } } });
  const email: string | undefined = one.data?.email;

  const made = await client.POST('/users', { body: { email: 'a@b.c' } });

  const patched = await client.PATCH('/users/{id}', {
    params: { path: { id: 1 } },
    body: { nickname: null },
  });

  await client.DELETE('/users/{id}', { params: { path: { id: 1 } } });

  // The error body is typed, which is the whole reason the non-2xx responses are emitted.
  const message: string | undefined = one.error?.message;

  return { nickname, email, made, patched, message };
}
`;

describe('the emitted client against real openapi-fetch', () => {
  it('compiles, and the module it imports really resolved', async () => {
    const dir = await project('good', GOOD);
    const r = typecheck(dir);
    expect(r.out).toBe('');
    expect(r.ok).toBe(true);
  }, 200_000);

  /**
   * Each canary is compiled on its own, because `tsc` reporting one error does not say which. The
   * assertion on the message is what tells a real failure apart from a disarmed one: `TS2307` here
   * would mean the stubs went missing and the call was never checked against anything.
   */
  const canaries: Array<[string, string]> = [
    [
      'an undeclared path',
      `import { createApiClient } from './out/client.js';
       const c = createApiClient({ baseUrl: 'x' });
       export const go = () => c.GET('/nope');`,
    ],
    [
      'a path parameter of the wrong type',
      `import { createApiClient } from './out/client.js';
       const c = createApiClient({ baseUrl: 'x' });
       export const go = () => c.GET('/users/{id}', { params: { path: { id: 'one' } } });`,
    ],
    [
      'a body field of the wrong type',
      `import { createApiClient } from './out/client.js';
       const c = createApiClient({ baseUrl: 'x' });
       export const go = () => c.POST('/users', { body: { email: 7 } });`,
    ],
    [
      'a verb the collection path does not declare',
      `import { createApiClient } from './out/client.js';
       const c = createApiClient({ baseUrl: 'x' });
       export const go = () => c.DELETE('/users');`,
    ],
  ];

  /**
   * The message is not matched, only its shape.
   *
   * Measured: an undeclared path and an undeclared verb are both refused as `TS2554: Expected 2
   * arguments, but got 1` rather than as anything naming the path, because overload resolution
   * falls through to a signature that requires an init argument. That is a refusal and it is the
   * one that matters, but asserting the words would pin this file to a diagnostic openapi-fetch is
   * free to reword. What is asserted instead is that the failure is about the call site and is not
   * `TS2307`, which is the disarmed shape that would make every case here pass while checking
   * nothing.
   */
  it.each(canaries)('refuses %s', async (label, probe) => {
    const dir = await project(`canary-${label.replace(/\W+/g, '-')}`, probe);
    const r = typecheck(dir);
    expect(r.ok, `${label} was accepted, so the type is not constraining it`).toBe(false);
    expect(r.out, `${label} failed on module resolution, not on the type`).not.toMatch(/TS2307/);
    expect(r.out, `${label} failed somewhere other than the probe`).toMatch(/probe\.ts\(/);
  }, 200_000);

  /**
   * A limitation, stated rather than papered over.
   *
   * Measured 2026-08-12: a body carrying a field the insert type does not declare compiles. The
   * excess-property check TypeScript applies to an object literal is lost through openapi-fetch's
   * generic `init` parameter, so `{ email: 'a@b.c', nope: 1 }` is accepted while `{ email: 7 }` is
   * refused. Nothing this generator emits can recover it: the same probe against
   * `openapi-typescript`'s own output behaves identically.
   *
   * This test asserts the limitation so that a future release of openapi-fetch closing it fails
   * here and is noticed, rather than the claim quietly staying in the documentation after it stops
   * being true.
   */
  it('does not catch an excess body field, which is openapi-fetch and not this generator', async () => {
    const dir = await project(
      'excess-body',
      `import { createApiClient } from './out/client.js';
       const c = createApiClient({ baseUrl: 'x' });
       export const go = () => c.POST('/users', { body: { email: 'a@b.c', nope: 1 } });`
    );
    const r = typecheck(dir);
    expect(
      r.ok,
      'openapi-fetch now rejects an excess body field. Good news: update the docs and delete this.'
    ).toBe(true);
  }, 200_000);

  /**
   * The disarm itself, made executable.
   *
   * With the validation module deleted, the good probe must fail with `TS2307` rather than quietly
   * compiling. If it compiles, the emitted client is not actually reading those types and every
   * assertion above is about nothing.
   */
  it('stops compiling when the validation module is gone', async () => {
    const dir = await project('disarmed', GOOD);
    await fs.rm(path.join(dir, 'schemas'), { recursive: true, force: true });
    const r = typecheck(dir);
    expect(r.ok, 'the client compiled without its row types, so it never used them').toBe(false);
    expect(r.out).toMatch(/TS2307|Cannot find module/);
  }, 200_000);
});
