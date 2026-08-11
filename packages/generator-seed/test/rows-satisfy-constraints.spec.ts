/**
 * The rows are generated, then checked against the constraints they claim to satisfy.
 *
 * This is the load-bearing test, and it is a runtime one rather than a compile one, because the
 * claim is about values. A seed module that compiles says nothing: the whole question is whether
 * `quantity` really landed between 1 and 999.
 *
 * The checks below are written out independently of the generator rather than derived from the same
 * code, so a bug in the window arithmetic cannot make both sides agree. The fixture's constraints
 * are named in the assertions by hand for the same reason.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SeedGenerator } from '../src';
import { analysis, table, col } from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const workRoot = path.join(pkgRoot, 'test', 'tmp', 'run');

/**
 * A table carrying one of every constraint shape this generator acts on.
 *
 * `quantity` is a bounded integer, `status` a set, `name` a length, and `price`/`cost` a row
 * comparison, which is the one no per-column generator can satisfy.
 */
const products = table('products', {
  columns: [
    col('id', 'number', { hasDefault: true, isGenerated: true }),
    col('name', 'string', { maxLength: 80 }),
    col('status', 'string'),
    col('quantity', 'number', { integer: true }),
    col('price', 'number'),
    col('cost', 'number'),
    col('note', 'string', { nullable: true }),
  ],
  primaryKey: { columns: ['id'] },
  checks: [
    { name: 'quantity_range', expression: 'quantity >= 1 AND quantity <= 999' },
    { name: 'status_set', expression: "status IN ('draft', 'live', 'archived')" },
    { name: 'name_length', expression: 'length(name) > 3' },
    { name: 'margin', expression: 'price > cost' },
  ],
});

/** A strict lower bound on a float, which is where a naive picker lands exactly on the bound. */
const readings = table('readings', {
  columns: [
    col('id', 'number', { hasDefault: true, isGenerated: true }),
    col('celsius', 'number'),
  ],
  primaryKey: { columns: ['id'] },
  checks: [{ name: 'above_absolute_zero', expression: 'celsius > -273.15' }],
});

/** Two tables where one references the other, for the insert order. */
const users = table('users', {
  columns: [col('id', 'number', { hasDefault: true, isGenerated: true }), col('email', 'string')],
  primaryKey: { columns: ['id'] },
});
const posts = table('posts', {
  columns: [
    col('id', 'number', { hasDefault: true, isGenerated: true }),
    col('authorId', 'number', {
      references: { table: 'users', column: 'id' },
    } as never),
    col('title', 'string'),
  ],
  primaryKey: { columns: ['id'] },
});

const tables = [products, readings, users, posts];

interface Mod {
  seedProducts: (count?: number, seed?: number) => Record<string, unknown>[];
  seedReadings: (count?: number, seed?: number) => Record<string, unknown>[];
  seedAll: (count?: number, seed?: number) => Record<string, Record<string, unknown>[]>;
  insertOrder: readonly string[];
}

let mod: Mod;

beforeAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
  await fs.mkdir(workRoot, { recursive: true });
  await new SeedGenerator(analysis(tables)).generate({
    outputDir: workRoot,
    // `.ts`, because these modules are imported by vitest rather than compiled first.
    importExtension: 'ts',
  } as never);
  mod = (await import(/* @vite-ignore */ path.join(workRoot, 'index.ts'))) as unknown as Mod;
}, 120_000);

afterAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
});

