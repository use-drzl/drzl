/**
 * `NaN` and the two infinities on a Postgres float column, in valibot output.
 *
 * Valibot needs less repairing than zod and TypeBox and it is not none. Measured on the installed
 * version: a bare `v.number()` accepts `Infinity` and `-Infinity` and refuses `NaN`, so the NaN
 * branch is needed on every column here. The infinity branches are needed only where the column
 * carries a range, because `v.maxValue(n)` refuses `Infinity` whatever `n` is, which is exactly
 * the `real` and the `numeric` and not the `double precision`.
 *
 * That asymmetry is the reason this is four separate patches rather than one shared renderer.
 */
import { describe, it, expect } from 'vitest';
import { ValibotGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import * as v from 'valibot';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const PG_FLOAT4_MAX = '340282356779733661637539395458142568448';
const JS_MAX = '9007199254740991';

const col = (name: string, over: Partial<Column> = {}): Column =>
  ({
    name,
    tsType: 'number',
    dbType: 'DOUBLE',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    integer: false,
    ...over,
  }) as Column;

const REAL = col('c_real', {
  dbType: 'REAL',
  min: `-${PG_FLOAT4_MAX}`,
  max: PG_FLOAT4_MAX,
  allowsNaN: true,
  allowsInfinity: true,
});
const DOUBLE = col('c_double', { dbType: 'DOUBLE', allowsNaN: true, allowsInfinity: true });
const NUMERIC = col('c_numeric_n', {
  dbType: 'NUMERIC',
  min: `-${JS_MAX}`,
  max: JS_MAX,
  allowsNaN: true,
  allowsInfinity: false,
});

async function emit(columns: Column[], label: string) {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks: [] }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-non-finite');
  await fs.mkdir(dir, { recursive: true });
  await new ValibotGenerator(analysis).generate({ outDir: dir } as never);
  const file = path.join(dir, `t-${process.pid}-${label}.ts`);
  await fs.rename(path.join(dir, 't.valibot.ts'), file);
  const source = (await fs.readFile(file, 'utf8')).replace(/\s+/g, ' ');
  return { source, module: await import(file) };
}

const accepts = (schema: any, key: string, x: unknown) =>
  v.safeParse(schema.entries[key], x).success;

describe('what valibot does on its own', () => {
  it('refuses NaN and takes both infinities, which is why the repair is uneven', () => {
    // The measurement the generator is written against, run rather than remembered. If a future
    // valibot changes either answer, this fails first and says so.
    expect(v.safeParse(v.number(), NaN).success, 'bare number, NaN').toBe(false);
    expect(v.safeParse(v.number(), Infinity).success, 'bare number, Infinity').toBe(true);
    expect(v.safeParse(v.number(), -Infinity).success, 'bare number, -Infinity').toBe(true);
    const bounded = v.pipe(v.number(), v.minValue(-5), v.maxValue(5));
    expect(v.safeParse(bounded, Infinity).success, 'bounded, Infinity').toBe(false);
    expect(v.safeParse(bounded, -Infinity).success, 'bounded, -Infinity').toBe(false);
  });
});

describe('a postgres real and double precision column', () => {
  it('accepts NaN and both infinities, and still refuses a string and a null', async () => {
    const { module: m, source } = await emit([REAL, DOUBLE], 'floats');
    for (const name of ['c_real', 'c_double']) {
      expect(accepts(m.SelecttSchema, name, NaN), `${name} NaN`).toBe(true);
      expect(accepts(m.SelecttSchema, name, Infinity), `${name} Infinity`).toBe(true);
      expect(accepts(m.SelecttSchema, name, -Infinity), `${name} -Infinity`).toBe(true);
      expect(accepts(m.SelecttSchema, name, 1.5), `${name} an ordinary number`).toBe(true);
      expect(accepts(m.SelecttSchema, name, 'x'), `${name} a string`).toBe(false);
      expect(accepts(m.SelecttSchema, name, null), `${name} null`).toBe(false);
    }
    expect(source, 'the bounded column states the infinities').toContain('v.literal(Infinity)');
    expect(source, 'the unbounded one does not need to').toContain(
      'c_double: v.union([v.number(), v.nan()])'
    );
  });

  it('keeps the magnitude bound the 4 byte column really has', async () => {
    const { module: m } = await emit([REAL, DOUBLE], 'magnitude');
    expect(accepts(m.SelecttSchema, 'c_real', 1e300), 'real at 1e300').toBe(false);
    expect(accepts(m.SelecttSchema, 'c_double', 1e300), 'double at 1e300').toBe(true);
    expect(accepts(m.SelecttSchema, 'c_real', 3.4028235e38)).toBe(true);
  });

  it('survives the array and nullable wrappers', async () => {
    const { module: m } = await emit(
      [
        col('a_real', { ...REAL, name: 'a_real', arrayDimensions: 1 }),
        col('n_real', { ...REAL, name: 'n_real', nullable: true }),
      ],
      'wrappers'
    );
    expect(accepts(m.SelecttSchema, 'a_real', [NaN, Infinity, 1.5])).toBe(true);
    expect(accepts(m.SelecttSchema, 'a_real', [1e300]), 'an out-of-range element').toBe(false);
    expect(accepts(m.SelecttSchema, 'a_real', NaN), 'a bare element').toBe(false);
    expect(accepts(m.SelecttSchema, 'n_real', null)).toBe(true);
    expect(accepts(m.SelecttSchema, 'n_real', NaN)).toBe(true);
  });
});

describe('a postgres numeric in number mode', () => {
  it('accepts NaN and keeps refusing both infinities', async () => {
    const { module: m, source } = await emit([NUMERIC], 'numeric');
    expect(accepts(m.SelecttSchema, 'c_numeric_n', NaN)).toBe(true);
    expect(accepts(m.SelecttSchema, 'c_numeric_n', Infinity)).toBe(false);
    expect(accepts(m.SelecttSchema, 'c_numeric_n', -Infinity)).toBe(false);
    expect(accepts(m.SelecttSchema, 'c_numeric_n', 1.5)).toBe(true);
    expect(accepts(m.SelecttSchema, 'c_numeric_n', 'x')).toBe(false);
    expect(accepts(m.SelecttSchema, 'c_numeric_n', null)).toBe(false);
    expect(source).toContain('v.nan()');
    expect(source, 'no infinity branch').not.toContain('v.literal(Infinity)');
  });
});

describe('every other number column', () => {
  it('is emitted exactly as before', async () => {
    const { module: m, source } = await emit(
      [
        col('c_int', { dbType: 'INTEGER', integer: true, min: '-2147483648', max: '2147483647' }),
        col('m_float', {
          dbType: 'REAL',
          min: '-340282346638528859811704183484516925440',
          max: '340282346638528859811704183484516925440',
        }),
      ],
      'untouched'
    );
    expect(source).toContain(
      'v.pipe(v.number(), v.integer(), v.minValue(-2147483648), v.maxValue(2147483647))'
    );
    expect(source, 'no union anywhere').not.toContain('v.nan()');
    for (const name of ['c_int', 'm_float']) {
      expect(accepts(m.SelecttSchema, name, NaN), `${name} NaN`).toBe(false);
      expect(accepts(m.SelecttSchema, name, Infinity), `${name} Infinity`).toBe(false);
      expect(accepts(m.SelecttSchema, name, -Infinity), `${name} -Infinity`).toBe(false);
    }
  });
});
