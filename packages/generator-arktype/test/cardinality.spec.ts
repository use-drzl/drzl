/**
 * `CHECK (cardinality(tags) >= 2)` in ArkType output.
 *
 * ArkType bounds an array's length in the same string DSL it bounds a number with, so the
 * constraint folds into the type rather than becoming a separate assertion: `string[] >= 2`.
 *
 * The same rule as for numbers applies: a bound may sit on the left of the type only when the
 * other end sits on the right, so a lone bound is written on the right.
 *
 * Every expression here is executed against arktype, because one it cannot parse throws at import
 * and would take down whatever imported the schema.
 */
import { describe, it, expect } from 'vitest';
import { ArkTypeGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { type } from 'arktype';

const arr = (over: Partial<Column> = {}): Column =>
  ({
    name: 'tags',
    tsType: 'string[]',
    dbType: 'TEXT',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    arrayDimensions: 1,
    ...over,
  }) as Column;

async function typeOf(c: Column, checks: { name?: string; expression?: string }[]) {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns: [c], unique: [], indexes: [], checks }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-atcard-'));
  await new ArkTypeGenerator(analysis).generate({ outDir } as never);
  const src = await fs.readFile(path.join(outDir, 't.arktype.ts'), 'utf8');
  const block = src.match(/SelecttSchema = type\(\{([\s\S]*?)\n\}\)/)?.[1] ?? src;
  const line = block.split('\n').find((l) => /^\s*"?tags"?:/.test(l));
  expect(line, `no field tags in:\n${src}`).toBeTruthy();
  return JSON.parse(
    line!
      .trim()
      .replace(/^"?[A-Za-z0-9_]+"?:\s*/, '')
      .replace(/,$/, '')
  ) as string;
}

/** Lengths the emitted expression accepts, so the assertion is about behaviour not spelling. */
const accepts = (expr: string, lengths: number[]) =>
  lengths.filter((n) => type(expr as never).allows(Array.from({ length: n }, () => 'x')));

describe('a cardinality check', () => {
  it('becomes a lower bound on the array', async () => {
    const t = await typeOf(arr(), [{ name: 'min2', expression: 'cardinality(tags) >= 2' }]);
    expect(accepts(t, [0, 1, 2, 3])).toEqual([2, 3]);
  });

  it('becomes an exclusive lower bound', async () => {
    const t = await typeOf(arr(), [{ expression: 'cardinality(tags) > 2' }]);
    expect(accepts(t, [0, 1, 2, 3])).toEqual([3]);
  });

  it('becomes an upper bound', async () => {
    const t = await typeOf(arr(), [{ expression: 'cardinality(tags) <= 2' }]);
    expect(accepts(t, [0, 1, 2, 3])).toEqual([0, 1, 2]);
  });

  it('pairs the two ends when both are stated', async () => {
    const t = await typeOf(arr(), [
      { expression: 'cardinality(tags) >= 1' },
      { expression: 'cardinality(tags) <= 3' },
    ]);
    expect(accepts(t, [0, 1, 2, 3, 4])).toEqual([1, 2, 3]);
  });

  it('becomes an exact length for an equality', async () => {
    const t = await typeOf(arr(), [{ expression: 'cardinality(tags) = 2' }]);
    expect(accepts(t, [0, 1, 2, 3])).toEqual([2]);
  });

  it('survives being wrapped for a nullable column', async () => {
    // The bound has to bind to the array, not to the union with null.
    const t = await typeOf(arr({ nullable: true }), [{ expression: 'cardinality(tags) >= 2' }]);
    expect(type(t as never).allows(null), 'still nullable').toBe(true);
    expect(type(t as never).allows(['x']), 'bound still applies').toBe(false);
    expect(type(t as never).allows(['x', 'y'])).toBe(true);
  });

  it('is left off a column that is not an array', async () => {
    const t = await typeOf(arr({ arrayDimensions: undefined, tsType: 'string' }), [
      { expression: 'cardinality(tags) >= 2' },
    ]);
    expect(t).toBe('string');
  });
});
