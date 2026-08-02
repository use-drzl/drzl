/**
 * `applyDefaults` in the valibot generator.
 *
 * Each library states a default in its own way, so this checks the emitted module *runs* and
 * fills the value in, rather than that it contains a particular string. `drizzle-orm` reproduces
 * no defaults in any of its validator modules.
 *
 * Only literals: an SQL default (`defaultNow()`, `defaultRandom()`, any `sql`) is evaluated by
 * the database and a `$defaultFn` is called by Drizzle at insert time, so both stay optional.
 */
import { describe, it, expect } from 'vitest';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ValibotGenerator } from '../src/index';
import * as v from 'valibot';

const RUN = (schema: any, input: unknown) => v.parse(schema, input);
const GEN = ValibotGenerator;
const SUFFIX = '.valibot.ts';

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
  await new GEN(analysis).generate({ outDir: dir, applyDefaults } as never);
  // Unique per call: the module cache is process-global.
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, `t${SUFFIX}`), file);
  return await import(file);
}

const LITERAL = [
  col('name'),
  col('country', { hasDefault: true, defaultValue: 'GB' }),
  col('count', { tsType: 'number', dbType: 'INTEGER', hasDefault: true, defaultValue: 0 }),
  col('flag', { tsType: 'boolean', dbType: 'BOOLEAN', hasDefault: true, defaultValue: true }),
];

describe('off by default', () => {
  it('leaves the fields merely optional', async () => {
    const m = await schemasFor(LITERAL, false);
    expect(RUN(m.InserttSchema, { name: 'x' })).toEqual({ name: 'x' });
  });
});

describe('with applyDefaults', () => {
  it('fills every literal in, including the falsy ones', async () => {
    // `0` and `false` are the values a truthiness check would silently drop.
    const m = await schemasFor(LITERAL, true);
    expect(RUN(m.InserttSchema, { name: 'x' })).toEqual({
      name: 'x',
      country: 'GB',
      count: 0,
      flag: true,
    });
  });

  it('leaves a supplied value alone', async () => {
    const m = await schemasFor(LITERAL, true);
    expect(RUN(m.InserttSchema, { name: 'x', country: 'FR' })).toMatchObject({ country: 'FR' });
  });

  it('leaves a column whose default the database evaluates alone', async () => {
    // `defaultNow()` has `hasDefault` but no literal, so there is nothing to reproduce.
    const m = await schemasFor([col('name'), col('createdAt', { hasDefault: true })], true);
    expect(RUN(m.InserttSchema, { name: 'x' })).toEqual({ name: 'x' });
  });

  it('touches only the insert schema', async () => {
    // A default applies when a row is created, not when it is updated.
    const m = await schemasFor(LITERAL, true);
    expect(RUN(m.UpdatetSchema, {})).toEqual({});
  });
});
