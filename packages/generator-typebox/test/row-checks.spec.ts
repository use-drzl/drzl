/**
 * Row-level CHECK constraints in the TypeBox generator.
 *
 * `CHECK (start_date < end_date)` is a statement about the row, so it cannot be a field
 * constraint. TypeBox has no `.refine`, but it does have a type registry: a custom kind holds a
 * predicate, and intersecting it with the object applies it after the properties are checked.
 *
 * The intersection is load bearing. Setting the kind on the object itself parses, and silently
 * stops checking the properties: `{ lo: 'x' }` passes. That is the failure this file exists to
 * pin down, so both the row check and an ordinary type error are asserted on every schema here.
 *
 * Both sides are guarded for null first, reproducing SQL, where a comparison involving NULL
 * yields NULL and the CHECK passes.
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
    tsType: 'number',
    dbType: 'INTEGER',
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
  const dir = path.join(__dirname, '.tmp-rowchecks');
  await fs.mkdir(dir, { recursive: true });
  await new TypeBoxGenerator(analysis).generate({ outDir: dir } as never);
  // Unique per call: the module cache is process-global.
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.typebox.ts'), file);
  return await import(file);
}

const ROW = [{ name: 'order', expression: 'lo < hi' }];
const COLS = [col('lo'), col('hi')];

describe('a comparison between two columns', () => {
  it('is enforced on the object', async () => {
    const m = await schemasFor(COLS, ROW);
    expect(Value.Check(m.SelecttSchema, { lo: 1, hi: 2 })).toBe(true);
    expect(Value.Check(m.SelecttSchema, { lo: 2, hi: 1 })).toBe(false);
    expect(Value.Check(m.SelecttSchema, { lo: 1, hi: 1 }), 'strict comparison').toBe(false);
  });

  it('still checks the property types, which setting the kind directly would not', async () => {
    const m = await schemasFor(COLS, ROW);
    expect(Value.Check(m.SelecttSchema, { lo: 'x', hi: 'y' })).toBe(false);
    expect(Value.Check(m.SelecttSchema, { lo: 1 }), 'hi is required on select').toBe(false);
  });

  it('holds under the compiler, not only the dynamic checker', async () => {
    // TypeCompiler is why most people reach for TypeBox. A predicate it cannot compile would be
    // a schema that behaves one way in tests and another in production.
    const m = await schemasFor(COLS, ROW);
    const c = TypeCompiler.Compile(m.SelecttSchema);
    expect(c.Check({ lo: 1, hi: 2 })).toBe(true);
    expect(c.Check({ lo: 2, hi: 1 })).toBe(false);
    expect(c.Check({ lo: 'x', hi: 'y' })).toBe(false);
  });

  it('passes when either side is absent, as SQL does', async () => {
    const m = await schemasFor([col('lo', { nullable: true }), col('hi', { nullable: true })], ROW);
    expect(Value.Check(m.SelecttSchema, { lo: null, hi: 1 })).toBe(true);
    expect(Value.Check(m.UpdatetSchema, { lo: 5 }), 'hi omitted on update').toBe(true);
  });

  it('is left out of a mode that does not carry both columns', async () => {
    // An insert schema omits generated columns. A comparison naming one would read undefined and
    // silently always pass, which is worse than not emitting it.
    const m = await schemasFor([col('lo'), col('hi', { isGenerated: true })], ROW);
    expect(Value.Check(m.InserttSchema, { lo: 1 })).toBe(true);
  });

  it('does not appear when there is no row-level constraint', async () => {
    const m = await schemasFor(COLS, [{ name: 'x', expression: 'lo > 0' }]);
    expect(Value.Check(m.SelecttSchema, { lo: 5, hi: 1 }), 'no row check applies').toBe(true);
  });

  it('serialises to a JSON Schema that is still valid, having dropped the predicate', async () => {
    // A function cannot survive JSON.stringify, and JSON Schema cannot express a comparison
    // between two fields at all. The branch carries no keywords, so it serialises to a schema
    // that accepts everything: the document stays correct and merely says less than the runtime
    // does. What it keeps is the description, so a reader of the JSON still learns the rule.
    const m = await schemasFor(COLS, ROW);
    const json = JSON.parse(JSON.stringify(m.SelecttSchema));
    expect(json.allOf?.[0]?.properties?.lo?.type).toBe('integer');
    expect(Object.keys(json.allOf?.[1] ?? {})).toEqual(['description']);
    expect(json.allOf[1].description).toBe('order: lo < hi');
  });
});
