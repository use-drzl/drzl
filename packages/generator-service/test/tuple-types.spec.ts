/**
 * A `point` or `line` column in the generated service types.
 *
 * `tsTypeOf` maps a column through an allowlist of scalar names and everything else falls to
 * `unknown`. On drizzle-orm 0.4x this was invisible while the analyzer typed a `point` as
 * `string`: the field was wrong, but it was wrong in a way that looked like a type. Once the
 * analyzer described those columns as tuples the same field became `unknown`, which is honest and
 * says nothing, and the validation generators for the same column were emitting a two-number
 * tuple. Review caught the gap.
 *
 * Built from `shape.length` rather than pasted from `tsType`. The analyzer states the arity, and a
 * tuple of numbers is ordinary TypeScript, so there is nothing to guess.
 */
import { describe, it, expect } from 'vitest';
import { ServiceGenerator } from '../src';
import type { Analysis } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const analysis: Analysis = {
  dialect: 'postgres',
  tables: [
    {
      name: 'places',
      tsName: 'places',
      columns: [
        {
          name: 'id',
          tsType: 'number',
          dbType: 'INTEGER',
          nullable: false,
          hasDefault: true,
          isGenerated: true,
        },
        {
          name: 'at',
          tsType: '[number, number]',
          dbType: 'POINT',
          nullable: false,
          hasDefault: false,
          isGenerated: false,
          shape: { kind: 'tuple', length: 2 },
        },
        {
          name: 'edge',
          tsType: '[number, number, number]',
          dbType: 'LINE',
          nullable: true,
          hasDefault: false,
          isGenerated: false,
          shape: { kind: 'tuple', length: 3 },
        },
        // The control. A column with no shape still falls to `unknown`, so this is not a blanket
        // pass-through of whatever `tsType` happens to say.
        {
          name: 'blob',
          tsType: 'Buffer',
          dbType: 'BYTEA',
          nullable: false,
          hasDefault: false,
          isGenerated: false,
          shape: { kind: 'buffer' },
        },
      ],
      primaryKey: { columns: ['id'] },
      unique: [],
      indexes: [],
    },
  ] as never,
  enums: [],
  relations: [],
  issues: [],
} as Analysis;

async function emitted(): Promise<string> {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-svc-tuple-'));
  await new ServiceGenerator(analysis).generate({ outDir } as never);
  return fs.readFile(path.join(outDir, 'types', 'places.ts'), 'utf8');
}

describe('a tuple column in the generated types', () => {
  it('is a tuple of the declared arity, not unknown', async () => {
    const src = await emitted();
    expect(src).toContain('at: [number, number]');
    expect(src).toContain('edge: [number, number, number] | null');
    expect(src).not.toContain('at: unknown');
  });

  it('leaves a shape it cannot spell as unknown', async () => {
    expect(await emitted()).toContain('blob: unknown');
  });
});
