/**
 * `CHECK (cardinality(tags) > 0)`, the array analogue of a length constraint.
 *
 * Free of the encoding question a character count carries: an element count is the same number in
 * SQL and in JavaScript. Verified against Postgres, where the constraint rejects `[]` and accepts
 * `['a']`.
 *
 * Array columns skip the ordinary check refinements, because a comparison against a scalar
 * literal says nothing usable about an array. A cardinality check is the exception: it is *about*
 * the array, so it is the one that belongs there.
 */
import { describe, it, expect } from 'vitest';
import { ZodGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const col = (name: string, over: Partial<Column> = {}): Column =>
  ({
    name,
    tsType: 'string',
    dbType: 'TEXT',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

let seq = 0;

async function withCheck(expression: string, columns: Column[]) {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [
      {
        name: 't',
        tsName: 't',
        columns,
        unique: [],
        indexes: [],
        checks: [{ name: 'tags_rule', expression }],
      },
    ] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-cardinality');
  await fs.mkdir(dir, { recursive: true });
  await new ZodGenerator(analysis).generate({ outDir: dir } as never);
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.zod.ts'), file);
  return await import(file);
}

const TAGS = [col('tags', { arrayDimensions: 1 })];

describe('a cardinality constraint', () => {
  it('rejects an array shorter than the bound', async () => {
    const m = await withCheck('cardinality(tags) > 0', TAGS);
    const f = m.SelecttSchema.shape.tags;
    expect(f.safeParse([]).success, 'empty').toBe(false);
    expect(f.safeParse(['a']).success, 'one element').toBe(true);
  });

  it('holds both ends of a range', async () => {
    const m = await withCheck('cardinality(tags) > 0 AND cardinality(tags) < 3', TAGS);
    const f = m.SelecttSchema.shape.tags;
    expect(f.safeParse([]).success).toBe(false);
    expect(f.safeParse(['a', 'b']).success).toBe(true);
    expect(f.safeParse(['a', 'b', 'c']).success).toBe(false);
  });

  it('keeps the element schema intact', async () => {
    // The constraint is about the array; each element is still validated as itself.
    const m = await withCheck('cardinality(tags) > 0', [
      col('tags', { arrayDimensions: 1, maxLength: 3 }),
    ]);
    const f = m.SelecttSchema.shape.tags;
    expect(f.safeParse(['ab']).success, 'a short element').toBe(true);
    expect(f.safeParse(['toolong']).success, 'an element past its own limit').toBe(false);
  });

  it('names the constraint in the message', async () => {
    const m = await withCheck('cardinality(tags) > 0', TAGS);
    const r = m.SelecttSchema.safeParse({ tags: [] });
    expect(r.error.issues[0].message).toBe('tags_rule: cardinality(tags) > 0');
  });

  it('is left off a column that is not an array', async () => {
    // Nothing to count. Emitting it would compare `.length` of a string, which is a different
    // constraint entirely.
    const m = await withCheck('cardinality(tags) > 0', [col('tags')]);
    expect(m.SelecttSchema.shape.tags.safeParse('').success).toBe(true);
  });
});
