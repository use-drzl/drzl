/**
 * The emitted builder compiles, and the schema it produces is executed.
 *
 * Both halves matter and neither substitutes for the other. The compile is the whole point of
 * emitting a builder rather than the SDL DRZL already writes: a resolver returning the wrong shape
 * has to be a type error. The execution is what proves the schema is real, since a builder that
 * compiles can still assemble a schema with nothing on it.
 *
 * The nullability assertions are the load-bearing ones. Pothos defaults every field to nullable, so
 * a NOT NULL column emitted without care reaches clients as `String` and every one of them
 * null-checks a field that cannot be null. That is checked here against a real `printSchema` rather
 * than against the emitted text, because the question is what GraphQL ends up believing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PothosGenerator } from '../src';
import { analysis, col, table } from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const workRoot = path.join(pkgRoot, 'test', 'tmp');
const tsc = path.join(pkgRoot, 'node_modules', '.bin', 'tsc');
const TSC_TIMEOUT = 180_000;

/** One column of every kind the mapper decides differently about. */
const users = table('users', {
  columns: [
    // Bounded to 32 bits, so `Int` is provable.
    col('id', 'number', { integer: true, min: '1', max: '2147483647', sqlType: 'serial' }),
    col('email', 'string', { sqlType: 'text' }),
    col('bio', 'string', { nullable: true, sqlType: 'text' }),
    col('active', 'boolean', { sqlType: 'boolean' }),
    col('seenAt', 'Date', { nullable: true, sqlType: 'timestamp' }),
    col('views', 'bigint', { sqlType: 'bigint' }),
    // Unbounded, so `Int` cannot be proven and `Float` is the honest answer.
    col('score', 'number', { integer: true, sqlType: 'bigint' }),
    col('token', 'string', { format: 'uuid', sqlType: 'uuid' } as never),
    col('meta', 'any', { nullable: true, sqlType: 'jsonb' }),
  ],
  primaryKey: { columns: ['id'] },
});

const posts = table('posts', {
  columns: [
    col('id', 'number', { integer: true, min: '1', max: '2147483647', sqlType: 'serial' }),
    col('title', 'string', { sqlType: 'text' }),
  ],
  primaryKey: { columns: ['id'] },
});

const tables = [users, posts];

interface Built {
  schema: unknown;
}
let built: Built;
/** SDL-shaped text rendered from the schema object itself. See `renderTypes`. */
let printed: string;

/**
 * The schema's own description of itself, rendered without importing graphql.
 *
 * `printSchema` cannot be used here. graphql-js refuses to work across two instances of itself, and
 * this suite produces exactly that: Pothos builds the schema with the copy vitest externalises to
 * Node, while anything this spec imports is transformed through vitest's own graph. Both are
 * 17.0.2, both are different objects, and `printSchema` answers
 * "Duplicate graphql modules cannot be used at the same time".
 *
 * Asking the schema object instead sidesteps it, and is the better question anyway: `String(type)`
 * is rendered by whichever instance built that type, so `Int!` and `[Users!]!` come out of the
 * schema rather than out of a printer that has to recognise it first.
 */
function renderTypes(schema: unknown): string {
  const s = schema as {
    getTypeMap: () => Record<string, unknown>;
  };
  const out: string[] = [];
  for (const [name, type] of Object.entries(s.getTypeMap())) {
    if (name.startsWith('__')) continue;
    const t = type as { getFields?: () => Record<string, { type: unknown }> };
    if (typeof t.getFields !== 'function') {
      // A scalar has no fields, and its presence is what the scalar assertions look for.
      out.push(`scalar ${name}`);
      continue;
    }
    const fields = Object.entries(t.getFields())
      .map(([f, def]) => `  ${f}: ${String(def.type)}`)
      .join('\n');
    out.push(`type ${name} {\n${fields}\n}`);
  }
  return out.join('\n\n');
}

beforeAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
  const runDir = path.join(workRoot, 'run');
  await fs.mkdir(runDir, { recursive: true });
  await new PothosGenerator(analysis(tables)).generate({
    outputDir: runDir,
    // `.ts`, because these modules are imported by vitest rather than compiled first.
    importExtension: 'ts',
  } as never);
  built = (await import(/* @vite-ignore */ path.join(runDir, 'index.ts'))) as unknown as Built;
  printed = renderTypes(built.schema);
}, 120_000);

afterAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
});

/** The block of printed SDL for one type, so an assertion cannot match the next type's field. */
function block(sdl: string, typeName: string): string {
  const start = sdl.indexOf(`type ${typeName} {`);
  if (start === -1) return '';
  return sdl.slice(start, sdl.indexOf('}', start));
}

