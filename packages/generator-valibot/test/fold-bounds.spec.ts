/**
 * A numeric CHECK tightens the declared range instead of adding an action beside it.
 *
 * `CHECK (age >= 18)` on an integer column emitted
 * `v.minValue(-2147483648), v.maxValue(2147483647), v.check((val) => val >= 18)`: a bound that
 * can never fail, plus a closure saying what the bound should have said.
 *
 * The message is the better reason to fix it. `v.check` produces whatever string this generator
 * wrote; `v.minValue(18)` produces valibot's own issue, carrying `requirement: 18` as data rather
 * than as prose. The zod generator was fixed the same way, and arktype and typebox never had the
 * problem.
 */
import { describe, it, expect } from 'vitest';
import { ValibotGenerator } from '../src/index';
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

async function fieldOf(name: string, columns: Column[], checks: any[]) {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-vfold-'));
  await new ValibotGenerator(analysis).generate({ outDir } as never);
  const src = await fs.readFile(path.join(outDir, 't.valibot.ts'), 'utf8');
  const block = src.match(/SelecttSchema = v\.object\(\{([\s\S]*?)\n\}\)/)?.[1] ?? src;
  return block
    .split(/\n(?=\s{2}\w+:)/)
    .find((l) => l.trim().startsWith(`${name}:`))!
    .replace(/\s+/g, ' ')
    .trim();
}

describe('a numeric CHECK', () => {
  it('replaces the declared lower bound rather than sitting beside it', async () => {
    const f = await fieldOf('age', [col('age')], [{ name: 'a', expression: 'age >= 18' }]);
    expect(f).toContain('v.minValue(18)');
    expect(f, 'the bound that can never fail is gone').not.toContain('-2147483648');
    expect(f, 'and so is the closure').not.toContain('v.check');
  });

  it('replaces the upper bound the same way', async () => {
    const f = await fieldOf('n', [col('n')], [{ expression: 'n <= 100' }]);
    expect(f).toContain('v.maxValue(100)');
    expect(f).not.toContain('2147483647');
    expect(f).not.toContain('v.check');
  });

  it('uses the exclusive actions, which valibot has natively', async () => {
    const gt = await fieldOf('n', [col('n')], [{ expression: 'n > 0' }]);
    expect(gt).toContain('v.gtValue(0)');
    expect(gt).not.toContain('v.check');
    const lt = await fieldOf('n', [col('n')], [{ expression: 'n < 10' }]);
    expect(lt).toContain('v.ltValue(10)');
    expect(lt).not.toContain('v.check');
  });

  it('folds both ends of a BETWEEN', async () => {
    const f = await fieldOf('n', [col('n')], [{ expression: 'n BETWEEN 0 AND 100' }]);
    expect(f).toContain('v.minValue(0)');
    expect(f).toContain('v.maxValue(100)');
    expect(f).not.toContain('v.check');
  });

  it('keeps the declared range where no check narrows that end', async () => {
    const f = await fieldOf('n', [col('n')], [{ expression: 'n >= 18' }]);
    expect(f).toContain('v.maxValue(2147483647)');
  });
});
