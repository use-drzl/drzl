/**
 * The emitted tree compiles, with a real SDK installed.
 *
 * `noUnusedLocals` and `noUnusedParameters` are on and they are load-bearing rather than
 * decoration: every stub whose body is a bare `throw` never touches its argument, and the
 * underscore exemption applies to a parameter and not to a local. Measured on TypeScript 5.9.
 *
 * The type argument matters more here than in the HTTP generators. `registerTool` is generic over
 * the input schema and infers the handler's argument from it, so a schema the SDK cannot accept is
 * a compile error at the call site rather than something that shows up on the wire. That is
 * precisely what catches a valibot schema handed over unwrapped, which is the mistake this
 * generator's dialect exists to prevent.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MCPGenerator } from '../src';
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
  await fs.mkdir(path.join(dir, 'mcp'), { recursive: true });
  await new MCPGenerator(analysis(tables)).generate({
    outputDir: path.join(dir, 'mcp'),
    ...opts,
  } as never);
  if (extra) await fs.writeFile(path.join(dir, 'mcp', 'probe.ts'), extra);

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
        include: ['mcp/**/*.ts'],
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

  it('compiles against the v1 SDK with zod', async () => {
    expect(await compile('v1', { sdk: 'v1', validation: { library: 'zod' } })).toBe('');
  });

  it('compiles without the stdio entry point', async () => {
    expect(await compile('no-stdio', { stdio: false })).toBe('');
  });

  /**
   * The shared-schema path, which is the recommended configuration and the one nothing here
   * compiled until the packed gate caught it.
   *
   * Two things go wrong together when the import is not resolvable, and only the first is
   * obviously an error. The specifier fails, and then `registerTool` has an `any` where its input
   * schema should be, so it cannot infer its callback's argument and every handler reports
   * `Parameter '_input' implicitly has an 'any' type` instead. A generator whose emitted handlers
   * are untyped is the failure this whole package exists to avoid, and it shows up here as a
   * second-order effect of a broken path rather than as anything about the handler.
   */
  it('compiles when the schemas come from a sibling directory', async () => {
    const dir = path.join(workRoot, 'shared');
    const shared = path.join(dir, 'validators');
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(shared, { recursive: true });
    const decls = tables
      .flatMap((t) => [
        t.readOnly ? '' : `export const Insert${t.tsName}Schema = z.object({ a: z.string() });`,
        t.readOnly ? '' : `export const Update${t.tsName}Schema = z.object({ a: z.string() });`,
        `export const Select${t.tsName}Schema = z.object({ a: z.string() });`,
      ])
      .filter(Boolean);
    await fs.writeFile(
      path.join(shared, 'index.ts'),
      [`import { z } from 'zod';`, ...decls, ''].join('\n'),
      'utf8'
    );
    await fs.mkdir(path.join(dir, 'mcp'), { recursive: true });
    await new MCPGenerator(analysis(tables)).generate({
      outputDir: path.join(dir, 'mcp'),
      validation: {
        library: 'zod',
        useShared: true,
        // Project-relative, which is the documented spelling: a leading `./` would be resolved
        // against the output directory instead, which is exactly the mistake being guarded here.
        importPath: path.relative(process.cwd(), shared),
      },
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
          include: ['mcp/**/*.ts', 'validators/**/*.ts'],
        },
        null,
        2
      )
    );
    await fs.writeFile(path.join(dir, 'package.json'), '{"name":"probe","type":"module"}');

    let out = '';
    try {
      execFileSync(tsc, ['-p', tsconfig], { cwd: dir, stdio: 'pipe' });
    } catch (e) {
      const err = e as { stdout?: Buffer; stderr?: Buffer };
      out = `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`;
    }
    expect(out).toBe('');
  });

  it('compiles with a tool prefix and a module suffix', async () => {
    expect(
      await compile('naming', { naming: { toolPrefix: 'db.', moduleSuffix: 'Tools' } })
    ).toBe('');
  });

  /**
   * The row type is the contract a filled-in handler is held to, so it is asked to prove it
   * describes a real row rather than the insert shape: a generated key is present on the row and
   * absent from the insert, and a date column is a `Date` on the row and a string on the way in.
   */
  it('produces a row type carrying the generated key', async () => {
    const probe = `import type { UsersRow } from './users.js';

const row: UsersRow = { id: 1, email: 'a@b.c', bio: null, seenAt: null };
export const id: number = row.id;
export const seen: Date | null = row.seenAt;
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
