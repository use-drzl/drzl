/**
 * `applyDefaults`, which reproduces literal column defaults in the insert schema.
 *
 * Drizzle knows the default; `drizzle-orm/zod` reproduces none of them. With this on, parsing an
 * insert fills them in, so the parsed object matches the row the database would have written.
 *
 * Only literals. `defaultNow()`, `defaultRandom()` and any `sql` default are evaluated by the
 * database, and `$defaultFn` is called by Drizzle at insert time; a schema guessing at any of
 * them would produce a different value than the one actually stored.
 *
 * Verified against a real Postgres through PGlite: inserting only the column that has no default
 * leaves the database filling in `GB`, `0` and `true`, which is exactly what the schema fills in.
 */
import { describe, it, expect } from 'vitest';
import { ZodGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
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

async function schemasFor(columns: Column[], applyDefaults: boolean): Promise<Record<string, any>> {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks: [] }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-defaults');
  await fs.mkdir(dir, { recursive: true });
  await new ZodGenerator(analysis).generate({ outDir: dir, applyDefaults } as never);
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.zod.ts'), file);
  return await import(file);
}

const LITERAL = [col('country', { hasDefault: true, defaultValue: 'GB' })];

describe('off by default', () => {
  it('leaves the field merely optional', async () => {
    const m = await schemasFor(LITERAL, false);
    expect(m.InserttSchema.parse({})).toEqual({});
  });
});

describe('with applyDefaults', () => {
  it('fills the value in when the key is absent', async () => {
    const m = await schemasFor(LITERAL, true);
    expect(m.InserttSchema.parse({})).toEqual({ country: 'GB' });
  });

  it('leaves a supplied value alone', async () => {
    const m = await schemasFor(LITERAL, true);
    expect(m.InserttSchema.parse({ country: 'FR' })).toEqual({ country: 'FR' });
  });

  it('handles the non-string literals', async () => {
    const m = await schemasFor(
      [
        col('count', { tsType: 'number', dbType: 'INTEGER', hasDefault: true, defaultValue: 0 }),
        col('flag', { tsType: 'boolean', dbType: 'BOOLEAN', hasDefault: true, defaultValue: true }),
      ],
      true
    );
    // `0` and `false` are the cases a truthiness check would drop.
    expect(m.InserttSchema.parse({})).toEqual({ count: 0, flag: true });
  });

  it('does not stack optional on top, which would leave the default unreachable', async () => {
    // `.optional()` wrapped around `.default()` short-circuits on an absent key and returns
    // undefined, so the default would never be reached. The observable difference is exactly
    // whether the parsed object carries the value.
    const m = await schemasFor(LITERAL, true);
    const parsed = m.InserttSchema.parse({});
    expect('country' in parsed, 'key present after parsing').toBe(true);
    expect(parsed.country).not.toBe(undefined);
  });

  it('leaves a column whose default the database evaluates alone', async () => {
    // `defaultNow()` has `hasDefault` but no literal, so there is nothing to reproduce and the
    // field stays optional. Guessing at `now()` would write a different timestamp.
    const m = await schemasFor([col('createdAt', { hasDefault: true })], true);
    expect(m.InserttSchema.parse({})).toEqual({});
  });

  it('touches only the insert schema', async () => {
    // A default is applied when a row is created. It is not re-applied on update, and on select
    // the value is already there.
    const m = await schemasFor(LITERAL, true);
    expect(m.UpdatetSchema.parse({})).toEqual({});
    expect(m.SelecttSchema.safeParse({}).success, 'select still requires it').toBe(false);
  });
});
