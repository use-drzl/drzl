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
        // The object modes of the same two builders, which return `{ x, y }` and `{ a, b, c }`
        // rather than a tuple. Built from the field names for the same reason the arity is built
        // from `shape.length`: the analyzer states them and an object of numbers is ordinary
        // TypeScript.
        {
          name: 'corner',
          tsType: '{ x: number; y: number }',
          dbType: 'POINT',
          nullable: false,
          hasDefault: false,
          isGenerated: false,
          shape: { kind: 'numberObject', fields: ['x', 'y'] },
        },
        {
          name: 'axis',
          tsType: '{ a: number; b: number; c: number }',
          dbType: 'LINE',
          nullable: true,
          hasDefault: false,
          isGenerated: false,
          shape: { kind: 'numberObject', fields: ['a', 'b', 'c'] },
        },
        // Bytes, which the driver hands back as a `Uint8Array` and which this used to call
        // `unknown` while the validators beside it said what it is.
        {
          name: 'blob',
          tsType: 'Buffer',
          dbType: 'BYTEA',
          nullable: false,
          hasDefault: false,
          isGenerated: false,
          shape: { kind: 'buffer' },
        },
        // The control, and it has to be a column nothing can type rather than one that merely was
        // not typed yet: a `customType` with no `$type<T>()`, which the analyzer reports as
        // `unknown`. `blob` used to stand for this and stopped being an example of it.
        {
          name: 'opaque',
          tsType: 'unknown',
          dbType: 'UNKNOWN',
          nullable: false,
          hasDefault: false,
          isGenerated: false,
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

  it('spells a binary column as the bytes the driver hands back', async () => {
    expect(await emitted()).toContain('blob: Uint8Array');
  });

  it('leaves a column it cannot type at all as unknown', async () => {
    // The control, so this is not a blanket pass-through of whatever `tsType` happens to say.
    expect(await emitted()).toContain('opaque: unknown');
  });

  it('is an object of the named number fields for the object modes', async () => {
    const src = await emitted();
    expect(src).toContain('corner: { x: number; y: number }');
    expect(src).toContain('axis: { a: number; b: number; c: number } | null');
    expect(src).not.toContain('corner: unknown');
  });

  it('emits types that compile, which a pasted tsType need not', async () => {
    // The field type is spliced into a `.ts` file, so a shape spelled wrong is a module the
    // consumer cannot build. Compiled rather than read: `tsc` is the arbiter for TypeScript the
    // same way the server is for a column.
    const src = await emitted();
    const ts = (await import('typescript')).default;
    const out = ts.transpileModule(src, {
      reportDiagnostics: true,
      compilerOptions: { strict: true, target: ts.ScriptTarget.ES2022 },
    });
    expect(
      out.diagnostics?.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '))
    ).toEqual([]);
  });
});
