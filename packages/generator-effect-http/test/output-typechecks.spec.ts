/**
 * The emitted tree compiles against the real `@effect/platform`, and that is the load-bearing test.
 *
 * `HttpApi` is a builder whose whole value is in its accumulated type: a client is derived from
 * `typeof api`, so an API that compiles is one whose groups really landed, and an API assembled with
 * separate statements instead of a chain compiles equally well while describing nothing. The probe
 * below asks the finished type for an endpoint by name, which fails if the chain did not accumulate.
 *
 * There is no runtime spec. Serving an `HttpApi` needs a platform layer and a running server, and
 * every claim this generator makes is one the type system settles.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EffectHttpGenerator } from '../src';
import { activeUsers, analysis, auditLog, books, memberships, users } from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const workRoot = path.join(pkgRoot, 'test', 'tmp', 'typecheck');
const tsc = path.join(pkgRoot, 'node_modules', '.bin', 'tsc');
const TSC_TIMEOUT = 180_000;

const tables = [users, books, memberships, auditLog, activeUsers];

afterAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
});

/** Effect Schema modules of the shape `@drzl/generator-effect` emits. */
function sharedSource(): string {
  return [
    "import * as Schema from 'effect/Schema';",
    ...tables.flatMap((t) => [
      `export const Insert${t.tsName}Schema = Schema.Struct({ email: Schema.String });`,
      `export const Update${t.tsName}Schema = Schema.Struct({ email: Schema.optional(Schema.String) });`,
      `export const Select${t.tsName}Schema = Schema.Struct({ id: Schema.Number, email: Schema.String });`,
    ]),
    '',
  ].join('\n');
}

async function compile(label: string, opts: Record<string, unknown> = {}, probe = '') {
  const dir = path.join(workRoot, label);
  const shared = path.join(dir, 'validators');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(shared, { recursive: true });
  await fs.writeFile(path.join(shared, 'index.ts'), sharedSource(), 'utf8');
  await fs.mkdir(path.join(dir, 'api'), { recursive: true });

  await new EffectHttpGenerator(analysis(tables)).generate({
    outputDir: path.join(dir, 'api'),
    validation: {
      library: 'effect',
      useShared: true,
      importPath: path.relative(process.cwd(), shared),
    },
    ...opts,
  } as never);
  if (probe) await fs.writeFile(path.join(dir, 'api', 'probe.ts'), probe, 'utf8');

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
        include: ['api/**/*.ts', 'validators/**/*.ts'],
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

  it('compiles under strict bundler resolution', async () => {
    expect(await compile('base')).toBe('');
  }, TSC_TIMEOUT);

  it('compiles with a module suffix and a case', async () => {
    expect(
      await compile('naming', { naming: { routerSuffix: 'Api', procedureCase: 'snake' } })
    ).toBe('');
  }, TSC_TIMEOUT);

  it('compiles with a named api', async () => {
    expect(await compile('named', { apiName: 'shopApi' })).toBe('');
  }, TSC_TIMEOUT);

  /**
   * The chain, as a compile.
   *
   * `HttpApi` accumulates its groups through the return value of each `.add`, so an API assembled
   * with separate statements compiles and describes nothing. Deriving a client from the finished
   * type is what proves the groups are on it.
   */
  it('produces an api a client can be derived from', async () => {
    const probe = `import { HttpApiClient } from '@effect/platform';
import { api } from './index.js';
import * as Effect from 'effect/Effect';

// Fails to compile if the chain did not accumulate: an api with no groups has no \`users\` key.
export const client = Effect.gen(function* () {
  const c = yield* HttpApiClient.make(api, { baseUrl: 'http://localhost' });
  return yield* c.users.list({ urlParams: {} });
});
`;
    expect(await compile('client', {}, probe)).toBe('');
  }, TSC_TIMEOUT);

  it('would have said so if the tree did not compile', async () => {
    // Every case above passes by producing no output, which a compiler that never ran also does.
    // The mirror of the client probe above, so the canary exercises the same type rather than
    // something easier. `auditLog` has no primary key, so its group has no `byId` endpoint.
    const probe = `import { HttpApiClient } from '@effect/platform';
import { api } from './index.js';
import * as Effect from 'effect/Effect';

export const bad = Effect.gen(function* () {
  const c = yield* HttpApiClient.make(api, { baseUrl: 'http://localhost' });
  return yield* c.auditLog.byId({ path: { id: 1 } });
});
`;
    const out = await compile('canary', {}, probe);
    expect(out).not.toBe('');
    expect(out).toMatch(/probe\.ts/);
  }, TSC_TIMEOUT);
});

describe('the endpoints', () => {
  it('converts a numeric path segment rather than declaring it a number', async () => {
    // A path segment is always a string, so `Schema.Number` refuses every request.
    const text = await fs.readFile(path.join(workRoot, 'base', 'api', 'users.ts'), 'utf8');
    const start = text.indexOf('export const UsersParamsSchema');
    const region = text.slice(start, text.indexOf('export const UsersQuerySchema'));
    expect(start).toBeGreaterThan(-1);
    expect(region).toContain('Schema.NumberFromString');
    expect(region).not.toContain('id: Schema.Number,');
  });

  it('gives a keyless table a list and a create and nothing that addresses a row', async () => {
    const text = await fs.readFile(path.join(workRoot, 'base', 'api', 'auditLog.ts'), 'utf8');
    expect(text).toContain("HttpApiEndpoint.get('list'");
    expect(text).toContain("HttpApiEndpoint.post('create'");
    expect(text).not.toContain("'byId'");
    expect(text).not.toContain("'delete'");
  });

  it('gives a read-only table no writes', async () => {
    const text = await fs.readFile(path.join(workRoot, 'base', 'api', 'activeUsers.ts'), 'utf8');
    expect(text).toContain("HttpApiEndpoint.get('list'");
    expect(text).toContain("HttpApiEndpoint.get('byId'");
    expect(text).not.toContain("'create'");
  });

  it('uses del rather than delete, which is a reserved word', async () => {
    const text = await fs.readFile(path.join(workRoot, 'base', 'api', 'users.ts'), 'utf8');
    expect(text).toContain("HttpApiEndpoint.del('delete'");
  });

  it('addresses a composite key by every one of its columns', async () => {
    const text = await fs.readFile(path.join(workRoot, 'base', 'api', 'memberships.ts'), 'utf8');
    expect(text).toContain("'/:orgId/:userId'");
  });
});

describe('a config that cannot work', () => {
  it('refuses a library other than effect', async () => {
    await expect(
      new EffectHttpGenerator(analysis([users])).generate({
        outputDir: path.join(workRoot, 'wrong-lib', 'api'),
        validation: { library: 'zod', useShared: true, importPath: 'src/validators/zod' },
      } as never)
    ).rejects.toThrow(/HttpApi declares its payloads as Effect Schema/);
  });

  it('refuses to run without a validation generator to import from', async () => {
    await expect(
      new EffectHttpGenerator(analysis([users])).generate({
        outputDir: path.join(workRoot, 'no-schemas', 'api'),
      } as never)
    ).rejects.toThrow(/validation\.useShared/);
  });
});
