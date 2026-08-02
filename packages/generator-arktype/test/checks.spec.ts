/**
 * CHECK constraints in ArkType output.
 *
 * ArkType states constraints inside its type expression rather than by chaining, so a check
 * folds into the range instead of becoming a separate assertion. That is not a workaround, it
 * is the better result: `18 <= number.integer <= 32767` is one statement about the type rather
 * than a bound plus an opaque predicate.
 *
 * The `.integer` is load bearing. These expectations previously read `18 <= number <= 32767`, on
 * the theory that an integer range implied integrality; it does not, and every `integer()` column
 * accepted `1.5` until ArkType was asked directly and turned out to parse both at once.
 *
 * Every emitted form is executed against arktype itself below. An expression it cannot parse
 * throws at import, which would take down whatever imported the schema, so "it looks right" is
 * not sufficient here.
 */
import { describe, it, expect } from 'vitest';
import { ArkTypeGenerator } from '../src/index';
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
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-atc-'));
  await new ArkTypeGenerator(analysis).generate({ outDir } as never);
  return fs.readFile(path.join(outDir, 't.arktype.ts'), 'utf8');
}

/** The type string emitted for one field of the select schema. */
async function typeOf(
  c: Column,
  checks: { name?: string; expression?: string }[]
): Promise<string> {
  const src = await emit([c], checks);
  const block = src.match(/SelecttSchema = type\(\{([\s\S]*?)\n\}\)/)?.[1] ?? src;
  // Prettier drops the quotes around a key that is a valid identifier, so both forms occur.
  const line = block.split('\n').find((l) => new RegExp(`^\\s*"?${c.name}"?:`).test(l));
  expect(line, `no field ${c.name} in:\n${src}`).toBeTruthy();
  return JSON.parse(
    line!
      .trim()
      .replace(/^"?[A-Za-z0-9_]+"?:\s*/, '')
      .replace(/,$/, '')
  );
}

describe('folding a check into the range', () => {
  it('tightens the lower bound', async () => {
    const t = await typeOf(col('age', { min: '-32768', max: '32767' }), [
      { name: 'adult', expression: 'age >= 18' },
    ]);
    expect(t).toBe('18 <= number.integer <= 32767');
  });

  it('tightens the upper bound', async () => {
    const t = await typeOf(col('pct', { min: '-32768', max: '32767' }), [
      { expression: 'pct <= 100' },
    ]);
    expect(t).toBe('-32768 <= number.integer <= 100');
  });

  it('turns BETWEEN into both bounds', async () => {
    const t = await typeOf(col('score', { min: '-32768', max: '32767' }), [
      { expression: 'score BETWEEN 0 AND 100' },
    ]);
    expect(t).toBe('0 <= number.integer <= 100');
  });

  it('keeps an exclusive comparison exclusive', async () => {
    const t = await typeOf(col('n', { min: '-32768', max: '32767' }), [{ expression: 'n > 0' }]);
    expect(t).toBe('0 < number.integer <= 32767');
  });

  it('pins an equality to a literal', async () => {
    const t = await typeOf(col('tier', { tsType: 'string', dbType: 'TEXT' }), [
      { expression: "tier = 'gold'" },
    ]);
    expect(t).toBe("'gold'");
  });
});

describe('what it leaves alone', () => {
  it('ignores a check naming a different column', async () => {
    const t = await typeOf(col('age', { min: '-32768', max: '32767' }), [
      { expression: 'other >= 18' },
    ]);
    expect(t).toBe('-32768 <= number.integer <= 32767');
  });

  it('ignores a cross-column comparison, which is about the row', async () => {
    const t = await typeOf(col('age', { min: '-32768', max: '32767' }), [
      { expression: 'age > score' },
    ]);
    expect(t).toBe('-32768 <= number.integer <= 32767');
  });
});

describe('the emitted expressions are ones arktype accepts', () => {
  it('parses and enforces every form, run against arktype', async () => {
    const src = await emit(
      [
        col('age', { min: '-32768', max: '32767' }),
        col('score', { min: '-32768', max: '32767', nullable: true }),
        col('tier', { tsType: 'string', dbType: 'TEXT' }),
      ],
      [
        { name: 'adult', expression: 'age >= 18' },
        { expression: 'score BETWEEN 0 AND 100' },
        { expression: "tier = 'gold'" },
      ]
    );

    // Pull the select shape out of the emitted source and hand it to arktype directly, so a
    // form it cannot parse fails here rather than in a consumer's process. Built line by line
    // rather than with JSON.parse, because prettier unquotes keys that are valid identifiers.
    const body = src.match(/SelecttSchema = type\(\{([\s\S]*?)\n\}\)/)![1];
    const shape: Record<string, string> = {};
    for (const line of body.split('\n')) {
      const m = line.match(/^\s*"?([A-Za-z0-9_?]+)"?:\s*("(?:[^"\\]|\\.)*")\s*,?\s*$/);
      if (m) shape[m[1]] = JSON.parse(m[2]);
    }
    expect(Object.keys(shape), `parsed nothing from:\n${body}`).toHaveLength(3);
    const { type } = await import('arktype');
    const T = type(shape as never);
    const isErr = (r: unknown) =>
      (r as { constructor?: { name?: string } })?.constructor?.name?.includes('Errors');

    expect(isErr(T({ age: 30, score: 50, tier: 'gold' })), 'valid row').toBe(false);
    expect(isErr(T({ age: 5, score: 50, tier: 'gold' })), 'age below check').toBe(true);
    expect(isErr(T({ age: 30, score: 101, tier: 'gold' })), 'score above range').toBe(true);
    // A CHECK passes on NULL, and the column is nullable, so null has to be accepted.
    expect(isErr(T({ age: 30, score: null, tier: 'gold' })), 'null score').toBe(false);
    expect(isErr(T({ age: 30, score: 50, tier: 'silver' })), 'wrong tier').toBe(true);
  });
});