describe('every row satisfies every constraint the parser read', () => {
  it('keeps a bounded integer inside its bounds, and whole', () => {
    for (const row of mod.seedProducts(200, 7)) {
      const q = row.quantity as number;
      expect(Number.isInteger(q), `quantity ${q} is not whole`).toBe(true);
      expect(q).toBeGreaterThanOrEqual(1);
      expect(q).toBeLessThanOrEqual(999);
    }
  });

  it('picks a set member for a column constrained by IN', () => {
    const allowed = new Set(['draft', 'live', 'archived']);
    for (const row of mod.seedProducts(200, 7)) {
      expect(allowed.has(row.status as string), `status ${row.status}`).toBe(true);
    }
  });

  it('respects a length constraint and the declared width at once', () => {
    for (const row of mod.seedProducts(200, 7)) {
      const n = (row.name as string).length;
      expect(n, `length(name) = ${n}`).toBeGreaterThan(3);
      expect(n).toBeLessThanOrEqual(80);
    }
  });

  /**
   * The row comparison, which is the one no per-column generator can satisfy.
   *
   * `price > cost` is a statement about the row: neither value alone can be chosen to make it hold.
   * Retrying until it does is the usual answer and takes on average two attempts here, but never
   * terminates for a narrow enough pair.
   */
  it('orders a pair of columns a row comparison relates', () => {
    for (const row of mod.seedProducts(300, 7)) {
      expect(row.price as number, `price ${row.price} vs cost ${row.cost}`).toBeGreaterThan(
        row.cost as number
      );
    }
  });

  it('stays strictly inside a strict float bound', () => {
    // The window for `celsius > -273.15` starts just above it. A picker that clamped to the bound
    // itself would produce a value the database refuses.
    for (const row of mod.seedReadings(300, 7)) {
      expect(row.celsius as number).toBeGreaterThan(-273.15);
    }
  });

  it('leaves a generated column out entirely', () => {
    // The database computes it and refuses a value, so a row carrying one cannot be inserted.
    for (const row of mod.seedProducts(5, 7)) {
      expect(Object.keys(row)).not.toContain('id');
    }
  });

  it('nulls a nullable column sometimes and not always', () => {
    const rows = mod.seedProducts(300, 7);
    const nulls = rows.filter((r) => r.note === null).length;
    expect(nulls, 'never null, so the null path is never exercised').toBeGreaterThan(0);
    expect(nulls, 'always null, so the value path is never exercised').toBeLessThan(rows.length);
  });

  /**
   * A column a row comparison names is never null.
   *
   * `price > cost` cannot hold if either side is missing, so the nullable-sometimes rule above has
   * to stand down for those two. Asserted rather than assumed, because it is the interaction
   * between two independent rules and neither one's own test would catch it.
   */
  it('never nulls a column that a row comparison needs', () => {
    for (const row of mod.seedProducts(300, 7)) {
      expect(row.price).not.toBeNull();
      expect(row.cost).not.toBeNull();
    }
  });
});

describe('a column nothing constrains', () => {
  /**
   * Drawn from a readable window, not from the type's full range.
   *
   * `price` and `cost` carry no declared bound, only the row comparison between them. Drawing from
   * the safe integer range satisfied every stated constraint and produced a price of
   * 4283991245827361, which is useless as a fixture. Nothing declares a bound, so nothing is
   * violated by choosing a window a human can read.
   */
  it('draws from a fixture window rather than the whole numeric range', () => {
    for (const row of mod.seedProducts(200, 7)) {
      expect(row.price as number).toBeLessThanOrEqual(10001);
      expect(row.cost as number).toBeGreaterThanOrEqual(0);
    }
  });

  /**
   * A declared bound still wins over that window.
   *
   * Asserted with a column whose CHECK puts it entirely outside the fixture range, so a fixture
   * window applied unconditionally would produce a value the database refuses.
   */
  it('respects a bound that lies outside the fixture window', async () => {
    const dir = path.join(workRoot, 'far');
    await fs.mkdir(dir, { recursive: true });
    const far = table('far', {
      columns: [
        col('id', 'number', { hasDefault: true, isGenerated: true }),
        col('big', 'number', { integer: true }),
      ],
      primaryKey: { columns: ['id'] },
      checks: [{ name: 'far_range', expression: 'big >= 500000 AND big <= 500100' }],
    });
    await new SeedGenerator(analysis([far])).generate({
      outputDir: dir,
      importExtension: 'ts',
    } as never);
    const m = (await import(/* @vite-ignore */ path.join(dir, 'index.ts'))) as unknown as {
      seedFar: (c?: number, s?: number) => Record<string, unknown>[];
    };
    for (const row of m.seedFar(100, 5)) {
      expect(row.big as number).toBeGreaterThanOrEqual(500000);
      expect(row.big as number).toBeLessThanOrEqual(500100);
    }
  });

  /**
   * A set from a CHECK types the field as precisely as a declared enum would.
   *
   * `rng.pick` returns the union of its argument, so widening the field to `string` would throw
   * away what the row actually is.
   */
  it('types a CHECK-derived set as its union rather than as string', async () => {
    const text = await fs.readFile(path.join(workRoot, 'products.ts'), 'utf8');
    const start = text.indexOf('export interface ProductsSeedRow');
    const region = text.slice(start, text.indexOf('}', start));
    // Quote-agnostic: prettier picks up the repo's `singleQuote` for a path inside the package
    // and its own default outside, so the same emitted text is written both ways.
    expect(region).toMatch(/status: ["']draft["'] \| ["']live["'] \| ["']archived["']/);
    expect(region).not.toMatch(/status: string;/);
  });
});

