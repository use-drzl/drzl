/**
 * The emitted tree compiles under a real tsc, at the consumer's strictness.
 *
 * Three compilers look at it, because three different consumers will:
 *
 * 1. The exact tsconfig `scripts/verify-packed.sh` constructs for documented configs: strict,
 *    es2022, nodenext, skipLibCheck. The emitted modules import nothing, so this must pass in
 *    a project with NO graphql installed, which is the zero-dependency claim made compilable.
 * 2. The same flags plus `verbatimModuleSyntax`, the strictest import-elision setting.
 * 3. A consumer module that builds the schema with @graphql-tools/schema and overrides a stub,
 *    the way the docs show, compiled with this package's devDependency graphql present.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GraphQLGenerator } from '../src';
import {
  activeUsers,
  analysis,
  auditLog,
  books,
  dailyTotals,
  events,
  memberships,
  metrics,
  posts,
  tasks,
  users,
} from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const workRoot = path.join(pkgRoot, 'test', 'tmp', 'typecheck');
const tsc = path.join(pkgRoot, 'node_modules', '.bin', 'tsc');

/** Every table shape this generator has a branch for, compiled together. */
const tables = [
  users,
  posts,
  books,
  memberships,
  auditLog,
  activeUsers,
  dailyTotals,
  events,
  tasks,
  metrics,
];

afterAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
});

async function compile(
  label: string,
  opts: Record<string, unknown>,
  extra = '',
  compilerExtras: Record<string, unknown> = {}
) {
  const dir = path.join(workRoot, label);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'api'), { recursive: true });
  await new GraphQLGenerator(analysis(tables)).generate({
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
          ...compilerExtras,
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
    expect(existsSync(tsc), `no tsc at ${tsc}; run pnpm install`).toBe(true);
  });

  it('compiles under the exact tsconfig the packed-verification gate constructs', async () => {
    expect(await compile('gate', {})).toBe('');
  });

  it('compiles under verbatimModuleSyntax too', async () => {
    expect(await compile('verbatim', {}, '', { verbatimModuleSyntax: true })).toBe('');
  });

  it('exports row and input types a consumer can build values against', async () => {
    const probe = `import type { Users, CreateUsersInput, Events, Books } from './index.js';

const row: Users = { id: 1, email: 'a@b.c', bio: null, role: 'admin' };
const create: CreateUsersInput = { email: 'a@b.c' };
const event: Events = {
  id: 1,
  at: new Date(),
  flag: true,
  big: 9007199254740993n,
  tags: ['a', null],
  point: [1, 2],
  note: null,
};
const book: Books = { isbn: '1', title: 't', 'cover url': null };
export const values = [row, create, event, book] as const;
`;
    expect(await compile('rowtypes', {}, probe)).toBe('');
  });

  it('exports typeDefs and resolvers as values a consumer can pass on', async () => {
    const probe = `import { typeDefs, resolvers, DateTimeScalar, usersResolvers } from './index.js';

export const things = [typeDefs, resolvers, DateTimeScalar, usersResolvers] as const;
`;
    expect(await compile('values', {}, probe)).toBe('');
  });

  it('would have said so if the tree did not compile', async () => {
    // Every case above passes by producing no output, which a compiler that never ran also
    // does. A mistake of exactly the shape this generator avoids is planted and must be
    // reported: the read-only table has no create input, so naming one is an error.
    const probe = `import type { CreateActiveUsersInput } from './index.js';

export const nope: CreateActiveUsersInput = {};
`;
    const out = await compile('canary', {}, probe);
    expect(out).not.toBe('');
    expect(out).toMatch(/probe\.ts/);
  });

  it('rejects an enum member the column does not have, at the type level', async () => {
    const probe = `import type { Users } from './index.js';

export const row: Users = { id: 1, email: 'a@b.c', bio: null, role: 'boss' };
`;
    const out = await compile('enum-canary', {}, probe);
    expect(out).not.toBe('');
    expect(out).toMatch(/probe\.ts/);
  });

  it('types a mangled enum argument as the database values', async () => {
    const probe = `import type { CreateTasksInput } from './index.js';

export const ok: CreateTasksInput = { status: 'in-progress' };
// @ts-expect-error the GraphQL member name is not the value a resolver receives
export const bad: CreateTasksInput = { status: 'IN_PROGRESS' };
`;
    expect(await compile('enum-values', {}, probe)).toBe('');
  });
});

describe('a consumer schema module, compiled the way the docs show', () => {
  it('builds with @graphql-tools/schema and overrides a stub', async () => {
    const probe = `import { makeExecutableSchema } from '@graphql-tools/schema';
import { typeDefs, resolvers, type Users } from './index.js';

const rows: Users[] = [];

export const schema = makeExecutableSchema({
  typeDefs,
  resolvers: {
    ...resolvers,
    Query: { ...resolvers.Query, users: (): Users[] => rows },
  },
});
`;
    // This probe resolves @graphql-tools/schema and graphql from this package's own
    // node_modules, which is exactly a consumer with both installed.
    expect(await compile('consumer', {}, probe)).toBe('');
  });
});
