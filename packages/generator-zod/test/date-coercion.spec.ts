/**
 * What a date column accepts on write, checked by running the emitted schemas.
 *
 * `coerceDates` defaults to coercing on insert and update, which is what lets a client send an
 * ISO string. It was implemented as `z.coerce.date()`, which is `new Date(v)` on absolutely
 * anything: `new Date(null)` is the epoch, `new Date(true)` is one millisecond past it, and
 * `new Date([1, 2])` parses the array as a string. So a NOT NULL timestamp column accepted
 * `null`, `true` and an array, and every one of them silently became a real date.
 *
 * Narrowing to strings and numbers was not enough. `new Date` reads a bare number as a year or as
 * `month.day`, so `'12.5'`, `'0101'` and `'010'` were real dates too, and Postgres refuses all
 * three: the schema passed and the INSERT then failed at the server. A string now has to look like
 * a date notation before it is coerced at all; `COERCIBLE_DATE_STRING` in validation-core carries
 * the measurement.
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

/**
 * Strings that are not a bare number, so `COERCIBLE_DATE_STRING` lets them through, and that
 * `new Date` then turns into an Invalid Date.
 *
 * This generator already refused every one of them and the other three did not, which is what made
 * it the reference for the fix: `z.preprocess(coerce, z.date())` validates the *result* of the
 * coercion, and an Invalid Date is a `Date` instance that `z.date()` still turns away. The list is
 * the packed gate's probe pool, and the same list is asserted in the other three packages.
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

  it('refuses a string that reaches `new Date` and comes back Invalid', async () => {
    const m = await schemasFor('input', 'input');
    for (const s of NOT_DATES) {
      expect(Number.isNaN(new Date(s).getTime()), `${label(s)} is a real date`).toBe(true);
      expect(accepts(m.InserttSchema, s), label(s)).toBe(false);
      expect(accepts(m.UpdatetSchema, s), `${label(s)} on update`).toBe(false);
    }
  });

  it('refuses a string that is only a number, which Postgres does not read as a date', async () => {
    // The three the ground-truth gate caught. `new Date('12.5')` is a real date in V8, and so are
    // `'0101'` and `'010'`, so the insert passed validation and then failed at the server.
    const m = await schemasFor('input', 'input');
    for (const s of ['12.5', '0101', '010']) {
      expect(accepts(m.InserttSchema, s), s).toBe(false);
      expect(Number.isNaN(new Date(s).getTime()), `${s} is a valid Date in V8`).toBe(false);
    }
    for (const s of ['2020', '99', '1', '0', '.5', '+2020-01-01', '-2020-01-01', ' 2020 ']) {
      expect(accepts(m.InserttSchema, s), s).toBe(false);
    }
  });

  it('still takes every notation Postgres and V8 read as the same date', async () => {
    const m = await schemasFor('input', 'input');
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

  it('leaves the number path alone, so an epoch millisecond still coerces', async () => {
    // The narrowing is about strings. A number carries no notation to be wrong about, and
    // `1700000000000` as a string is refused while the same value as a number is taken.
    const m = await schemasFor('input', 'input');
    expect(accepts(m.InserttSchema, 1700000000000), 'a number').toBe(true);
    expect(accepts(m.InserttSchema, 0), 'the epoch').toBe(true);
    expect(accepts(m.InserttSchema, '1700000000000'), 'the same value as a string').toBe(false);
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
    expect(accepts(m.SelecttSchema, '12.5'), 'and still not a bare number').toBe(false);
  });

  it("coerces nowhere under 'none', which is what matches the official module", async () => {
    const m = await schemasFor('none', 'none');
    expect(accepts(m.InserttSchema, new Date())).toBe(true);
    expect(accepts(m.InserttSchema, '2020-01-01')).toBe(false);
  });
});
