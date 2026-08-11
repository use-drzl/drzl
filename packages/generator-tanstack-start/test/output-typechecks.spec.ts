/**
 * The emitted tree compiles against the real `@tanstack/react-start`, and this is the load-bearing
 * test rather than a formality.
 *
 * There is no runtime spec here and the reason is not laziness. A server function is only callable
 * inside a Start server runtime, and everything this generator claims is a claim the type system
 * settles: that `.validator(schema)` accepts what DRZL emits, that the handler receives the
 * schema's *output* so a date column's transform did real work, and that a caller supplies its
 * *input* so passing a `Date` across the wire is refused. The probes below assert exactly those,
 * and each is written so that getting the variance backwards fails to compile.
 *
 * `noUnusedLocals` and `noUnusedParameters` are on. Every write stub's only statement is `throw`,
 * so it never reads its context argument, which is legal only because a leading underscore exempts
 * a parameter.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TanStackStartGenerator } from '../src';
import {
  activeUsers,
  analysis,
  auditLog,
  books,
  dailyTotals,
  memberships,
  users,
} from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const workRoot = path.join(pkgRoot, 'test', 'tmp', 'typecheck');
const tsc = path.join(pkgRoot, 'node_modules', '.bin', 'tsc');

/** A real `tsc` against the Start type surface is slow; see the AI generator for the same note. */
const TSC_TIMEOUT = 180_000;

const tables = [users, books, memberships, auditLog, activeUsers, dailyTotals];

afterAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
});

/**
 * The shared schema module, wide enough for every fixture table.
 *
 * `users` carries a real date column, spelled the way DRZL's own zod generator spells it, because
 * the input-versus-output probe below has nothing to measure without one.
 *
 * Every schema names a concrete shape, and that is not tidiness. Start type-checks **both** ends of
 * a server function for serialisability: the validator's input and the handler's return value. A
 * type of `{ [x: string]: unknown }`, which is what a loose object infers to, fails either way with
 * `Type 'unknown' is not assignable to type SerializationError<"Type may not be serializable">`.
 *
 * That is a real constraint of this surface rather than a detail of the fixture, and it is the one
 * thing that can stop a generated function compiling: a column the analyzer could not type, which
 * is a `customType` with no `$type<T>()`, reaches the schema as `unknown` and Start refuses it. The
 * generator's own docs say so. A placeholder written for a test hits it the same way, which is why
 * these are concrete.
 */
function sharedSource(lib: 'zod' | 'valibot' | 'arktype'): string {
  const others = tables.filter((t) => t.tsName !== 'users');
  if (lib === 'zod') {
    return [
      "import { z } from 'zod';",
      'export const InsertusersSchema = z.object({',
      '  email: z.string(),',
      '  seenAt: z.iso.datetime().transform((s) => new Date(s)),',
      '});',
      'export const UpdateusersSchema = InsertusersSchema.partial();',
      'export const SelectusersSchema = z.object({ id: z.number(), email: z.string(), seenAt: z.date() });',
      ...others.flatMap((t) => [
        `export const Insert${t.tsName}Schema = z.object({ n: z.number() });`,
        `export const Update${t.tsName}Schema = z.object({ n: z.number().optional() });`,
        `export const Select${t.tsName}Schema = z.object({ n: z.number() });`,
      ]),
      '',
    ].join('\n');
  }
  if (lib === 'valibot') {
    return [
      "import * as v from 'valibot';",
      'export const InsertusersSchema = v.object({',
      '  email: v.string(),',
      '  seenAt: v.pipe(v.string(), v.isoTimestamp(), v.transform((s) => new Date(s))),',
      '});',
      'export const UpdateusersSchema = v.partial(InsertusersSchema);',
      'export const SelectusersSchema = v.object({ id: v.number(), email: v.string(), seenAt: v.date() });',
      ...others.flatMap((t) => [
        `export const Insert${t.tsName}Schema = v.object({ n: v.number() });`,
        `export const Update${t.tsName}Schema = v.object({ n: v.optional(v.number()) });`,
        `export const Select${t.tsName}Schema = v.object({ n: v.number() });`,
      ]),
      '',
    ].join('\n');
  }
  return [
    "import { type } from 'arktype';",
    "export const InsertusersSchema = type({ email: 'string', seenAt: 'string.date.iso.parse' });",
    'export const UpdateusersSchema = InsertusersSchema.partial();',
    "export const SelectusersSchema = type({ id: 'number', email: 'string', seenAt: 'Date' });",
    ...others.flatMap((t) => [
      `export const Insert${t.tsName}Schema = type({ n: 'number' });`,
      `export const Update${t.tsName}Schema = type({ 'n?': 'number' });`,
      `export const Select${t.tsName}Schema = type({ n: 'number' });`,
    ]),
    '',
  ].join('\n');
}

