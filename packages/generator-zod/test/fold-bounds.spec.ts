/**
 * A numeric CHECK tightens the declared range instead of adding a predicate beside it.
 *
 * `CHECK (age >= 18)` on an integer column emitted
 * `.gte(-2147483648).lte(2147483647).refine((v) => v >= 18)`: a bound that can never fail, plus a
 * closure that says what the bound should have said. The arktype and typebox generators already
 * fold this into the range; zod kept both.
 *
 * Three things are wrong with that, and only one of them is speed. The error message from a
 * refine is whatever the generator writes, where `.gte(18)` produces zod's own "Too small,
 * expected number to be >=18" with the bound machine-readable in the issue. And every constraint
 * ships in the consumer's bundle.
 */
import { describe, it, expect } from 'vitest';
import { ZodGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const col = (name: string, over: Partial<Column> = {}): Column =>
  ({
    name,
    tsType: 'number',
    dbType: 'INTEGER',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    min: '-2147483648',
    max: '2147483647',
    integer: true,
    ...over,
  }) as Column;

async function emit(columns: Column[], checks: { name?: string; expression?: string }[]) {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-fold-'));
  await new ZodGenerator(analysis).generate({ outDir } as never);
  return fs.readFile(path.join(outDir, 't.zod.ts'), 'utf8');
}

/** The select schema's source for one field, whitespace collapsed so prettier cannot matter. */
async function fieldOf(name: string, columns: Column[], checks: any[]) {
  const src = await emit(columns, checks);
  const block = src.match(/SelecttSchema = z\.object\(\{([\s\S]*?)\n\}\)/)?.[1] ?? src;
  return block
    .split(/\n(?=\s{2}\w+:)/)
    .find((l) => l.trim().startsWith(`${name}:`))!
    .replace(/\s+/g, ' ')
    .trim();
}

describe('a numeric CHECK', () => {
  it('replaces the declared lower bound rather than sitting beside it', async () => {
    const f = await fieldOf('age', [col('age')], [{ name: 'a', expression: 'age >= 18' }]);
    expect(f).toContain('.gte(18)');
    expect(f, 'the range it can never fail is gone').not.toContain('-2147483648');
    expect(f, 'and so is the closure').not.toContain('refine');
  });

  it('replaces the upper bound the same way', async () => {
    const f = await fieldOf('n', [col('n')], [{ expression: 'n <= 100' }]);
    expect(f).toContain('.lte(100)');
    expect(f).not.toContain('2147483647');
    expect(f).not.toContain('refine');
  });

  it('uses the exclusive form, which zod has natively', async () => {
    const f = await fieldOf('n', [col('n')], [{ expression: 'n > 0' }]);
    expect(f).toContain('.gt(0)');
    expect(f).not.toContain('refine');
  });

  it('folds both ends of a BETWEEN', async () => {
    const f = await fieldOf('n', [col('n')], [{ expression: 'n BETWEEN 0 AND 100' }]);
    expect(f).toContain('.gte(0)');
    expect(f).toContain('.lte(100)');
    expect(f).not.toContain('refine');
  });

  it('keeps the declared range where no check narrows that end', async () => {
    const f = await fieldOf('n', [col('n')], [{ expression: 'n >= 18' }]);
    expect(f, 'the int32 ceiling still applies').toContain('.lte(2147483647)');
  });

  it('leaves length() alone, which is not the same measurement', async () => {
    // `.min(2)` counts UTF-16 units and SQL counts characters, so the closure is deliberate.
    const f = await fieldOf(
      's',
      [col('s', { tsType: 'string', dbType: 'TEXT', min: undefined, max: undefined, integer: undefined })],
      [{ expression: 'length(s) >= 2' }]
    );
    expect(f).toContain('refine');
  });
});
