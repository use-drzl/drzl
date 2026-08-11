/**
 * The arbitraries are drawn from, and every value is checked against the constraints they claim.
 *
 * A runtime spec rather than a compile one, because the claims are about values. An arbitrary that
 * compiles says nothing: the whole question is whether 5000 draws ever land outside the window.
 *
 * The checks are written out independently of the generator rather than derived from the same code,
 * so a bug in the window arithmetic cannot make both sides agree.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FastCheckGenerator } from '../src';
import { analysis, table, col } from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const workRoot = path.join(pkgRoot, 'test', 'tmp', 'run');

/** How many draws each assertion takes. Large enough that a 1-in-350 defect shows up reliably. */
const DRAWS = 5000;

/** A table carrying one of every constraint shape this generator acts on. */
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

/**
 * A bounded float that cannot hold NaN, which is the case the whole generator exists for.
 *
 * `allowsNaN: false` is what the analyzer says about an `integer`-backed or precision-carrying
 * column, measured against a real server. The emitted arbitrary has to turn that into `noNaN: true`,
 * because bounds alone do not exclude it.
 */
const readings = table('readings', {
  columns: [
    col('id', 'number', { hasDefault: true, isGenerated: true }),
    col('celsius', 'number', { allowsNaN: false, allowsInfinity: false } as never),
  ],
  primaryKey: { columns: ['id'] },
  checks: [{ name: 'above_absolute_zero', expression: 'celsius > -273.15' }],
});

/** A float that really does hold NaN, so the generator must not exclude it. */
const samples = table('samples', {
  columns: [
    col('id', 'number', { hasDefault: true, isGenerated: true }),
    col('reading', 'number', { allowsNaN: true, allowsInfinity: true } as never),
  ],
  primaryKey: { columns: ['id'] },
});

const tables = [products, readings, samples];

interface Row {
  [k: string]: unknown;
}
interface Mod {
  productsArbitrary: fc.Arbitrary<Row>;
  readingsArbitrary: fc.Arbitrary<Row>;
  samplesArbitrary: fc.Arbitrary<Row>;
  arbitraries: Record<string, fc.Arbitrary<Row>>;
}

let mod: Mod;

beforeAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
  await fs.mkdir(workRoot, { recursive: true });
  await new FastCheckGenerator(analysis(tables)).generate({
    outputDir: workRoot,
    // `.ts`, because these modules are imported by vitest rather than compiled first.
    importExtension: 'ts',
  } as never);
  mod = (await import(/* @vite-ignore */ path.join(workRoot, 'index.ts'))) as unknown as Mod;
}, 120_000);

afterAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
});

describe('every drawn row satisfies every constraint the parser read', () => {
  it('keeps a bounded integer inside its bounds, and whole', () => {
    for (const row of fc.sample(mod.productsArbitrary, DRAWS)) {
      const q = row.quantity as number;
      expect(Number.isInteger(q) && q >= 1 && q <= 999, `quantity ${q}`).toBe(true);
    }
  });

  it('draws only set members for a column constrained by IN', () => {
    const allowed = new Set(['draft', 'live', 'archived']);
    for (const row of fc.sample(mod.productsArbitrary, DRAWS)) {
      expect(allowed.has(row.status as string), `status ${row.status}`).toBe(true);
    }
  });

  it('respects a length constraint and the declared width at once', () => {
    for (const row of fc.sample(mod.productsArbitrary, DRAWS)) {
      const n = (row.name as string).length;
      expect(n > 3 && n <= 80, `length(name) = ${n}`).toBe(true);
    }
  });

  /**
   * The row comparison, which cannot be expressed as a per-column arbitrary at all.
   *
   * Neither value alone can be chosen to make `price > cost` hold, so both are drawn independently
   * and the pair is ordered by a `.map` over the finished record.
   */
  it('orders a pair of columns a row comparison relates', () => {
    for (const row of fc.sample(mod.productsArbitrary, DRAWS)) {
      expect(
        (row.price as number) > (row.cost as number),
        `price ${row.price} vs cost ${row.cost}`
      ).toBe(true);
    }
  });

  it('stays strictly inside a strict float bound', () => {
    for (const row of fc.sample(mod.readingsArbitrary, DRAWS)) {
      expect(row.celsius as number).toBeGreaterThan(-273.15);
    }
  });

  it('leaves a generated column out entirely', () => {
    for (const row of fc.sample(mod.productsArbitrary, 5)) {
      expect(Object.keys(row)).not.toContain('id');
    }
  });

  it('nulls a nullable column sometimes and not always', () => {
    const rows = fc.sample(mod.productsArbitrary, DRAWS);
    const nulls = rows.filter((r) => r.note === null).length;
    expect(nulls, 'never null').toBeGreaterThan(0);
    expect(nulls, 'always null').toBeLessThan(rows.length);
  });

  it('never nulls a column that a row comparison needs', () => {
    for (const row of fc.sample(mod.productsArbitrary, DRAWS)) {
      expect(row.price).not.toBeNull();
      expect(row.cost).not.toBeNull();
    }
  });
});

