/**
 * `CHECK (cardinality(tags) >= 2)` in TypeBox output.
 *
 * TypeBox states an array length with `minItems` and `maxItems`, which are the JSON Schema
 * keywords for it, so the constraint survives serialisation rather than living in a predicate.
 *
 * JSON Schema has no exclusive form of either, but a length is an integer, so `> 2` is exactly
 * `minItems: 3`. Nothing is approximated by that rewrite.
 */
import { describe, it, expect } from 'vitest';
import { TypeBoxGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Value } from '@sinclair/typebox/value';

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

let seq = 0;

async function schemaFor(c: Column, checks: { name?: string; expression?: string }[]) {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns: [c], unique: [], indexes: [], checks }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-card');
  await fs.mkdir(dir, { recursive: true });
  await new TypeBoxGenerator(analysis).generate({ outDir: dir } as never);
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.typebox.ts'), file);
  const m = await import(file);
  return m.SelecttSchema;
}

/** Lengths accepted, so the assertion is about behaviour rather than which keyword was chosen. */
const accepts = (schema: any, lengths: number[]) =>
  lengths.filter((n) =>
    Value.Check(schema, { tags: Array.from({ length: n }, () => 'x') })
  );

describe('a cardinality check', () => {
  it('becomes minItems', async () => {
    const s = await schemaFor(arr(), [{ name: 'min2', expression: 'cardinality(tags) >= 2' }]);
    expect(accepts(s, [0, 1, 2, 3])).toEqual([2, 3]);
  });

  it('turns an exclusive lower bound into the next integer, losing nothing', async () => {
    const s = await schemaFor(arr(), [{ expression: 'cardinality(tags) > 2' }]);
    expect(accepts(s, [0, 1, 2, 3])).toEqual([3]);
  });

  it('becomes maxItems', async () => {
    const s = await schemaFor(arr(), [{ expression: 'cardinality(tags) <= 2' }]);
    expect(accepts(s, [0, 1, 2, 3])).toEqual([0, 1, 2]);
  });

  it('states both ends when both are given', async () => {
    const s = await schemaFor(arr(), [
      { expression: 'cardinality(tags) >= 1' },
      { expression: 'cardinality(tags) <= 3' },
    ]);
    expect(accepts(s, [0, 1, 2, 3, 4])).toEqual([1, 2, 3]);
  });

  it('becomes an exact length for an equality', async () => {
    const s = await schemaFor(arr(), [{ expression: 'cardinality(tags) = 2' }]);
    expect(accepts(s, [0, 1, 2, 3])).toEqual([2]);
  });

  it('keeps the constraint in the serialised JSON Schema', async () => {
    // The reason for preferring keywords over a predicate: this one survives the round trip.
    const s = await schemaFor(arr(), [{ expression: 'cardinality(tags) >= 2' }]);
    const json = JSON.parse(JSON.stringify(s));
    expect(json.properties.tags.minItems).toBe(2);
  });

  it('is left off a column that is not an array', async () => {
    const s = await schemaFor(arr({ arrayDimensions: undefined, tsType: 'string' }), [
      { expression: 'cardinality(tags) >= 2' },
    ]);
    expect(Value.Check(s, { tags: 'x' })).toBe(true);
  });
});
