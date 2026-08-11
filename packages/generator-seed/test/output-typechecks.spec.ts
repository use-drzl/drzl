/**
 * The emitted tree compiles, under every module resolution a consumer might use.
 *
 * The runtime spec beside this one is where the claims about values live. This is the narrower
 * question: the emitted row interfaces have to be real types a caller can hold, and the seed
 * functions have to return them, or `db.insert(users).values(seedUsers())` will not typecheck for
 * anyone.
 *
 * `noUnusedLocals` is on, so an emitted module that imports the runtime without using it fails here.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SeedGenerator } from '../src';
import { analysis, table, col } from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const workRoot = path.join(pkgRoot, 'test', 'tmp', 'typecheck');
const tsc = path.join(pkgRoot, 'node_modules', '.bin', 'tsc');
const TSC_TIMEOUT = 180_000;

const products = table('products', {
  columns: [
    col('id', 'number', { hasDefault: true, isGenerated: true }),
    col('name', 'string', { maxLength: 80 }),
    col('status', 'string'),
    col('quantity', 'number', { integer: true }),
    col('price', 'number'),
    col('when', 'Date'),
    col('big', 'bigint'),
    col('live', 'boolean'),
    col('note', 'string', { nullable: true }),
  ],
  primaryKey: { columns: ['id'] },
  checks: [
    { name: 'quantity_range', expression: 'quantity >= 1 AND quantity <= 999' },
    { name: 'status_set', expression: "status IN ('draft', 'live', 'archived')" },
  ],
});

const users = table('users', {
  columns: [col('id', 'number', { hasDefault: true, isGenerated: true }), col('email', 'string')],
  primaryKey: { columns: ['id'] },
});

const tables = [products, users];

afterAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
});

/** Holds each emitted type by hand, which is what proves the interfaces are usable. */
const PROBE = `import { seedProducts, seedAll, insertOrder, type ProductsSeedRow } from './index.js';

const rows: ProductsSeedRow[] = seedProducts(3, 1);

// Every field is reachable at its declared type, and the set is narrowed rather than widened.
export const first: {
  name: string;
  status: 'draft' | 'live' | 'archived';
  quantity: number;
  price: number;
  when: Date;
  big: bigint;
  live: boolean;
  note: string | null;
} | undefined = rows[0];

export const everything = seedAll(2, 1);
export const order: readonly string[] = insertOrder;
`;

async function compile(
  label: string,
  opts: Record<string, unknown> = {},
  probe = PROBE,
  resolution: 'bundler' | 'node16' | 'nodenext' = 'bundler'
) {
  const dir = path.join(workRoot, label);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'seed'), { recursive: true });

  await new SeedGenerator(analysis(tables)).generate({
    outputDir: path.join(dir, 'seed'),
    ...opts,
  } as never);
  if (probe) await fs.writeFile(path.join(dir, 'seed', 'probe.ts'), probe, 'utf8');

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
          module: resolution === 'bundler' ? 'preserve' : resolution,
          moduleResolution: resolution,
          skipLibCheck: true,
        },
        include: ['seed/**/*.ts'],
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

  for (const resolution of ['bundler', 'node16', 'nodenext'] as const) {
    it(
      `compiles under ${resolution}`,
      async () => {
        expect(await compile(resolution, {}, PROBE, resolution)).toBe('');
      },
      TSC_TIMEOUT
    );
  }

  it(
    'compiles with a module suffix, a case and a count',
    async () => {
      // The probe names `seedProducts`, which a renamed module no longer exports.
      expect(
        await compile(
          'naming',
          { defaultCount: 3, naming: { routerSuffix: 'Fixture', procedureCase: 'snake' } },
          ''
        )
      ).toBe('');
    },
    TSC_TIMEOUT
  );

  it(
    'would have said so if the tree did not compile',
    async () => {
      // Every case above passes by producing no output, which a compiler that never ran also does.
      // No backticks in this string: it is itself a template literal, and a backtick in the
      // prose would close it. The same mistake in a shell argument once ran a comment as a command.
      const probe = `import { seedProducts } from './index.js';
// The id column is generated, so no seed row carries one.
export const bad: number = seedProducts(1, 1)[0]!.id;
`;
      const out = await compile('canary', {}, probe);
      expect(out).not.toBe('');
      expect(out).toMatch(/probe\.ts/);
    },
    TSC_TIMEOUT
  );
});

describe('the emitted names', () => {
  it('honours a count, a suffix and a case', async () => {
    const text = await fs.readFile(
      path.join(workRoot, 'naming', 'seed', 'products_fixture.ts'),
      'utf8'
    );
    expect(text).toContain('export function seedProducts_fixture(count = 3');
    expect(text).toContain('Products_fixtureSeedRow');
  });

  it('refuses a name that would collide with a module it also writes', async () => {
    const t = table('index', { columns: [col('a', 'string')] });
    await expect(
      new SeedGenerator(analysis([t])).generate({
        outputDir: path.join(workRoot, 'collide', 'seed'),
      } as never)
    ).rejects.toThrow(/a module this generator also writes/);
  });
});
