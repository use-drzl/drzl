/**
 * The pgvector family, which the analyzer fuzzer found unnamed in every spelling.
 *
 * `vector`, `halfvec` and `sparsevec` all came back `unknown` on drizzle-orm 0.4x, so their
 * validators accepted anything, and `halfvec` came back `unknown` on v1 as well. This was the one
 * real cluster in the fuzzer's first correct run; everything else it reported was already filed,
 * deliberate, or an artefact of building a combination nobody writes.
 *
 * The answers are taken from drizzle's own mappers rather than from the type names, because a
 * vector column is not one shape:
 *
 *   vector(3)     SELECT gives [1,2,3]          INSERT sends "[1,2,3]"
 *   halfvec(3)    SELECT gives [1,2,3]          INSERT sends "[1,2,3]"
 *   sparsevec(3)  SELECT gives "{1:1.5,3:2}/3"  INSERT sends "{1:1.5,3:2}/3"
 *
 * So the two dense ones are number arrays and the sparse one is a string, and calling all three
 * "a vector" would have got one of them wrong. `sparsevec` on v1 already answered `string` from its
 * codec, which is the same conclusion reached independently.
 */
import { describe, it, expect } from 'vitest';
import { SchemaAnalyzer } from '../src/index';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SOURCE = `
import { pgTable, vector, halfvec, sparsevec } from 'drizzle-orm/pg-core';
export const t = pgTable('t', {
  v: vector('v', { dimensions: 3 }),
  h: halfvec('h', { dimensions: 3 }),
  s: sparsevec('s', { dimensions: 3 }),
});
`;

async function columns() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-vec-'));
  const file = path.join(dir, 'schema.mjs');
  await fs.writeFile(file, SOURCE, 'utf8');
  const res = await new SchemaAnalyzer(file).analyze();
  return {
    byName: new Map(res.tables[0].columns.map((c) => [c.name, c])),
    issues: res.issues,
  };
}

describe('the pgvector family', () => {
  it('describes a dense vector as the number array the driver returns', async () => {
    const { byName } = await columns();
    expect(byName.get('v')?.tsType).toBe('number[]');
    expect(byName.get('v')?.shape).toEqual({ kind: 'numberVector', length: 3 });
  });

  it('describes a half-precision vector the same way, since the driver does', async () => {
    // `halfvec` differs from `vector` in storage width and in nothing a validator can see:
    // `mapFromDriverValue` on both hands back `[1, 2, 3]`. It was `unknown` on both majors.
    const { byName } = await columns();
    expect(byName.get('h')?.tsType).toBe('number[]');
    expect(byName.get('h')?.shape).toEqual({ kind: 'numberVector', length: 3 });
  });

  it('describes a sparse vector as the string the driver returns, not as a vector', async () => {
    // The name says vector and the value is a string: `{1:1.5,3:2}/3`. Typing it `number[]` for
    // symmetry would reject every row the database returns, which is the defect this family was
    // filed under in the first place.
    const { byName } = await columns();
    expect(byName.get('s')?.tsType).toBe('string');
    expect(byName.get('s')?.shape?.kind).not.toBe('numberVector');
  });

  it('raises no untyped-column warning for any of the three', async () => {
    const { issues } = await columns();
    const warned = issues
      .filter((i) => i.code === 'DRZL_ANL_UNKNOWN_COLUMN')
      .map((i) => i.message.match(/"(\w+)"/)?.[1]);
    expect(warned).toEqual([]);
  });
});
