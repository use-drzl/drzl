/**
 * Row-level CHECK constraints in the valibot generator.
 *
 * `CHECK (start_date < end_date)` is a statement about the row: neither column alone can say
 * whether it holds, so it cannot be a field constraint. It goes on the object.
 *
 * Both sides are guarded for null first, reproducing SQL, where a comparison involving NULL
 * yields NULL and a CHECK passes on NULL. Without the guard an update omitting one column would
 * be rejected by a comparison the database never applied.
 */
import { describe, it, expect } from 'vitest';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ValibotGenerator } from '../src/index';
import * as v from 'valibot';

const GEN = ValibotGenerator;
const SUFFIX = '.valibot.ts';
const RUN = (schema: any, input: unknown) => v.safeParse(schema, input).success;

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
  await new GEN(analysis).generate({ outDir: dir } as never);
  // Unique per call: the module cache is process-global.
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, `t${SUFFIX}`), file);
  return await import(file);
}

const ROW = [{ name: 'order', expression: 'lo < hi' }];
const COLS = [col('lo'), col('hi')];

describe('a comparison between two columns', () => {
  it('is enforced on the object', async () => {
    const m = await schemasFor(COLS, ROW);
    expect(RUN(m.SelecttSchema, { lo: 1, hi: 2 })).toBe(true);
    expect(RUN(m.SelecttSchema, { lo: 2, hi: 1 })).toBe(false);
    expect(RUN(m.SelecttSchema, { lo: 1, hi: 1 }), 'strict comparison').toBe(false);
  });

  it('passes when either side is absent, as SQL does', async () => {
    const m = await schemasFor([col('lo', { nullable: true }), col('hi', { nullable: true })], ROW);
    expect(RUN(m.SelecttSchema, { lo: null, hi: 1 })).toBe(true);
    expect(RUN(m.UpdatetSchema, { lo: 5 }), 'hi omitted on update').toBe(true);
  });

  it('is left out of a mode that does not carry both columns', async () => {
    // An insert schema omits generated columns. A comparison naming one would read undefined and
    // silently always pass, which is worse than not emitting it.
    const m = await schemasFor([col('lo'), col('hi', { isGenerated: true })], ROW);
    expect(RUN(m.InserttSchema, { lo: 1 })).toBe(true);
  });

  it('does not appear when there is no row-level constraint', async () => {
    const m = await schemasFor(COLS, [{ name: 'x', expression: 'lo > 0' }]);
    expect(RUN(m.SelecttSchema, { lo: 5, hi: 1 }), 'no row check applies').toBe(true);
  });
});
