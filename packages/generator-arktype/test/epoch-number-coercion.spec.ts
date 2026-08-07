/**
 * An epoch number on a `mode: 'date'` column, in ArkType output.
 *
 * `coerceDates` is documented as accepting a date string **or an epoch number** on write. Only the
 * zod generator ever had a number branch, so `Date.now()` was taken by one of the four generators
 * and refused by the other three, on insert and update alike: which of your schemas accepts an
 * epoch depended on which validator you chose.
 *
 * A number that does not produce a real date is still refused. `new Date(NaN)` and
 * `new Date(Infinity)` are Invalid Dates, and so is any finite number past the +-8.64e15 the Date
 * range ends at, which is why the result check applies to this branch and not only to the string
 * one. ArkType's `number` refuses `NaN` on its own and takes both infinities, measured, so the
 * narrow is load-bearing rather than belt-and-braces.
 *
 * The whole object is parsed rather than a single field pulled off the type, because that is the
 * form ArkType is actually used in and it makes an optional key no different from a required one.
 * A base row that passes on its own is built once, and one key at a time is replaced, so a refusal
 * can only have come from the key under test.
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
      {
        name: 't',
        tsName: 't',
        columns: [
          col('at'),
          col('maybe', { nullable: true }),
          col('many', { arrayDimensions: 1 }),
        ],
        unique: [],
        indexes: [],
        checks: [],
      },
    ] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-epoch');
  await fs.mkdir(dir, { recursive: true });
  await new ArkTypeGenerator(analysis).generate({ outDir: dir, coerceDates } as never);
  const file = path.join(dir, `t-${process.pid}-${label}.ts`);
  await fs.rename(path.join(dir, 't.arktype.ts'), file);
  return await import(file);
}

const base = () => ({ at: new Date(), maybe: new Date(), many: [new Date()] });

const parses = (schema: any, row: unknown) => !(schema(row) instanceof type.errors);

const accepts = (schema: any, field: string, x: unknown) =>
  parses(schema, { ...base(), [field]: x });

/** Numbers that are a real date, so the documented coercion has to take them. */
const EPOCHS = [1700000000000, 0, -1, 1.5, 2147483648, 8.64e15];

/**
 * Numbers `new Date` turns into an Invalid Date.
 *
 * The last two are the ones a bare `number` branch would have taken: they are finite, so no
 * non-finite guard sees them, and they are past the end of the range a JS `Date` can represent.
 */
const NOT_DATES = [NaN, Infinity, -Infinity, 1e300, 8.64e15 + 1];

describe('an epoch number on write', () => {
  it('parses the base row it varies, so a refusal below names its own field', async () => {
    const m = await schemasFor('input', 'input');
    expect(parses(m.InserttSchema, base()), 'the base row on insert').toBe(true);
    expect(parses(m.UpdatetSchema, base()), 'the base row on update').toBe(true);
    expect(parses(m.SelecttSchema, base()), 'the base row on select').toBe(true);
  });

  it('takes one on insert and on update', async () => {
    const m = await schemasFor('input', 'input');
    for (const n of EPOCHS) {
      expect(Number.isNaN(new Date(n).getTime()), `${n} is not a real date`).toBe(false);
      expect(accepts(m.InserttSchema, 'at', n), `${n} on insert`).toBe(true);
      expect(accepts(m.UpdatetSchema, 'at', n), `${n} on update`).toBe(true);
    }
  });

  it('refuses a number that does not produce a real date', async () => {
    const m = await schemasFor('input', 'input');
    for (const n of NOT_DATES) {
      expect(Number.isNaN(new Date(n).getTime()), `${n} is a real date`).toBe(true);
      expect(accepts(m.InserttSchema, 'at', n), `${n} on insert`).toBe(false);
      expect(accepts(m.UpdatetSchema, 'at', n), `${n} on update`).toBe(false);
    }
  });

  it('leaves everything the string branch already decided alone', async () => {
    const m = await schemasFor('input', 'input');
    expect(accepts(m.InserttSchema, 'at', new Date()), 'a Date').toBe(true);
    expect(accepts(m.InserttSchema, 'at', '2020-01-01'), 'a date string').toBe(true);
    expect(accepts(m.InserttSchema, 'at', '2020-01-01T00:00:00Z'), 'an ISO timestamp').toBe(true);
    expect(accepts(m.InserttSchema, 'at', 'hello'), 'an unparseable string').toBe(false);
    expect(accepts(m.InserttSchema, 'at', '12.5'), 'a bare number as a string').toBe(false);
    expect(accepts(m.InserttSchema, 'at', null), 'null on a NOT NULL column').toBe(false);
    expect(accepts(m.InserttSchema, 'at', true), 'a boolean').toBe(false);
    expect(accepts(m.InserttSchema, 'at', [1, 2]), 'an array').toBe(false);
  });

  it('coerces on a nullable column without losing the null', async () => {
    const m = await schemasFor('input', 'input');
    expect(accepts(m.InserttSchema, 'maybe', null), 'null').toBe(true);
    expect(accepts(m.InserttSchema, 'maybe', 1700000000000), 'an epoch').toBe(true);
    expect(accepts(m.InserttSchema, 'maybe', new Date()), 'a Date').toBe(true);
    expect(accepts(m.InserttSchema, 'maybe', NaN), 'NaN').toBe(false);
    expect(accepts(m.InserttSchema, 'maybe', 'hello'), 'an unparseable string').toBe(false);
  });

  it('coerces each element of a Date[] column', async () => {
    const m = await schemasFor('input', 'input');
    expect(accepts(m.InserttSchema, 'many', [1700000000000, 0]), 'epochs').toBe(true);
    expect(accepts(m.InserttSchema, 'many', [new Date(), '2020-01-01']), 'a Date and a string').toBe(
      true
    );
    expect(accepts(m.InserttSchema, 'many', [1700000000000, NaN]), 'one NaN among them').toBe(false);
    expect(accepts(m.InserttSchema, 'many', 1700000000000), 'a bare number, not a list').toBe(false);
  });

  it('leaves select strict, since a row out of the database is already a Date', async () => {
    const m = await schemasFor('input', 'input');
    expect(accepts(m.SelecttSchema, 'at', new Date())).toBe(true);
    expect(accepts(m.SelecttSchema, 'at', 1700000000000), 'an epoch on select').toBe(false);
  });
});

describe('the explicit settings', () => {
  it("coerces a number on select too under 'all', and still checks the result", async () => {
    const m = await schemasFor('all', 'all');
    expect(accepts(m.SelecttSchema, 'at', 1700000000000)).toBe(true);
    expect(accepts(m.SelecttSchema, 'at', NaN), 'still not NaN').toBe(false);
    expect(accepts(m.SelecttSchema, 'at', Infinity), 'still not Infinity').toBe(false);
  });

  it("coerces nowhere under 'none', so a number is refused on write too", async () => {
    const m = await schemasFor('none', 'none');
    expect(accepts(m.InserttSchema, 'at', new Date())).toBe(true);
    expect(accepts(m.InserttSchema, 'at', 1700000000000)).toBe(false);
  });
});
