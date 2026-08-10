/**
 * A temporal column carried as text refuses a blank string, and nothing more.
 *
 * The defect: `date({ mode: 'string' })` emitted a bare `z.string()`, so the schema accepted `''`
 * for a date column. Postgres refuses `''` for every temporal type, measured through PGlite, so
 * that schema admitted a write the database will not take. `''` is what an untouched form control
 * submits, which is how it reaches an insert in the first place.
 *
 * The over-rejection hazard is the whole reason this is a floor rather than a shape. Postgres
 * reads `'today'`, `'January 8, 1999'`, `'01/08/1999'` and `'20200101'` as dates, and accepts a
 * valid value with surrounding whitespace, so every one of those is asserted here as accepted. A
 * check that turns away what the database stores breaks working code, which is worse than the hole
 * it closes.
 *
 * The analyzer decides which columns carry the marker, per engine and per type; that grid is
 * pinned in its own package. This file is the behavioural half: what the emitted schema does with
 * a column that carries it.
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
    dbType: 'TIMESTAMP',
    format: 'temporalText',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

let seq = 0;

async function schemasFor(columns: Column[]): Promise<Record<string, any>> {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks: [] }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-temporal-blank');
  await fs.mkdir(dir, { recursive: true });
  await new ZodGenerator(analysis).generate({ outDir: dir } as never);
  // Unique per call: the module cache is process-global.
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.zod.ts'), file);
  return await import(file);
}

describe('what the database refuses, the schema refuses', () => {
  it.each([
    ['the empty string', ''],
    ['one space', ' '],
    ['several spaces', '   '],
    ['a tab', '\t'],
    ['a newline', '\n'],
  ])('rejects %s', async (_label, value) => {
    const m = await schemasFor([col('at')]);
    expect(m.SelecttSchema.shape.at.safeParse(value).success).toBe(false);
  });
});

describe('what the database accepts, the schema accepts', () => {
  it.each([
    ['an ISO date', '2020-01-01'],
    ['a single-digit month and day', '2020-1-1'],
    ['a spelled-out date', 'January 8, 1999'],
    ['a slashed date', '01/08/1999'],
    ['no separators at all', '20200101'],
    ['a relative word', 'today'],
    ['a time', '10:00:00'],
    ['an interval', '1 day'],
    ['surrounding whitespace', '  2020-01-01  '],
    ['the infinity a timestamp column takes', 'infinity'],
  ])('accepts %s', async (_label, value) => {
    const m = await schemasFor([col('at')]);
    expect(m.SelecttSchema.shape.at.safeParse(value).success).toBe(true);
  });
});

describe('scope', () => {
  it('applies on every mode, because a blank is a blank on read and on write', async () => {
    const m = await schemasFor([col('at')]);
    for (const s of ['SelecttSchema', 'InserttSchema', 'UpdatetSchema']) {
      const shape = m[s].shape.at;
      expect(shape.safeParse('').success, `${s} blank`).toBe(false);
      expect(shape.safeParse('2020-01-01').success, `${s} valid`).toBe(true);
    }
  });

  it('leaves a nullable column able to be null', async () => {
    const m = await schemasFor([col('at', { nullable: true })]);
    expect(m.SelecttSchema.shape.at.safeParse(null).success).toBe(true);
    expect(m.SelecttSchema.shape.at.safeParse('').success).toBe(false);
  });

  it('leaves a column the analyzer did not mark exactly as it was', async () => {
    const m = await schemasFor([col('note', { dbType: 'TEXT', format: undefined })]);
    expect(m.SelecttSchema.shape.note.safeParse('').success).toBe(true);
  });
});
