/**
 * What a date column accepts on write, checked by running the emitted schemas.
 *
 * `coerceDates` defaults to coercing on insert and update, which is what lets a client send an
 * ISO string. It was implemented as `z.coerce.date()`, which is `new Date(v)` on absolutely
 * anything: `new Date(null)` is the epoch, `new Date(true)` is one millisecond past it, and
 * `new Date([1, 2])` parses the array as a string. So a NOT NULL timestamp column accepted
 * `null`, `true` and an array, and every one of them silently became a real date.
 */
import { describe, it, expect } from 'vitest';
import { ZodGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const col = (name: string, over: Partial<Column> = {}): Column =>
  ({
    name,
    tsType: 'Date',
    dbType: 'TIMESTAMP',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

async function schemasFor(
  coerceDates: 'input' | 'all' | 'none',
  label: string
): Promise<Record<string, any>> {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [
      { name: 't', tsName: 't', columns: [col('at')], unique: [], indexes: [], checks: [] },
    ] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-dates');
  await fs.mkdir(dir, { recursive: true });
  await new ZodGenerator(analysis).generate({ outDir: dir, coerceDates } as never);
  const file = path.join(dir, `t-${process.pid}-${label}.ts`);
  await fs.rename(path.join(dir, 't.zod.ts'), file);
  return await import(file);
}

const accepts = (schema: any, x: unknown) => schema.shape.at.safeParse(x).success;

describe('the default, which coerces on write only', () => {
  it('takes a Date, an ISO string and an epoch number', async () => {
    const m = await schemasFor('input', 'input');
    expect(accepts(m.InserttSchema, new Date()), 'a Date').toBe(true);
    expect(accepts(m.InserttSchema, '2020-01-01'), 'an ISO string').toBe(true);
    expect(accepts(m.InserttSchema, 1700000000000), 'an epoch number').toBe(true);
  });

  it('refuses the values that only ever coerced by accident', async () => {
    const m = await schemasFor('input', 'input');
    expect(accepts(m.InserttSchema, null), 'null on a NOT NULL column').toBe(false);
    expect(accepts(m.InserttSchema, true), 'a boolean').toBe(false);
    expect(accepts(m.InserttSchema, [1, 2]), 'an array').toBe(false);
    expect(accepts(m.InserttSchema, 'nonsense'), 'an unparseable string').toBe(false);
  });

  it('leaves select strict, since a row out of the database is already a Date', async () => {
    const m = await schemasFor('input', 'input');
    expect(accepts(m.SelecttSchema, new Date())).toBe(true);
    expect(accepts(m.SelecttSchema, '2020-01-01'), 'a string on select').toBe(false);
  });
});

describe('the explicit settings', () => {
  it("coerces on select too under 'all'", async () => {
    const m = await schemasFor('all', 'all');
    expect(accepts(m.SelecttSchema, '2020-01-01')).toBe(true);
    expect(accepts(m.SelecttSchema, null), 'still not null').toBe(false);
  });

  it("coerces nowhere under 'none', which is what matches the official module", async () => {
    const m = await schemasFor('none', 'none');
    expect(accepts(m.InserttSchema, new Date())).toBe(true);
    expect(accepts(m.InserttSchema, '2020-01-01')).toBe(false);
  });
});
