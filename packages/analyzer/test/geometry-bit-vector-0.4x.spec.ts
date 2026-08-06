/**
 * The last of the pgvector-shaped gaps on drizzle-orm 0.4x, found by the analyzer fuzzer.
 *
 * `bit`, `geometry` in both its modes, and SingleStore's `vector` all came back `unknown` or `any`
 * on the class-name path, so their validators accepted anything. v1 answers all four correctly from
 * its codec, so this is the two majors agreeing again rather than a new opinion, and the expected
 * values below are v1's own:
 *
 *   bit(3)                 string                    bitstring, length 3, exact
 *   geometry()             [number, number]          tuple, length 2
 *   geometry({mode:'xy'})  { x: number; y: number }  numberObject, fields x and y
 *   ss vector(3)           number[]                  numberVector, length 3
 *
 * Checked against drizzle's own mappers rather than inferred from the names, because two of them
 * are not what a name suggests. `bit` is a **string** of ones and zeros, not a number or a byte
 * array: `mapFromDriverValue` hands back `"101"`. And `geometry` is a tuple by default and an
 * object only in `xy` mode, which are different classes, `PgGeometry` and `PgGeometryObject`.
 *
 * `exact` on the bitstring is the difference between a Postgres `bit(3)`, which holds exactly three
 * digits, and a MySQL `binary(4)`, which holds at most four. Both are byte-ish strings with a
 * declared width and only one of them accepts a short value.
 */
import { describe, it, expect } from 'vitest';
import { SchemaAnalyzer } from '../src/index';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

async function analysed(source: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-geo-'));
  const file = path.join(dir, 'schema.mjs');
  await fs.writeFile(file, source, 'utf8');
  const res = await new SchemaAnalyzer(file).analyze();
  return {
    byName: new Map(res.tables[0].columns.map((c) => [c.name, c])),
    issues: res.issues,
  };
}

const PG = `
import { pgTable, bit, geometry } from 'drizzle-orm/pg-core';
export const t = pgTable('t', {
  b: bit('b', { dimensions: 3 }),
  g: geometry('g'),
  gx: geometry('gx', { mode: 'xy' }),
});
`;

const SINGLESTORE = `
import { singlestoreTable, vector } from 'drizzle-orm/singlestore-core';
export const t = singlestoreTable('t', { v: vector('v', { dimensions: 3, elementType: 'F32' }) });
`;

describe('the Postgres classes the 0.4x path could not name', () => {
  it('describes a bit column as the string of digits the driver returns', async () => {
    const { byName } = await analysed(PG);
    expect(byName.get('b')?.tsType).toBe('string');
    expect(byName.get('b')?.shape).toEqual({ kind: 'bitstring', length: 3, exact: true });
  });

  it('describes a default geometry as a two-number tuple', async () => {
    const { byName } = await analysed(PG);
    expect(byName.get('g')?.tsType).toBe('[number, number]');
    expect(byName.get('g')?.shape).toEqual({ kind: 'tuple', length: 2 });
  });

  it('describes an xy geometry as an object, which is a different class', async () => {
    const { byName } = await analysed(PG);
    expect(byName.get('gx')?.shape).toEqual({ kind: 'numberObject', fields: ['x', 'y'] });
  });

  it('raises no untyped-column warning for any of the three', async () => {
    const { issues } = await analysed(PG);
    const warned = issues
      .filter((i) => i.code === 'DRZL_ANL_UNKNOWN_COLUMN')
      .map((i) => i.message.match(/"(\w+)"/)?.[1]);
    expect(warned).toEqual([]);
  });
});

describe("SingleStore's vector", () => {
  it('is the number array the driver returns, not `any`', async () => {
    const { byName } = await analysed(SINGLESTORE);
    expect(byName.get('v')?.tsType).toBe('number[]');
    expect(byName.get('v')?.shape).toEqual({ kind: 'numberVector', length: 3 });
  });
});
