/**
 * Array and structured columns in valibot output, checked by running the emitted schemas.
 *
 * Valibot has two traps that only show up when the schema is executed. `v.tuple` ignores extra
 * items, so a `point` built from it accepted `[1, 2, 3]`; `v.strictTuple` is the one that holds
 * the arity. And valibot has no `json()` built-in, so a json column used to fall through to
 * `v.any()` and accept `undefined`, bigints and Dates.
 */
import { describe, it, expect } from 'vitest';
import { ValibotGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import * as v from 'valibot';
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
  await new ValibotGenerator(analysis).generate({ outDir: dir } as never);
  const file = path.join(dir, `t-${process.pid}-${label}.ts`);
  await fs.rename(path.join(dir, 't.valibot.ts'), file);
  return await import(file);
}

const accepts = (schema: any, key: string, x: unknown) =>
  v.safeParse(schema.entries[key], x).success;

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
    expect(accepts(m.SelecttSchema, 'scores', [40000]), 'past the column width').toBe(false);
    expect(accepts(m.SelecttSchema, 'scores', [1.5]), 'a fractional element').toBe(false);
  });
});

describe('structured columns', () => {
  it('holds a point to exactly two numbers', async () => {
    // `v.tuple` would accept the third element. This is the reason for `v.strictTuple`.
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
    expect(accepts(m.SelecttSchema, 'p', [1, 2, 3]), 'a third element').toBe(false);
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
    // Stricter than `drizzle-orm/valibot`, which builds the object arm from a plain record and so
    // lets both of these through.
    expect(accepts(s, 'doc', Infinity), 'Infinity, which JSON cannot carry').toBe(false);
    expect(accepts(s, 'doc', new Date()), 'a Date, which is not a plain object').toBe(false);
  });

  it('emits the json declaration only where a json column exists', async () => {
    const dir = path.join(__dirname, '.tmp-structured');
    await fs.mkdir(dir, { recursive: true });
    const analysis = (columns: Column[]): Analysis =>
      ({
        dialect: 'postgres',
        tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks: [] }],
        enums: [],
        relations: [],
        issues: [],
      }) as never;

    await new ValibotGenerator(
      analysis([col('doc', { tsType: 'any', shape: { kind: 'json' } })])
    ).generate({ outDir: dir } as never);
    expect(await fs.readFile(path.join(dir, 't.valibot.ts'), 'utf8')).toContain('DrzlJsonValue');

    await new ValibotGenerator(analysis([col('name')])).generate({ outDir: dir } as never);
    expect(await fs.readFile(path.join(dir, 't.valibot.ts'), 'utf8')).not.toContain(
      'DrzlJsonValue'
    );
  });
});
