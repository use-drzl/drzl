/**
 * Row-level CHECK constraints, which belong on the object rather than on a field.
 *
 * `CHECK (start_date < end_date)` cannot be a field refinement: neither column alone can say
 * whether it holds. It was skipped for that reason, by DRZL and by every official Drizzle
 * validator module, which enforce no CHECK at all. On the object schema it is exactly
 * expressible.
 *
 * Verified against a real Postgres through PGlite: for a table with this constraint and
 * `CHECK (price <= max_price)`, the emitted schema and the database agree on all five probe rows.
 */
import { describe, it, expect } from 'vitest';
import { ZodGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';

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
  await new ZodGenerator(analysis).generate({ outDir: dir } as never);
  // Unique per call: the module cache is process-global.
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.zod.ts'), file);
  return await import(file);
}

const ROW = [{ name: 'order', expression: 'lo < hi' }];
const COLS = [col('lo'), col('hi')];

describe('a comparison between two columns', () => {
  it('is enforced on the object', async () => {
    const m = await schemasFor(COLS, ROW);
    expect(m.SelecttSchema.safeParse({ lo: 1, hi: 2 }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ lo: 2, hi: 1 }).success).toBe(false);
    expect(m.SelecttSchema.safeParse({ lo: 1, hi: 1 }), 'strict comparison').toMatchObject({
      success: false,
    });
  });

  it('reports against the left column, so the error has somewhere to land', async () => {
    const m = await schemasFor(COLS, ROW);
    const r = m.SelecttSchema.safeParse({ lo: 2, hi: 1 });
    expect(r.error.issues[0].path).toEqual(['lo']);
    expect(r.error.issues[0].message).toBe('order: lo < hi');
  });

  it('passes when either side is absent, as SQL does', async () => {
    // A comparison involving NULL yields NULL, and a CHECK passes on NULL. Without the guard, an
    // update omitting one column would be rejected by a comparison the database never applied.
    const m = await schemasFor([col('lo', { nullable: true }), col('hi', { nullable: true })], ROW);
    expect(m.SelecttSchema.safeParse({ lo: null, hi: 1 }).success).toBe(true);
    expect(m.UpdatetSchema.safeParse({ lo: 5 }), 'hi omitted on update').toMatchObject({
      success: true,
    });
  });

  it('is left out of a mode that does not carry both columns', async () => {
    // An insert schema omits generated columns. A comparison naming one would read undefined and
    // silently always pass, which is worse than not emitting it.
    const m = await schemasFor([col('lo'), col('hi', { isGenerated: true })], ROW);
    const insert = JSON.stringify(Object.keys(m.InserttSchema.shape ?? {}));
    expect(insert).not.toContain('hi');
    expect(m.InserttSchema.safeParse({ lo: 1 }).success).toBe(true);
  });

  it('does not appear when there is no row-level constraint', async () => {
    const m = await schemasFor(COLS, [{ name: 'x', expression: 'lo > 0' }]);
    expect(m.SelecttSchema.safeParse({ lo: 5, hi: 1 }), 'no row check applies').toMatchObject({
      success: true,
    });
  });
});