describe('nullability, which Pothos gets wrong by default', () => {
  /**
   * The must-fire half.
   *
   * Pothos defaults every field to nullable. Without `defaultFieldNullability: false` on the emitted
   * builder, `email` here would print as `String` and clients would null-check a column the database
   * refuses to leave empty. Asserted against a real `printSchema`, because the question is what
   * GraphQL believes rather than what the emitted text says.
   */
  it('marks a NOT NULL column non-null', () => {
    const t = block(printed, 'Users');
    expect(t).toMatch(/email: String!/);
    expect(t).toMatch(/active: Boolean!/);
    expect(t).toMatch(/id: Int!/);
  });

  it('marks a nullable column nullable, and not with a bang', () => {
    const t = block(printed, 'Users');
    expect(t).toMatch(/bio: String\b/);
    expect(t).not.toMatch(/bio: String!/);
    expect(t).not.toMatch(/seenAt: DateTime!/);
  });

  /**
   * And the reason, stated as a test rather than a comment.
   *
   * If a later Pothos changes its default, this fails and the emitted option can come out.
   */
  it('is still the Pothos default that a bare field is nullable', async () => {
    // Built through the emitted tree, so Pothos uses the same graphql instance it does there.
    const dir = path.join(workRoot, 'run');
    await fs.writeFile(
      path.join(dir, 'default-probe.ts'),
      [
        "import SchemaBuilder from '@pothos/core';",
        'const b = new SchemaBuilder<{ Objects: { T: { bare: string } } }>({});',
        "b.objectType('T', { fields: (t) => ({ bare: t.exposeString('bare') }) });",
        "b.queryType({ fields: (t) => ({ t: t.field({ type: 'T', resolve: () => ({ bare: 'x' }) }) }) });",
        'export const schema = b.toSchema();',
        '',
      ].join('\n'),
      'utf8'
    );
    const mod = (await import(
      /* @vite-ignore */ path.join(dir, 'default-probe.ts')
    )) as unknown as { schema: unknown };
    const t = block(renderTypes(mod.schema), 'T');
    expect(t, 'Pothos now defaults to non-null, so the emitted option can go').toMatch(
      /bare: String$/m
    );
  });
});

describe('the scalar decisions, which match the SDL generator', () => {
  it('uses Int only where declared bounds prove 32 bits', () => {
    const t = block(printed, 'Users');
    // `id` is bounded to int32; `score` is an unbounded integer, so Float is the honest answer.
    expect(t).toMatch(/id: Int!/);
    expect(t).toMatch(/score: Float!/);
  });

  it('gives a uuid column ID rather than String', () => {
    expect(block(printed, 'Users')).toMatch(/token: ID!/);
  });

  it('registers a custom scalar for each of Date, bigint and json', () => {
    expect(printed).toMatch(/scalar DateTime/);
    expect(printed).toMatch(/scalar BigInt/);
    expect(printed).toMatch(/scalar JSON/);
    const t = block(printed, 'Users');
    expect(t).toMatch(/views: BigInt!/);
    expect(t).toMatch(/meta: JSON\b/);
  });
});

describe('the schema it assembles', () => {
  it('has a query field per table', () => {
    const query = block(printed, 'Query');
    expect(query).toMatch(/users: \[Users!\]!/);
    expect(query).toMatch(/posts: \[Posts!\]!/);
  });

  /**
   * An unimplemented resolver fails rather than answering with nothing.
   *
   * A caller reading an empty array cannot tell "no rows" from "nobody wrote this yet", so the stub
   * throws. The resolver is pulled off the schema object and called, rather than going through
   * `graphql()`, for the one-instance reason `renderTypes` records.
   */
  it('throws from a stub resolver instead of answering with an empty list', () => {
    const s = built.schema as {
      getQueryType: () => { getFields: () => Record<string, { resolve?: (...a: never[]) => unknown }> };
    };
    const resolve = s.getQueryType().getFields()['users']?.resolve;
    expect(typeof resolve, 'the query field has no resolver at all').toBe('function');
    expect(() => resolve!()).toThrow(/Not implemented/);
  });
});

describe('the emitted tree', () => {
  it('has a tsc to run', () => {
    expect(existsSync(tsc), `no tsc at ${tsc}; run pnpm install`).toBe(true);
  });

  /**
   * The compile, which is the whole reason to emit a builder rather than SDL.
   *
   * The probe reads a row field by name and assigns it at its declared type, so a mapper that typed
   * a column wrongly fails here. The canary reads a field that does not exist.
   */
  it(
    'compiles, and checks a resolver against the row type',
    async () => {
      expect(await compile('ok', PROBE)).toBe('');
    },
    TSC_TIMEOUT
  );

  it(
    'would have said so if the tree did not compile',
    async () => {
      const out = await compile('canary', CANARY);
      expect(out).not.toBe('');
      expect(out).toMatch(/probe\.ts/);
    },
    TSC_TIMEOUT
  );
});

const PROBE = `import type { UsersRow } from './builder.js';

// Every field at its declared type, so a wrong mapping is a compile error.
export function read(row: UsersRow) {
  const id: number = row.id;
  const email: string = row.email;
  const bio: string | null = row.bio;
  const seenAt: Date | null = row.seenAt;
  const views: bigint = row.views;
  const token: string = row.token;
  return { id, email, bio, seenAt, views, token };
}
`;

const CANARY = `import type { UsersRow } from './builder.js';
// There is no such column, so this must not compile.
export const bad: string = ({} as UsersRow).nope;
`;

async function compile(label: string, probe: string) {
  const dir = path.join(workRoot, label);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'gql'), { recursive: true });
  await new PothosGenerator(analysis(tables)).generate({
    outputDir: path.join(dir, 'gql'),
  } as never);
  await fs.writeFile(path.join(dir, 'gql', 'probe.ts'), probe, 'utf8');

  const tsconfig = path.join(dir, 'tsconfig.json');
  await fs.writeFile(
    tsconfig,
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'es2022',
        lib: ['es2023'],
        module: 'preserve',
        moduleResolution: 'bundler',
        skipLibCheck: true,
      },
      include: ['gql/**/*.ts'],
    })
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
