/**
 * What a `mode: 'date'` column accepts on write, in valibot output.
 *
 * `coerceDates` defaults to coercing on insert and update, which is what lets a client send an ISO
 * string. The coercing branch is a `v.pipe(v.string(), ...)` beside `v.date()`, and it used to take
 * any string at all. `new Date` reads a bare number as a year or as `month.day`, so `'12.5'`,
 * `'0101'` and `'010'` all went through and Postgres refuses all three: the schema passed and the
 * INSERT then failed at the server, which is the one outcome an Insert schema exists to prevent.
 *
 * Everything here runs the emitted module rather than reading its text, because the regex sits
 * between two pipe steps and only running it says which strings reach `new Date`.
 */
import { describe, it, expect } from 'vitest';
import { ValibotGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import * as v from 'valibot';
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
): Promise<Record<string, never>> {
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
  await new ValibotGenerator(analysis).generate({ outDir: dir, coerceDates } as never);
  const file = path.join(dir, `t-${process.pid}-${label}.ts`);
  await fs.rename(path.join(dir, 't.valibot.ts'), file);
  return await import(file);
}

const accepts = (schema: any, x: unknown) => v.safeParse(schema.entries.at, x).success;

/**
 * Strings that are not a bare number, so `COERCIBLE_DATE_STRING` lets them through, and that
 * `new Date` then turns into an Invalid Date.
 *
 * Every one of them is a member of the packed gate's probe pool, and the waiver for the date
 * columns recorded all of them as accepted here while zod refused them: the pattern gates the
 * *shape* of the string and nothing looked at what came out of the coercion. An Invalid Date is
 * still a `Date` instance, so `instanceof` cannot see it and `getTime()` is what has to be asked.
 */
const NOT_DATES = [
  'hello',
  'zzz',
  'not-a-uuid',
  '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  'a',
  'happy',
  'x',
  'xxxxx',
  '12:00:00',
  '25:99:99',
  '999.999.999.999',
  '10.0.0.1',
  'x'.repeat(300),
  '\u{1F44D}\u{1F44D}\u{1F44D}',
  '一'.repeat(300),
];

/** A probe short enough to name in an assertion message. */
const label = (s: string) => (s.length > 20 ? `${s.slice(0, 20)}... (${s.length})` : s);

describe('the default, which coerces on write only', () => {
  it('takes a Date and every notation Postgres and V8 read as the same date', async () => {
    const m = await schemasFor('input', 'input');
    expect(accepts(m.InserttSchema, new Date()), 'a Date').toBe(true);
    for (const s of [
      '2020-01-01',
      '2020-01-01T00:00:00Z',
      '1999-01-08 04:05:06',
      '01/02/2020',
      'January 8, 1999',
      '2020-1-5',
      '  2020-01-01  ',
    ]) {
      expect(accepts(m.InserttSchema, s), s).toBe(true);
    }
  });

  it('refuses a string that is only a number, which Postgres does not read as a date', async () => {
    const m = await schemasFor('input', 'input');
    for (const s of ['12.5', '0101', '010']) {
      expect(accepts(m.InserttSchema, s), s).toBe(false);
      expect(Number.isNaN(new Date(s).getTime()), `${s} is a valid Date in V8`).toBe(false);
    }
    for (const s of ['2020', '99', '1', '0', '.5', '+2020-01-01', '-2020-01-01', ' 2020 ', '']) {
      expect(accepts(m.InserttSchema, s), s).toBe(false);
    }
  });

  it('still refuses the values a bare coercion would have taken', async () => {
    const m = await schemasFor('input', 'input');
    expect(accepts(m.InserttSchema, null), 'null on a NOT NULL column').toBe(false);
    expect(accepts(m.InserttSchema, true), 'a boolean').toBe(false);
    expect(accepts(m.InserttSchema, [1, 2]), 'an array').toBe(false);
  });

  it('refuses a string that reaches `new Date` and comes back Invalid', async () => {
    const m = await schemasFor('input', 'input');
    for (const s of NOT_DATES) {
      expect(Number.isNaN(new Date(s).getTime()), `${label(s)} is a real date`).toBe(true);
      expect(accepts(m.InserttSchema, s), label(s)).toBe(false);
      expect(accepts(m.UpdatetSchema, s), `${label(s)} on update`).toBe(false);
    }
  });

  it('leaves select strict, since a row out of the database is already a Date', async () => {
    const m = await schemasFor('input', 'input');
    expect(accepts(m.SelecttSchema, new Date())).toBe(true);
    expect(accepts(m.SelecttSchema, '2020-01-01'), 'a string on select').toBe(false);
  });
});

describe('the explicit settings', () => {
  it("coerces on select too under 'all', and narrows there as well", async () => {
    const m = await schemasFor('all', 'all');
    expect(accepts(m.SelecttSchema, '2020-01-01')).toBe(true);
    expect(accepts(m.SelecttSchema, '12.5'), 'still not a bare number').toBe(false);
    expect(accepts(m.SelecttSchema, null), 'still not null').toBe(false);
    for (const s of NOT_DATES) {
      expect(accepts(m.SelecttSchema, s), `${label(s)} on select`).toBe(false);
    }
  });

  it("coerces nowhere under 'none', which is what matches the official module", async () => {
    const m = await schemasFor('none', 'none');
    expect(accepts(m.InserttSchema, new Date())).toBe(true);
    expect(accepts(m.InserttSchema, '2020-01-01')).toBe(false);
  });
});
