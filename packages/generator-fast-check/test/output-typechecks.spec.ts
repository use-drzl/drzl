/**
 * The emitted arbitraries compile against the real `fast-check`, under every module resolution.
 *
 * The runtime spec beside this one is where the claims about drawn values live. This is the narrower
 * question: `fc.Arbitrary<Row>` has to really be that type, or `fc.property(usersArbitrary, ...)`
 * hands the caller `unknown` and every property test is written against nothing.
 *
 * `noUnusedLocals` is on, so an emitted module importing `fc` without using it fails here.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FastCheckGenerator } from '../src';
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

/** Holds each emitted type by hand and runs a property, which is the shape a caller writes. */
const PROBE = `import fc from 'fast-check';
import { productsArbitrary, arbitraries, type ProductsRow } from './index.js';

// The arbitrary really is of the row type, so a property gets a typed argument.
export const prop = fc.property(productsArbitrary, (row: ProductsRow) => {
  const status: 'draft' | 'live' | 'archived' = row.status;
  const when: Date = row.when;
  const big: bigint = row.big;
  const note: string | null = row.note;
  return status.length > 0 && when instanceof Date && big >= 0n && note !== undefined;
});

export const keyed: fc.Arbitrary<ProductsRow> = arbitraries.products;
`;

async function compile(
  label: string,
  opts: Record<string, unknown> = {},
  probe = PROBE,
  resolution: 'bundler' | 'node16' | 'nodenext' = 'bundler'
) {
  const dir = path.join(workRoot, label);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'arb'), { recursive: true });

  await new FastCheckGenerator(analysis(tables)).generate({
    outputDir: path.join(dir, 'arb'),
    ...opts,
  } as never);
  if (probe) await fs.writeFile(path.join(dir, 'arb', 'probe.ts'), probe, 'utf8');

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
        include: ['arb/**/*.ts'],
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
    'compiles with a module suffix and a case',
    async () => {
      // The probe names `productsArbitrary`, which a renamed module no longer exports.
      expect(
        await compile('naming', { naming: { routerSuffix: 'Gen', procedureCase: 'snake' } }, '')
      ).toBe('');
    },
    TSC_TIMEOUT
  );

  it(
    'would have said so if the tree did not compile',
    async () => {
      // Every case above passes by producing no output, which a compiler that never ran also does.
      const probe = `import { productsArbitrary } from './index.js';
// The id column is generated, so no drawn row carries one.
export const bad = productsArbitrary.map((row) => row.id);
`;
      const out = await compile('canary', {}, probe);
      expect(out).not.toBe('');
      expect(out).toMatch(/probe\.ts/);
    },
    TSC_TIMEOUT
  );
});

describe('the emitted expressions', () => {
  it('bounds an integer with the intersected range', async () => {
    const text = await fs.readFile(path.join(workRoot, 'bundler', 'arb', 'products.ts'), 'utf8');
    expect(text).toContain('fc.integer({ min: 1, max: 999 })');
  });

  it('uses constantFrom for a set, which is what makes the field type a union', async () => {
    const text = await fs.readFile(path.join(workRoot, 'bundler', 'arb', 'products.ts'), 'utf8');
    expect(text).toContain("fc.constantFrom('draft', 'live', 'archived')");
    expect(text).toMatch(/status: ["']draft["'] \| ["']live["'] \| ["']archived["']/);
  });

  it('leaves an unconstrained column unbounded, unlike the seed generator', async () => {
    // A property test wants the awkward values; a fixture does not. That is the one place these two
    // generators deliberately differ, and it is asserted rather than left to a comment.
    const text = await fs.readFile(path.join(workRoot, 'bundler', 'arb', 'users.ts'), 'utf8');
    expect(text).toContain('fc.string()');
    expect(text).not.toContain('minLength');
  });

  it('honours a suffix and a case', async () => {
    const text = await fs.readFile(path.join(workRoot, 'naming', 'arb', 'products_gen.ts'), 'utf8');
    expect(text).toContain('export const products_genArbitrary');
  });

  it('refuses a name that would collide with the barrel it also writes', async () => {
    const t = table('index', { columns: [col('a', 'string')] });
    await expect(
      new FastCheckGenerator(analysis([t])).generate({
        outputDir: path.join(workRoot, 'collide', 'arb'),
      } as never)
    ).rejects.toThrow(/index\.ts this generator also writes/);
  });
});
