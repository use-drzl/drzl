/**
 * `CHECK (length(name) >= 3)` in ArkType output.
 *
 * It was dropped entirely: the parser read it, the zod and valibot generators applied it, and
 * ArkType emitted a bare `string`. A constraint the database enforces and the validator does not
 * is the failure this project exists to prevent, so silence was the worst available answer.
 *
 * It cannot be `string >= 3`. ArkType's string bound counts UTF-16 code units and SQL's `length()`
 * counts characters, so `'\u{1F44D}\u{1F44D}\u{1F44D}'` is three characters to Postgres and six
 * units to ArkType. For a minimum that is merely too lenient; for a maximum it rejects rows the
 * database accepts, which breaks working code. So it goes where an exact count can be written: a
 * narrow on the object, beside the row-level checks.
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

let seq = 0;

async function schemasFor(columns: Column[], checks: any[]): Promise<Record<string, any>> {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-length');
  await fs.mkdir(dir, { recursive: true });
  await new ArkTypeGenerator(analysis).generate({ outDir: dir } as never);
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.arktype.ts'), file);
  return await import(file);
}

const run = (schema: any, v: unknown) => !(schema(v) instanceof type.errors);

describe('a length() CHECK', () => {
  it('is enforced', async () => {
    const m = await schemasFor([col('n')], [{ name: 'a', expression: 'length(n) >= 3' }]);
    expect(run(m.SelecttSchema, { n: 'ab' })).toBe(false);
    expect(run(m.SelecttSchema, { n: 'abc' })).toBe(true);
  });

  it('counts characters, not UTF-16 units', async () => {
    // Three thumbs-up is three characters to Postgres and six code units to JavaScript. A bound
    // written as `string <= 5` refuses it; `length(n) <= 5` in SQL does not.
    const m = await schemasFor([col('n')], [{ expression: 'length(n) <= 5' }]);
    expect(run(m.SelecttSchema, { n: '\u{1F44D}\u{1F44D}\u{1F44D}' }), '3 characters').toBe(true);
    expect(run(m.SelecttSchema, { n: 'abcdef' }), '6 characters').toBe(false);
  });

  it('passes when the column is absent, as SQL does', async () => {
    const m = await schemasFor([col('n', { nullable: true })], [{ expression: 'length(n) >= 3' }]);
    expect(run(m.UpdatetSchema, {}), 'omitted on update').toBe(true);
    expect(run(m.SelecttSchema, { n: null }), 'null skips the check').toBe(true);
  });

  it('is absent when there is no length constraint', async () => {
    const m = await schemasFor([col('n')], []);
    expect(run(m.SelecttSchema, { n: '' })).toBe(true);
  });
});
