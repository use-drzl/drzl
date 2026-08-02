/**
 * `CHECK (length(name) >= 3)` in TypeBox output.
 *
 * It was dropped entirely: the parser read it, zod and valibot applied it, and TypeBox emitted a
 * bare `Type.String()`.
 *
 * It cannot be `minLength`. That keyword counts UTF-16 code units and SQL's `length()` counts
 * characters, so three thumbs-up characters are six units. For a minimum that only under-enforces;
 * for a maximum it refuses rows the database accepts. The registered kind added for row checks
 * can hold an exact count, so both ends go there rather than one being right and the other
 * quietly wrong.
 */
import { describe, it, expect } from 'vitest';
import { TypeBoxGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
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
  await new TypeBoxGenerator(analysis).generate({ outDir: dir } as never);
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.typebox.ts'), file);
  return await import(file);
}

describe('a length() CHECK', () => {
  it('is enforced', async () => {
    const m = await schemasFor([col('n')], [{ name: 'a', expression: 'length(n) >= 3' }]);
    expect(Value.Check(m.SelecttSchema, { n: 'ab' })).toBe(false);
    expect(Value.Check(m.SelecttSchema, { n: 'abc' })).toBe(true);
  });

  it('counts characters, not UTF-16 units', async () => {
    const m = await schemasFor([col('n')], [{ expression: 'length(n) <= 5' }]);
    expect(Value.Check(m.SelecttSchema, { n: '\u{1F44D}\u{1F44D}\u{1F44D}' }), '3 chars').toBe(true);
    expect(Value.Check(m.SelecttSchema, { n: 'abcdef' }), '6 chars').toBe(false);
  });

  it('still checks the property type', async () => {
    const m = await schemasFor([col('n')], [{ expression: 'length(n) >= 3' }]);
    expect(Value.Check(m.SelecttSchema, { n: 123 })).toBe(false);
  });

  it('holds under the compiler', async () => {
    const m = await schemasFor([col('n')], [{ expression: 'length(n) >= 3' }]);
    const c = TypeCompiler.Compile(m.SelecttSchema);
    expect(c.Check({ n: 'ab' })).toBe(false);
    expect(c.Check({ n: 'abc' })).toBe(true);
  });

  it('passes when the column is absent or null, as SQL does', async () => {
    const m = await schemasFor([col('n', { nullable: true })], [{ expression: 'length(n) >= 3' }]);
    expect(Value.Check(m.UpdatetSchema, {}), 'omitted on update').toBe(true);
    expect(Value.Check(m.SelecttSchema, { n: null }), 'null skips the check').toBe(true);
  });

  it('is absent when there is no length constraint', async () => {
    const m = await schemasFor([col('n')], []);
    expect(Value.Check(m.SelecttSchema, { n: '' })).toBe(true);
  });
});