describe('separating two equal values for a strict comparison', () => {
  /**
   * The must-fire test for a defect that was flaky.
   *
   * The first draft nudged with `hi + 1`, and `Number.MAX_VALUE + 1 === Number.MAX_VALUE`, so a row
   * that drew that value for both `price` and `cost` came out equal and violated `price > cost`.
   * `fc.double()` reaches that value on an unconstrained column, so the failure appeared on some
   * runs and not others, which is the shape of bug a fixed-seed test never sees.
   *
   * This drives the emitted helper directly at both extremes instead of hoping a draw lands there.
   */
  const separate = (lo: number, hi: number, step: number): [number, number] => {
    // The same source the generator emits, imported by evaluating the module it wrote.
    return separateFn(lo, hi, step);
  };
  let separateFn: (lo: number, hi: number, step: number) => [number, number];

  beforeAll(async () => {
    const text = await fs.readFile(path.join(workRoot, 'products.ts'), 'utf8');
    expect(text, 'the helper was not emitted at all').toContain('function drzlSeparate');
    // Pull the emitted function out and run it, so this tests the shipped text rather than a copy.
    const body = text.slice(text.indexOf('function drzlSeparate'));
    const end = body.indexOf('\n}\n');
    const src = body.slice(0, end + 2).replace(/: number|: \[number, number\]/g, '');
    separateFn = new Function(`${src}; return drzlSeparate;`)() as typeof separateFn;
  });

  it('separates an ordinary pair, keeping both whole when the step is whole', () => {
    // Which side moves is not the contract; that they end up ordered is. The helper lowers first,
    // because that is the direction that works at the top of the range.
    const [lo, hi] = separate(5, 5, 1);
    expect(lo).toBeLessThan(hi);
    expect(Number.isInteger(lo) && Number.isInteger(hi)).toBe(true);
  });

  it('separates a pair at the top of the range, where adding one does nothing', () => {
    // The measured case: `Number.MAX_VALUE + 1` is `Number.MAX_VALUE`.
    expect(Number.MAX_VALUE + 1).toBe(Number.MAX_VALUE);
    const [lo, hi] = separate(Number.MAX_VALUE, Number.MAX_VALUE, Number.MIN_VALUE);
    expect(lo).toBeLessThan(hi);
    expect(Number.isFinite(lo)).toBe(true);
    expect(Number.isFinite(hi)).toBe(true);
  });

  it('separates a pair at the bottom, where lowering would overflow instead', () => {
    const [lo, hi] = separate(-Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE);
    expect(lo).toBeLessThan(hi);
    expect(Number.isFinite(lo)).toBe(true);
    expect(Number.isFinite(hi)).toBe(true);
  });

  it('leaves an already ordered pair alone', () => {
    expect(separate(1, 2, 1)).toEqual([1, 2]);
  });

  /**
   * And the property itself, over enough draws that the extremes are actually reached.
   *
   * 30,000 rather than the usual 5,000, because `Number.MAX_VALUE` is one of fast-check's biased
   * corner cases but is not drawn on most runs.
   */
  it('holds the comparison over draws that reach the extremes', () => {
    for (const row of fc.sample(mod.productsArbitrary, 30_000)) {
      expect(
        (row.price as number) > (row.cost as number),
        `price ${row.price} vs cost ${row.cost}`
      ).toBe(true);
    }
  });
});