describe('determinism', () => {
  it('gives the same rows for the same seed', () => {
    expect(mod.seedProducts(50, 42)).toEqual(mod.seedProducts(50, 42));
  });

  it('gives different rows for a different seed', () => {
    expect(mod.seedProducts(50, 42)).not.toEqual(mod.seedProducts(50, 43));
  });

  it('gives the count it was asked for', () => {
    expect(mod.seedProducts(0, 1)).toHaveLength(0);
    expect(mod.seedProducts(1, 1)).toHaveLength(1);
    expect(mod.seedProducts(137, 1)).toHaveLength(137);
  });
});

describe('the barrel', () => {
  it('orders tables so a referencing table never precedes the one it references', () => {
    const order = mod.insertOrder;
    expect(order.indexOf('users')).toBeLessThan(order.indexOf('posts'));
    expect([...order].sort()).toEqual(['posts', 'products', 'readings', 'users']);
  });

  it('seeds every table at once, with the same determinism', () => {
    const all = mod.seedAll(5, 3);
    expect(Object.keys(all).sort()).toEqual(['posts', 'products', 'readings', 'users']);
    expect(all.products).toHaveLength(5);
    expect(mod.seedAll(5, 3)).toEqual(all);
  });
});

describe('what the module says about itself', () => {
  it('names the constraints it satisfied by construction', async () => {
    const text = await fs.readFile(path.join(workRoot, 'products.ts'), 'utf8');
    expect(text).toContain('Satisfied by construction:');
    expect(text).toContain('quantity >= 1');
    expect(text).toContain('price > cost');
  });

  /**
   * An expression the parser cannot read is named rather than silently dropped.
   *
   * The alternative is a seed module that looks complete and produces rows the database rejects,
   * with nothing anywhere saying which rule was not considered.
   */
  it('names a constraint it could not read, rather than implying it holds', async () => {
    const dir = path.join(workRoot, 'unparsed');
    await fs.mkdir(dir, { recursive: true });
    const odd = table('odd', {
      columns: [col('id', 'number', { hasDefault: true, isGenerated: true }), col('a', 'number')],
      primaryKey: { columns: ['id'] },
      checks: [{ name: 'weird', expression: 'lower(a::text) SIMILAR TO %handwave%' }],
    });
    await new SeedGenerator(analysis([odd])).generate({
      outputDir: dir,
      importExtension: 'ts',
    } as never);
    const text = await fs.readFile(path.join(dir, 'odd.ts'), 'utf8');
    expect(text).toContain('the parser could not read');
    expect(text).toContain('weird');
  });
});
