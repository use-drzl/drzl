/**
 * Array and structured columns in TypeBox output, checked by running the emitted schemas.
 *
 * Same reason as everywhere else in this package: TypeBox accepts an option it does not
 * understand for a given type and then ignores it, so a schema can look right, compile, and
 * validate nothing. The bigint bounds below are the case in point. They were left off because a
 * 64 bit bound cannot be written as a JSON Schema number without rounding, which is true, but
 * `minimum` and `maximum` take bigint values here and enforce them exactly.
 */
import { describe, it, expect } from 'vitest';
import { TypeBoxGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { Value } from '@sinclair/typebox/value';
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
  await new TypeBoxGenerator(analysis).generate({ outDir: dir } as never);
  const file = path.join(dir, `t-${process.pid}-${label}.ts`);
  await fs.rename(path.join(dir, 't.typebox.ts'), file);
  return await import(file);
}

const accepts = (schema: any, key: string, x: unknown) => Value.Check(schema.properties[key], x);

describe('arrays', () => {
  it('wraps the element rather than replacing it', async () => {
    const m = await schemasFor([col('tags', { arrayDimensions: 1 })], 'tags');
    expect(accepts(m.SelecttSchema, 'tags', ['a', 'b'])).toBe(true);
    expect(accepts(m.SelecttSchema, 'tags', 'a'), 'a bare string').toBe(false);
  });

  it('keeps the element constraints inside the array', async () => {
    const m = await schemasFor(
      [
        col('scores', {
          tsType: 'number',
          dbType: 'INTEGER',
          integer: true,
          min: '-32768',
          max: '32767',
          arrayDimensions: 1,
        }),
      ],
      'scores'
    );
    expect(accepts(m.SelecttSchema, 'scores', [1, 2])).toBe(true);
    expect(accepts(m.SelecttSchema, 'scores', [40000])).toBe(false);
    expect(accepts(m.SelecttSchema, 'scores', [1.5])).toBe(false);
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

  it('holds a vector to its declared width', async () => {
    const m = await schemasFor(
      [
        col('vec', {
          tsType: 'number[]',
          dbType: 'VECTOR',
          shape: { kind: 'numberVector', length: 3 },
        }),
      ],
      'vector'
    );
    expect(accepts(m.SelecttSchema, 'vec', [1, 2, 3])).toBe(true);
    expect(accepts(m.SelecttSchema, 'vec', [1, 2])).toBe(false);
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

  it('rejects null on a NOT NULL binary column', async () => {
    const m = await schemasFor(
      [col('data', { tsType: 'Buffer', dbType: 'BYTEA', shape: { kind: 'buffer' } })],
      'bytea'
    );
    expect(accepts(m.SelecttSchema, 'data', new Uint8Array([1]))).toBe(true);
    expect(accepts(m.SelecttSchema, 'data', null)).toBe(false);
  });

  it('holds a json column to values that survive a round trip', async () => {
    const m = await schemasFor(
      [col('doc', { tsType: 'any', dbType: 'JSONB', shape: { kind: 'json' } })],
      'json'
    );
    const s = m.SelecttSchema;
    expect(accepts(s, 'doc', { a: [1, 'x', null] }), 'a nested json value').toBe(true);
    expect(accepts(s, 'doc', undefined)).toBe(false);
    expect(accepts(s, 'doc', NaN)).toBe(false);
    expect(accepts(s, 'doc', 1n)).toBe(false);
    expect(accepts(s, 'doc', new Date())).toBe(false);
  });
});

describe('bigint bounds', () => {
  it('enforces a 64 bit range exactly', async () => {
    // The literals are emitted with the `n` suffix. Written as plain numbers,
    // 9223372036854775807 rounds up the moment it becomes one and the bound would be wrong.
    const m = await schemasFor(
      [
        col('big', {
          tsType: 'bigint',
          dbType: 'BIGINT',
          min: '-9223372036854775808',
          max: '9223372036854775807',
        }),
      ],
      'bigint'
    );
    expect(accepts(m.SelecttSchema, 'big', 1n)).toBe(true);
    expect(accepts(m.SelecttSchema, 'big', 9223372036854775807n), 'the exact maximum').toBe(true);
    expect(accepts(m.SelecttSchema, 'big', 2n ** 70n), 'past the column width').toBe(false);
  });
});