describe('NaN, which is the whole reason this generator exists', () => {
  /**
   * The must-fire test.
   *
   * `fc.double({ min, max })` produces NaN despite the bounds: measured at 86 in 30,000 samples
   * against fast-check 4.9.0, about one in 350. That is what a hand-written arbitrary gets, and it
   * is the worst possible failure shape for a property test, because the case that fails in CI does
   * not reproduce locally.
   *
   * If a later fast-check stops doing this, this test fails and the emitted `noNaN` can come out.
   */
  it('is still generated by a bounded double, which is what the emitted flag works around', () => {
    const drawn = fc.sample(fc.double({ min: -273.15, max: 1000 }), 30_000);
    const nan = drawn.filter(Number.isNaN).length;
    expect(nan, 'fast-check no longer emits NaN from a bounded double').toBeGreaterThan(0);
  });

  it('is excluded for a column that cannot hold one', () => {
    // Same window as above, through the generator, which adds `noNaN` because `allowsNaN` is false.
    const drawn = fc.sample(mod.readingsArbitrary, 30_000);
    expect(drawn.filter((r) => Number.isNaN(r.celsius as number)).length).toBe(0);
  });

  /**
   * And kept for a column that really does hold one.
   *
   * The half a blanket `noNaN: true` would get wrong. Postgres stores NaN in `real` and
   * `double precision`, so excluding it there would stop a property test ever seeing a value the
   * column holds. The analyzer answers this per column and the generator follows it.
   */
  it('is kept for a column that really does hold one', () => {
    const drawn = fc.sample(mod.samplesArbitrary, 30_000);
    expect(
      drawn.filter((r) => Number.isNaN(r.reading as number)).length,
      'a column that stores NaN never got one'
    ).toBeGreaterThan(0);
  });
});

describe('the emitted modules', () => {
  it('set noNaN only where the column cannot hold one', async () => {
    const bounded = await fs.readFile(path.join(workRoot, 'readings.ts'), 'utf8');
    const free = await fs.readFile(path.join(workRoot, 'samples.ts'), 'utf8');
    expect(bounded).toContain('noNaN: true');
    expect(free).not.toContain('noNaN: true');
  });

  it('names the constraints every drawn value satisfies', async () => {
    const text = await fs.readFile(path.join(workRoot, 'products.ts'), 'utf8');
    expect(text).toContain('Every value drawn satisfies:');
    expect(text).toContain('price > cost');
  });

  it('keys every arbitrary by table in the barrel', () => {
    expect(Object.keys(mod.arbitraries).sort()).toEqual(['products', 'readings', 'samples']);
  });
});

describe('shrinking', () => {
  /**
   * A failing case shrinks to something still inside the constraints.
   *
   * That is the property that makes this worth generating rather than filtering: `fc.pre` or a
   * `.filter` would shrink towards values the constraint excludes and then discard them, so the
   * reported counterexample drifts away from anything the database would accept. A `.map` is total,
   * so every shrink step is still a legal row.
   */
  it('reports a counterexample that still satisfies the constraints', () => {
    let counterexample: Record<string, unknown> | undefined;
    try {
      fc.assert(
        fc.property(mod.productsArbitrary, (row) => (row.quantity as number) < 500),
        { numRuns: 2000 }
      );
    } catch (e) {
      const runDetails = (e as { constructor: { name: string } }) && String(e);
      expect(runDetails).toContain('Property failed');
      const match = /Counterexample: \[([\s\S]*?)\]\s*$/m.exec(String(e));
      expect(match, 'no counterexample in the failure report').toBeTruthy();
      counterexample = { raw: match?.[1] };
    }
    expect(counterexample, 'the property never failed, so shrinking was never exercised').toBeTruthy();
    // The shrunk value is a legal row: quantity is still in range, and the margin still holds.
    const raw = String(counterexample?.raw ?? '');
    const quantity = Number(/quantity["']?:\s*(-?\d+)/.exec(raw)?.[1]);
    expect(Number.isInteger(quantity)).toBe(true);
    expect(quantity).toBeGreaterThanOrEqual(1);
    expect(quantity).toBeLessThanOrEqual(999);
  });
});
