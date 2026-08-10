/**
 * `CHECK (col <> 'banned')` in the TypeBox generator.
 *
 * This constraint used to be emitted as a bare `Type.String()`, so a CHECK the shared parser read
 * and three other generators enforced was enforced by nothing here. TypeBox can state it
 * declaratively, so it does: `Type.Not(Type.Literal(x))` intersected with the base.
 *
 * The intersect is load bearing and is asserted as such. `Type.Not` on its own accepts a value of
 * any other type, so the column would stop being a string while looking constrained.
 *
 * Both paths are checked on every case. The compiled path is the one people choose TypeBox for,
 * and a constraint that only the interpreter applies would be a hole in exactly the place the
 * library is used.
 */
import { describe, it, expect } from 'vitest';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TypeBoxGenerator } from '../src/index';
import { Value } from '@sinclair/typebox/value';
import { TypeCompiler } from '@sinclair/typebox/compiler';

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

async function schemasFor(
  columns: Column[],
  checks: { name?: string; expression?: string }[]
): Promise<Record<string, any>> {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-inequality');
  await fs.mkdir(dir, { recursive: true });
  await new TypeBoxGenerator(analysis).generate({ outDir: dir } as never);
  // Unique per call: the module cache is process-global.
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.typebox.ts'), file);
  return await import(file);
}

/** Both paths, always: a value the interpreter refuses and the compiler admits is a hole. */
const both = (schema: any, input: unknown): { value: boolean; compiled: boolean } => ({
  value: Value.Check(schema, input),
  compiled: TypeCompiler.Compile(schema).Check(input),
});

describe('a string inequality', () => {
  it('refuses the excluded value and accepts every other string, on both paths', async () => {
    const m = await schemasFor(
      [col('tier')],
      [{ name: 'tier_not_banned', expression: "tier <> 'banned'" }]
    );
    expect(both(m.SelecttSchema, { tier: 'gold' })).toEqual({ value: true, compiled: true });
    expect(both(m.SelecttSchema, { tier: 'banned' })).toEqual({ value: false, compiled: false });
  });

  it('keeps the type check, which is what the intersect is for', async () => {
    // `Type.Not(Type.Literal('banned'))` alone accepts 7. If the intersect were dropped the
    // column would take any value that is not the excluded one, of any type at all.
    const m = await schemasFor(
      [col('tier')],
      [{ name: 'tier_not_banned', expression: "tier <> 'banned'" }]
    );
    expect(both(m.SelecttSchema, { tier: 7 })).toEqual({ value: false, compiled: false });
  });

  it('applies on every mode, because the database applies it on every write', async () => {
    const m = await schemasFor(
      [col('tier')],
      [{ name: 'tier_not_banned', expression: "tier <> 'banned'" }]
    );
    for (const s of ['SelecttSchema', 'InserttSchema', 'UpdatetSchema']) {
      expect(Value.Check(m[s], { tier: 'banned' }), s).toBe(false);
    }
  });

  it('passes null, because SQL never applied the comparison', async () => {
    const m = await schemasFor(
      [col('tier', { nullable: true })],
      [{ name: 'tier_not_banned', expression: "tier <> 'banned'" }]
    );
    expect(both(m.SelecttSchema, { tier: null })).toEqual({ value: true, compiled: true });
    expect(both(m.SelecttSchema, { tier: 'banned' })).toEqual({ value: false, compiled: false });
  });
});

describe('a number inequality', () => {
  it('refuses the excluded number and keeps the type check', async () => {
    const m = await schemasFor(
      [col('lucky', { tsType: 'number', dbType: 'INTEGER' })],
      [{ name: 'lucky_not_7', expression: 'lucky <> 7' }]
    );
    expect(both(m.SelecttSchema, { lucky: 6 })).toEqual({ value: true, compiled: true });
    expect(both(m.SelecttSchema, { lucky: 7 })).toEqual({ value: false, compiled: false });
    expect(both(m.SelecttSchema, { lucky: 'seven' })).toEqual({ value: false, compiled: false });
  });

  it('coexists with a range on the same column', async () => {
    const m = await schemasFor(
      [col('lucky', { tsType: 'number', dbType: 'INTEGER' })],
      [
        { name: 'lucky_adult', expression: 'lucky >= 5' },
        { name: 'lucky_not_7', expression: 'lucky <> 7' },
      ]
    );
    expect(Value.Check(m.SelecttSchema, { lucky: 6 })).toBe(true);
    expect(Value.Check(m.SelecttSchema, { lucky: 7 })).toBe(false);
    expect(Value.Check(m.SelecttSchema, { lucky: 4 })).toBe(false);
  });
});

describe('what it does not touch', () => {
  it('leaves an array column alone, since a scalar comparison describes an element', async () => {
    const m = await schemasFor(
      [col('tags', { arrayDimensions: 1 } as Partial<Column>)],
      [{ name: 'tags_not_banned', expression: "tags <> 'banned'" }]
    );
    expect(Value.Check(m.SelecttSchema, { tags: ['banned'] })).toBe(true);
  });

  it('leaves a column with no inequality exactly as it was', async () => {
    const m = await schemasFor([col('tier')], [{ name: 'tier_is_a', expression: "tier = 'A'" }]);
    expect(Value.Check(m.SelecttSchema, { tier: 'A' })).toBe(true);
    expect(Value.Check(m.SelecttSchema, { tier: 'B' })).toBe(false);
  });
});
