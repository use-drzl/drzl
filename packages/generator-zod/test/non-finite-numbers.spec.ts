/**
 * `NaN` and the two infinities on a Postgres float column, in zod output.
 *
 * Postgres stores all three in `real` and `double precision` and hands them back on SELECT, and
 * stores `NaN` in a `numeric`. `z.number()` refuses all three with no bound at all, and a
 * `.gte()/.lte()` pair refuses the infinities whatever the numbers are, so every read of such a
 * row failed validation on a column behaving exactly as documented.
 *
 * Every assertion runs the emitted module. The emitted text is asserted too, because the union is
 * the point of the change and a reader of the generated file should see it, but a string that
 * looks right and does not parse is the recurring failure in this repository, so the text is never
 * the only check.
 */
import { describe, it, expect } from 'vitest';
import { ZodGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
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

/** The three Postgres columns this change is about, exactly as the analyzer states them. */
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
  await new ZodGenerator(analysis).generate({ outDir: dir } as never);
  const file = path.join(dir, `t-${process.pid}-${label}.ts`);
  await fs.rename(path.join(dir, 't.zod.ts'), file);
  // Whitespace collapsed, because the emitted file is run through prettier and a union this long
  // is wrapped over six lines. The assertions are about which branches were emitted, not about
  // where the formatter chose to break them.
  const source = (await fs.readFile(file, 'utf8')).replace(/\s+/g, ' ');
  return { source, module: await import(file) };
}

const accepts = (schema: any, v: unknown) => schema.safeParse(v).success;

describe('a postgres real and double precision column', () => {
  it('accepts NaN and both infinities, and still refuses a string and a null', async () => {
    const { module: m, source } = await emit([REAL, DOUBLE], 'floats');
    for (const name of ['c_real', 'c_double']) {
      const f = m.SelecttSchema.shape[name];
      expect(accepts(f, NaN), `${name} NaN`).toBe(true);
      expect(accepts(f, Infinity), `${name} Infinity`).toBe(true);
      expect(accepts(f, -Infinity), `${name} -Infinity`).toBe(true);
      expect(accepts(f, 1.5), `${name} an ordinary number`).toBe(true);
      expect(accepts(f, 'x'), `${name} a string`).toBe(false);
      expect(accepts(f, null), `${name} null on a NOT NULL column`).toBe(false);
    }
    expect(source).toContain(
      `z.union([ z .number() .gte(-${PG_FLOAT4_MAX}) .lte(${PG_FLOAT4_MAX}), z.nan(), z.literal(Infinity), z.literal(-Infinity), ])`
    );
    expect(source).toContain(
      'z.union([z.number(), z.nan(), z.literal(Infinity), z.literal(-Infinity)])'
    );
  });

  it('keeps the magnitude bound the 4 byte column really has', async () => {
    // The union widens the column by exactly three values. A `real` still refuses 1e300, which
    // Postgres refuses too, and a `double precision` still takes it.
    const { module: m } = await emit([REAL, DOUBLE], 'magnitude');
    expect(accepts(m.SelecttSchema.shape.c_real, 1e300), 'real at 1e300').toBe(false);
    expect(accepts(m.SelecttSchema.shape.c_double, 1e300), 'double at 1e300').toBe(true);
    // A full-magnitude float4 as the text protocol returns it, which is the value the bound exists
    // to keep accepting.
    expect(accepts(m.SelecttSchema.shape.c_real, 3.4028235e38)).toBe(true);
  });

  it('survives the array and nullable wrappers', async () => {
    const { module: m } = await emit(
      [
        col('a_real', { ...REAL, name: 'a_real', arrayDimensions: 1 }),
        col('n_real', { ...REAL, name: 'n_real', nullable: true }),
      ],
      'wrappers'
    );
    expect(accepts(m.SelecttSchema.shape.a_real, [NaN, Infinity, 1.5])).toBe(true);
    expect(accepts(m.SelecttSchema.shape.a_real, [1e300]), 'an out-of-range element').toBe(false);
    expect(accepts(m.SelecttSchema.shape.a_real, NaN), 'a bare element').toBe(false);
    expect(accepts(m.SelecttSchema.shape.n_real, null)).toBe(true);
    expect(accepts(m.SelecttSchema.shape.n_real, NaN)).toBe(true);
  });
});

describe('a postgres numeric in number mode', () => {
  it('accepts NaN and keeps refusing both infinities', async () => {
    // Deliberate and documented: Postgres takes an infinity in an unconstrained `numeric` and
    // answers 22003 numeric field overflow for a `numeric(10,2)`, and the analyzer reads no
    // precision at all, so it cannot tell the two apart.
    const { module: m, source } = await emit([NUMERIC], 'numeric');
    const f = m.SelecttSchema.shape.c_numeric_n;
    expect(accepts(f, NaN)).toBe(true);
    expect(accepts(f, Infinity)).toBe(false);
    expect(accepts(f, -Infinity)).toBe(false);
    expect(accepts(f, 1.5)).toBe(true);
    expect(accepts(f, 'x')).toBe(false);
    expect(accepts(f, null)).toBe(false);
    expect(source).toContain(
      `z.union([z.number().gte(-${JS_MAX}).lte(${JS_MAX}), z.nan()])`
    );
    expect(source, 'no infinity branch').not.toContain('z.literal(Infinity)');
  });
});

describe('every other number column', () => {
  it('is emitted exactly as before', async () => {
    // Postgres refuses all three on an `integer`, and MySQL refuses them on a `float`, so neither
    // column may change. A column with no flags at all is what a MySQL or SQLite analysis produces.
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
    expect(source).toContain('z.number().int().gte(-2147483648).lte(2147483647)');
    expect(source, 'no union anywhere').not.toContain('z.nan()');
    for (const name of ['c_int', 'm_float']) {
      const f = m.SelecttSchema.shape[name];
      expect(accepts(f, NaN), `${name} NaN`).toBe(false);
      expect(accepts(f, Infinity), `${name} Infinity`).toBe(false);
      expect(accepts(f, -Infinity), `${name} -Infinity`).toBe(false);
    }
  });
});