async function compile(
  label: string,
  lib: 'zod' | 'valibot' | 'arktype',
  opts: Record<string, unknown> = {},
  probe = ''
) {
  const dir = path.join(workRoot, label);
  const shared = path.join(dir, 'validators');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(shared, { recursive: true });
  await fs.writeFile(path.join(shared, 'index.ts'), sharedSource(lib), 'utf8');
  await fs.mkdir(path.join(dir, 'fns'), { recursive: true });

  await new TanStackStartGenerator(analysis(tables)).generate({
    outputDir: path.join(dir, 'fns'),
    validation: {
      library: lib,
      useShared: true,
      importPath: path.relative(process.cwd(), shared),
    },
    ...opts,
  } as never);
  if (probe) await fs.writeFile(path.join(dir, 'fns', 'probe.ts'), probe, 'utf8');

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
        include: ['fns/**/*.ts', 'validators/**/*.ts'],
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
    it(
      `compiles under strict bundler resolution with ${library}`,
      async () => {
        expect(await compile(library, library)).toBe('');
      },
      TSC_TIMEOUT
    );
  }

  it(
    'compiles with a module suffix and a case',
    async () => {
      expect(
        await compile('naming', 'zod', { naming: { routerSuffix: 'Fn', procedureCase: 'snake' } })
      ).toBe('');
    },
    TSC_TIMEOUT
  );

  /**
   * The whole claim, as a compile.
   *
   * `createServerFn().validator()` is variance-aware in both directions: the handler receives the
   * schema's output and the caller supplies its input. Both halves are asserted, and the second is
   * asserted negatively as well, so a build where the two collapsed into one type would fail here
   * rather than pass silently.
   */
  it(
    'gives the handler the output side and the caller the input side',
    async () => {
      const probe = `import { createUsers, getUsers } from './users.js';

// The caller supplies the schema's INPUT: a date column crosses the wire as a string.
export const call = () => createUsers({ data: { email: 'a@b.c', seenAt: '2026-08-11T00:00:00Z' } });

// And a Date is refused there, which is what makes the line above a measurement.
// @ts-expect-error the caller supplies the input side, not the output side
export const wrong = () => createUsers({ data: { email: 'a@b.c', seenAt: new Date() } });

// The key schema is this generator's own, and it takes a number for a serial key.
export const byId = () => getUsers({ data: { id: 1 } });
`;
      expect(await compile('variance', 'zod', {}, probe)).toBe('');
    },
    TSC_TIMEOUT
  );

  it(
    'would have said so if the tree did not compile',
    async () => {
      // Every case above passes by producing no output, which a compiler that never ran also does.
      const probe = `import { getUsers } from './users.js';

// The key is a number, so a string is an error.
export const bad = () => getUsers({ data: { id: 'one' } });
`;
      const out = await compile('canary', 'zod', {}, probe);
      expect(out).not.toBe('');
      expect(out).toMatch(/probe\.ts/);
    },
    TSC_TIMEOUT
  );
});

describe('what Start refuses', () => {
  /**
   * The must-fire half of the serialisability note above.
   *
   * Without this the concrete fixtures look like a style choice. This asserts the constraint is
   * real: a column the analyzer could not type reaches the schema as `unknown`, and Start refuses
   * the function outright rather than serialising it to something surprising.
   */
  it(
    'refuses a column it cannot serialise, which is what an untyped column becomes',
    async () => {
      const dir = path.join(workRoot, 'unserialisable');
      const shared = path.join(dir, 'validators');
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(shared, { recursive: true });
      await fs.writeFile(
        path.join(shared, 'index.ts'),
        [
          "import { z } from 'zod';",
          'export const InsertbooksSchema = z.object({ payload: z.unknown() });',
          'export const UpdatebooksSchema = z.object({ payload: z.unknown() });',
          'export const SelectbooksSchema = z.object({ payload: z.unknown() });',
          '',
        ].join('\n'),
        'utf8'
      );
      await fs.mkdir(path.join(dir, 'fns'), { recursive: true });
      await new TanStackStartGenerator(analysis([books])).generate({
        outputDir: path.join(dir, 'fns'),
        validation: {
          library: 'zod',
          useShared: true,
          importPath: path.relative(process.cwd(), shared),
        },
      } as never);
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
          include: ['fns/**/*.ts', 'validators/**/*.ts'],
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
      expect(out, 'Start accepted an unknown, so the note in the docs is stale').not.toBe('');
      expect(out).toMatch(/serializable/i);
    },
    TSC_TIMEOUT
  );
});

describe('the method each function carries', () => {
  it('puts reads on GET and writes on POST', async () => {
    const dir = path.join(workRoot, 'zod', 'fns');
    const text = await fs.readFile(path.join(dir, 'users.ts'), 'utf8');
    // `createServerFn` defaults to GET, so a create written without thinking about it is a
    // mutation behind a cacheable verb.
    expect(text).toMatch(/export const listUsers = createServerFn\(\{ method: 'GET' \}\)/);
    expect(text).toMatch(/export const getUsers = createServerFn\(\{ method: 'GET' \}\)/);
    for (const verb of ['create', 'update', 'delete']) {
      const name = verb + 'Users';
      expect(text, name).toMatch(
        new RegExp(`export const ${name} = createServerFn\\(\\{ method: 'POST' \\}\\)`)
      );
    }
  });

  it('gives a keyless table a create and nothing that addresses a row', async () => {
    const text = await fs.readFile(path.join(workRoot, 'zod', 'fns', 'auditLog.ts'), 'utf8');
    expect(text).toContain('createAuditLog');
    expect(text).not.toContain('updateAuditLog');
    expect(text).not.toContain('deleteAuditLog');
  });

  it('gives a read-only table no writes', async () => {
    const text = await fs.readFile(path.join(workRoot, 'zod', 'fns', 'activeUsers.ts'), 'utf8');
    expect(text).toContain('listActiveUsers');
    expect(text).toContain('getActiveUsers');
    expect(text).not.toContain('createActiveUsers');
  });
});
