/**
 * `CHECK (col <> 'banned')` in the arktype generator.
 *
 * This constraint used to be emitted as a bare `string`, so a CHECK the shared parser read and
 * three other generators enforced was enforced by nothing here. ArkType's DSL has no negation,
 * and the two spellings that look like they should work were measured on 2.2.3 and do not:
 * `string & !'banned'` is a parse error, and `Exclude<string, 'banned'>` parses and then accepts
 * `'banned'`. So it goes on a narrow, the same escape hatch the character caps use.
 *
 * Everything here runs the emitted schema. A text assertion would pass on a narrow that never
 * fires, which is the failure mode being fixed.
 */
import { describe, it, expect } from 'vitest';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ArkTypeGenerator } from '../src/index';
import { type } from 'arktype';

const RUN = (schema: any, input: unknown) => !(schema(input) instanceof type.errors);

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
  await new ArkTypeGenerator(analysis).generate({ outDir: dir } as never);
  // Unique per call: the module cache is process-global.
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.arktype.ts'), file);
  return await import(file);
}

describe('a string inequality', () => {
  it('refuses the excluded value and accepts every other string', async () => {
    const m = await schemasFor(
      [col('tier')],
      [{ name: 'tier_not_banned', expression: "tier <> 'banned'" }]
    );
    expect(RUN(m.SelecttSchema, { tier: 'gold' })).toBe(true);
    expect(RUN(m.SelecttSchema, { tier: 'banned' })).toBe(false);
    // The base type still applies, which is what the narrow must not replace.
    expect(RUN(m.SelecttSchema, { tier: 7 })).toBe(false);
  });

  it('applies on every mode, because the database applies it on every write', async () => {
    const m = await schemasFor(
      [col('tier')],
      [{ name: 'tier_not_banned', expression: "tier <> 'banned'" }]
    );
    for (const s of ['SelecttSchema', 'InserttSchema', 'UpdatetSchema']) {
      expect(RUN(m[s], { tier: 'banned' }), s).toBe(false);
    }
  });

  it('passes null, because SQL never applied the comparison', async () => {
    const m = await schemasFor(
      [col('tier', { nullable: true })],
      [{ name: 'tier_not_banned', expression: "tier <> 'banned'" }]
    );
    expect(RUN(m.SelecttSchema, { tier: null })).toBe(true);
    expect(RUN(m.SelecttSchema, { tier: 'banned' })).toBe(false);
  });
});

describe('a number inequality', () => {
  it('refuses the excluded number and keeps the type check', async () => {
    const m = await schemasFor(
      [col('lucky', { tsType: 'number', dbType: 'INTEGER' })],
      [{ name: 'lucky_not_7', expression: 'lucky <> 7' }]
    );
    expect(RUN(m.SelecttSchema, { lucky: 6 })).toBe(true);
    expect(RUN(m.SelecttSchema, { lucky: 7 })).toBe(false);
    expect(RUN(m.SelecttSchema, { lucky: 'seven' })).toBe(false);
  });

  it('coexists with a range on the same column', async () => {
    const m = await schemasFor(
      [col('lucky', { tsType: 'number', dbType: 'INTEGER' })],
      [
        { name: 'lucky_adult', expression: 'lucky >= 5' },
        { name: 'lucky_not_7', expression: 'lucky <> 7' },
      ]
    );
    expect(RUN(m.SelecttSchema, { lucky: 6 })).toBe(true);
    expect(RUN(m.SelecttSchema, { lucky: 7 })).toBe(false);
    expect(RUN(m.SelecttSchema, { lucky: 4 })).toBe(false);
  });
});

describe('what it does not touch', () => {
  it('leaves an array column alone, since a scalar comparison describes an element', async () => {
    const m = await schemasFor(
      [col('tags', { arrayDimensions: 1 } as Partial<Column>)],
      [{ name: 'tags_not_banned', expression: "tags <> 'banned'" }]
    );
    expect(RUN(m.SelecttSchema, { tags: ['banned'] })).toBe(true);
  });

  it('leaves a column with no inequality exactly as it was', async () => {
    const m = await schemasFor([col('tier')], [{ name: 'tier_is_a', expression: "tier = 'A'" }]);
    expect(RUN(m.SelecttSchema, { tier: 'A' })).toBe(true);
    expect(RUN(m.SelecttSchema, { tier: 'B' })).toBe(false);
  });
});
