/**
 * The same two columns on Drizzle v1: a real `pgTable` from 1.0.0-rc.4 through the real analyzer
 * and the real zod generator, with the emitted module imported and run.
 *
 * The 0.4x half is `packages/cli/test/point-object-mode.e2e.spec.ts`. This half exists because the
 * defect was not one major's: 0.4x typed both object-mode columns `string` through a class-name
 * regex, and v1 called them tuples through its own metadata, so both majors were wrong about the
 * same column in two different ways. It reaches v1 through `drizzle-orm-v1`, an alias held as a
 * devDependency of this package alone, exactly as `mssql-cockroach-types.spec.ts` does.
 *
 * What v1 states, read off real 1.0.0-rc.4 columns rather than assumed:
 *
 *   builder                                  dataType          codec
 *   point()                                  array point       point:tuple
 *   point({ mode: 'xy' })                    object point      point
 *   line()                                   array line        line:tuple
 *   line({ mode: 'abc' })                    object line       line
 *   geometry({ type: 'point' })              array geometry    geometry(point):tuple
 *   geometry({ type: 'point', mode: 'xy' })  object geometry   geometry(point)
 *
 * So the analyzer had the answer in front of it and threw away the half of `dataType` that carried
 * it.
 *
 * GROUND TRUTH, PGlite through `drizzle-orm/pglite` 1.0.0-rc.4 on `p point, l line`:
 * `{ x: 1, y: 2 }` and `{ a: 1, b: 2, c: 3 }` insert and read back unchanged, `[1, 2]` and `'1,2'`
 * are both rendered `(undefined,undefined)` by `mapToDriverValue` and refused with
 * `invalid input syntax for type point`. The full run is in
 * `.superpowers/sdd/2026-08-03-top-100/point-object-mode-report.md`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer, type Column } from '@drzl/analyzer';
import { ZodGenerator } from '../src/index';

const DIR = path.join(__dirname, '.tmp-point-object-v1');

const SCHEMA = `
  import { pgTable, point, line, geometry, integer } from 'drizzle-orm-v1/pg-core';
  export const t = pgTable('t', {
    id: integer('id').primaryKey(),
    p_obj: point('p_obj', { mode: 'xy' }).notNull(),
    l_obj: line('l_obj', { mode: 'abc' }).notNull(),
    g_obj: geometry('g_obj', { type: 'point', mode: 'xy' }).notNull(),
    p_tuple: point('p_tuple').notNull(),
    l_tuple: line('l_tuple').notNull(),
  });
`;

let mod: Record<string, any>;
let columns: Map<string, Column>;

beforeAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
  await fs.mkdir(DIR, { recursive: true });
  const schema = path.join(DIR, 'schema.mjs');
  await fs.writeFile(schema, SCHEMA, 'utf8');
  const analysis = await new SchemaAnalyzer(path.relative(process.cwd(), schema)).analyze({});
  const table = analysis.tables[0];
  expect(table, `no table analyzed: ${JSON.stringify(analysis.issues)}`).toBeTruthy();
  columns = new Map(table.columns.map((c) => [c.name, c]));
  await new ZodGenerator(analysis).generate({ outDir: DIR } as never);
  const emitted = path.join(DIR, `t-${process.pid}.ts`);
  await fs.rename(path.join(DIR, 't.zod.ts'), emitted);
  mod = await import(emitted);
}, 120_000);

afterAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
});

const accepts = (schema: any, v: unknown) => schema.safeParse(v).success;

describe('the analyzer, over a real v1 table', () => {
  it('reads the object modes out of the dataType it was already given', () => {
    expect(columns.get('p_obj')).toMatchObject({
      dbType: 'POINT',
      shape: { kind: 'numberObject', fields: ['x', 'y'] },
    });
    expect(columns.get('l_obj')).toMatchObject({
      dbType: 'LINE',
      shape: { kind: 'numberObject', fields: ['a', 'b', 'c'] },
    });
    // geometry reaches the same arm and has the same two modes.
    expect(columns.get('g_obj')?.shape).toEqual({ kind: 'numberObject', fields: ['x', 'y'] });
  });

  it('leaves the tuple modes where they were', () => {
    expect(columns.get('p_tuple')?.shape).toEqual({ kind: 'tuple', length: 2 });
    expect(columns.get('l_tuple')?.shape).toEqual({ kind: 'tuple', length: 3 });
  });

  it('answers the same way as 0.4x does for the same two columns', () => {
    // The cross-major agreement is the point: this defect was one wrong answer per major, and a
    // fix on one side alone would have replaced it with a disagreement. The 0.4x side is asserted
    // against real 0.45.2 columns in packages/analyzer/test/floats-and-tuples-0.4x.spec.ts.
    expect(columns.get('p_obj')?.tsType).toBe('{ x: number; y: number }');
    expect(columns.get('l_obj')?.tsType).toBe('{ a: number; b: number; c: number }');
  });
});

describe('the emitted module, against what the v1 driver returned', () => {
  it('takes the objects and refuses the tuple and the string', () => {
    const p = mod.SelecttSchema.shape.p_obj;
    expect(accepts(p, { x: 1, y: 2 }), 'the row the column handed back').toBe(true);
    expect(accepts(p, [1, 2]), 'rendered (undefined,undefined) and refused').toBe(false);
    expect(accepts(p, '1,2'), 'the same').toBe(false);
    expect(accepts(p, null), 'null on a NOT NULL column').toBe(false);
    const l = mod.SelecttSchema.shape.l_obj;
    expect(accepts(l, { a: 1, b: 2, c: 3 })).toBe(true);
    expect(accepts(l, [1, 2, 3])).toBe(false);
    expect(accepts(mod.SelecttSchema.shape.g_obj, { x: 1, y: 2 })).toBe(true);
  });

  it('still takes the tuple on the tuple-mode columns', () => {
    expect(accepts(mod.SelecttSchema.shape.p_tuple, [1, 2])).toBe(true);
    expect(accepts(mod.SelecttSchema.shape.l_tuple, [1, 2, 3])).toBe(true);
    expect(accepts(mod.SelecttSchema.shape.p_tuple, { x: 1, y: 2 })).toBe(false);
  });
});
