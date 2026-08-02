/**
 * Array and structured columns in ArkType output.
 *
 * ArkType parses its types at import, so an expression it cannot resolve throws and takes down
 * whatever imported the schema. That makes running the emitted module the only test worth
 * writing here, and it is how the worst defect in this generator was found: `'Uint8Array'` is not
 * an ArkType keyword, so every emitted module holding a binary column threw
 * `'Uint8Array' is unresolvable` on import. Asserting on the emitted text saw nothing wrong.
 */
import { describe, it, expect } from 'vitest';
import { ArkTypeGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { type } from 'arktype';
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

async function schemasFor(columns: Column[], label: string): Promise<Record<string, any>> {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks: [] }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-structured');
  await fs.mkdir(dir, { recursive: true });
  await new ArkTypeGenerator(analysis).generate({ outDir: dir } as never);
  const file = path.join(dir, `t-${process.pid}-${label}.ts`);
  await fs.rename(path.join(dir, 't.arktype.ts'), file);
  return await import(file);
}

const accepts = (schema: any, key: string, v: unknown) =>
  !(schema.get(key)(v) instanceof type.errors);

describe('binary columns', () => {
  it('produces a module that imports at all', async () => {
    // The regression guard. `'Uint8Array'` parsed as an unresolvable alias and threw here.
    const m = await schemasFor([col('data', { tsType: 'Uint8Array', dbType: 'BLOB' })], 'blob');
    expect(m.SelecttSchema).toBeDefined();
    expect(accepts(m.SelecttSchema, 'data', new Uint8Array([1, 2]))).toBe(true);
    expect(accepts(m.SelecttSchema, 'data', Buffer.from('ab')), 'a Buffer').toBe(true);
    expect(accepts(m.SelecttSchema, 'data', 'abc'), 'a string').toBe(false);
    expect(accepts(m.SelecttSchema, 'data', null), 'null on a NOT NULL column').toBe(false);
  });

  it('does the same for a bytea, which reaches it as a shape', async () => {
    const m = await schemasFor(
      [col('data', { tsType: 'Buffer', dbType: 'BYTEA', shape: { kind: 'buffer' } })],
      'bytea'
    );
    expect(accepts(m.SelecttSchema, 'data', new Uint8Array([1]))).toBe(true);
    expect(accepts(m.SelecttSchema, 'data', 5)).toBe(false);
  });
});

describe('arrays', () => {
  it('wraps the element rather than replacing it', async () => {
    const m = await schemasFor([col('tags', { arrayDimensions: 1 })], 'tags');
    expect(accepts(m.SelecttSchema, 'tags', ['a', 'b'])).toBe(true);
    expect(accepts(m.SelecttSchema, 'tags', 'a'), 'a bare string').toBe(false);
  });

  it('parenthesises an enum array, whose element is itself a union', async () => {
    // `'a' | 'b'[]` would parse as the literal 'a' or an array of 'b'. The parentheses are what
    // make it an array of either.
    const m = await schemasFor(
      [col('moods', { enumValues: ['happy', 'sad'], arrayDimensions: 1 })],
      'moods'
    );
    expect(accepts(m.SelecttSchema, 'moods', ['happy', 'sad'])).toBe(true);
    expect(accepts(m.SelecttSchema, 'moods', ['nope'])).toBe(false);
    expect(accepts(m.SelecttSchema, 'moods', 'happy'), 'a bare member').toBe(false);
  });
});

describe('structured columns', () => {
  it('holds a point to exactly two numbers', async () => {
    const m = await schemasFor(
      [
        col('p', {
          tsType: '[number, number]',
          dbType: 'POINT',
          shape: { kind: 'tuple', length: 2 },
        }),
      ],
      'point'
    );
    expect(accepts(m.SelecttSchema, 'p', [1, 2])).toBe(true);
    expect(accepts(m.SelecttSchema, 'p', [1, 2, 3])).toBe(false);
    expect(accepts(m.SelecttSchema, 'p', '(1,2)')).toBe(false);
  });

  it('holds a bit column to binary digits of the declared length', async () => {
    const m = await schemasFor(
      [col('b', { dbType: 'BIT', shape: { kind: 'bitstring', length: 3 } })],
      'bit'
    );
    expect(accepts(m.SelecttSchema, 'b', '010')).toBe(true);
    expect(accepts(m.SelecttSchema, 'b', '012')).toBe(false);
    expect(accepts(m.SelecttSchema, 'b', '0101')).toBe(false);
  });
});

describe('integer columns', () => {
  it('rejects a fraction inside its range', async () => {
    // These emitted `-32768 <= number <= 32767`, on the theory that an integer range implied
    // integrality. ArkType parses `number.integer` inside a range perfectly well.
    const m = await schemasFor(
      [
        col('n', {
          tsType: 'number',
          dbType: 'INTEGER',
          integer: true,
          min: '-32768',
          max: '32767',
        }),
      ],
      'int'
    );
    expect(accepts(m.SelecttSchema, 'n', 42)).toBe(true);
    expect(accepts(m.SelecttSchema, 'n', 1.5), 'a fraction').toBe(false);
    expect(accepts(m.SelecttSchema, 'n', 40000), 'past the column width').toBe(false);
  });

  it('leaves a float free to be fractional', async () => {
    const m = await schemasFor(
      [
        col('r', {
          tsType: 'number',
          dbType: 'REAL',
          integer: false,
          min: '-8388608',
          max: '8388607',
        }),
      ],
      'real'
    );
    expect(accepts(m.SelecttSchema, 'r', 1.5)).toBe(true);
    expect(accepts(m.SelecttSchema, 'r', 1e9), 'past the precision bound').toBe(false);
  });
});
