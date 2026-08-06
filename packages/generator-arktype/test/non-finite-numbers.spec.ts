/**
 * `NaN` and the two infinities on a Postgres float column, in ArkType output.
 *
 * ArkType, like valibot, already takes both infinities on a bare `number` and refuses only `NaN`.
 * `number.NaN`, `number.Infinity` and `number.NegativeInfinity` are keywords, so the obvious repair
 * is a union of the range with them.
 *
 * It does not work past two branches. Measured on the installed ArkType, and asserted at the top of
 * this file rather than remembered: `(-5 <= number <= 5) | number.NaN` accepts `NaN`, and adding a
 * third branch makes the same type reject it while still *reporting* the NaN branch in `.json`. A
 * bounded `real` needs four branches, so it cannot be spelled that way, and its range moves to a
 * `.narrow` instead. The `numeric` and the unbounded `double precision` stay at two branches and
 * stay in the DSL.
 *
 * Everything here runs the emitted module, which for this generator is the only test worth writing:
 * ArkType parses at import, so an expression it cannot resolve throws and takes down whatever
 * imported the schema.
 */
import { describe, it, expect } from 'vitest';
import { ArkTypeGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { type } from 'arktype';
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
  await new ArkTypeGenerator(analysis).generate({ outDir: dir } as never);
  const file = path.join(dir, `t-${process.pid}-${label}.ts`);
  await fs.rename(path.join(dir, 't.arktype.ts'), file);
  const source = (await fs.readFile(file, 'utf8')).replace(/\s+/g, ' ');
  return { source, module: await import(file) };
}

const accepts = (schema: any, key: string, x: unknown) =>
  !(schema.get(key)(x) instanceof type.errors);

describe('what ArkType does on its own', () => {
  it('takes the infinities on a bare number and refuses NaN', () => {
    const bare = type('number');
    expect(bare(NaN) instanceof type.errors, 'bare number, NaN').toBe(true);
    expect(bare(Infinity) instanceof type.errors, 'bare number, Infinity').toBe(false);
    expect(bare(-Infinity) instanceof type.errors, 'bare number, -Infinity').toBe(false);
  });

  it('drops the NaN branch of a union once a third branch joins it', () => {
    // The measurement the generator is written against. Two branches hold; three do not, and the
    // type still lists the NaN branch in its own json, so this is invisible to anything reading
    // the emitted text or the parsed type instead of running it.
    const two = type('(-5 <= number <= 5) | number.NaN');
    expect(two(NaN) instanceof type.errors, 'two branches').toBe(false);
    const three = type('(-5 <= number <= 5) | number.NaN | number.Infinity');
    expect(three(NaN) instanceof type.errors, 'three branches').toBe(true);
    expect(JSON.stringify(three.json), 'while still claiming the branch').toContain('NaN');
    // The unbounded case is not affected, because ArkType folds a unit branch into the domain it
    // already belongs to: this reduces to two branches on its own.
    const folded = type('number | number.NaN | number.Infinity | number.NegativeInfinity');
    expect(folded(NaN) instanceof type.errors, 'folded to number | NaN').toBe(false);
    expect(folded.json, 'and says so').toEqual(['number', { unit: 'NaN' }]);
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
    // The bounded column carries its range as a narrow; the unbounded one needs nothing but the
    // two-branch union.
    expect(source).toContain("type('number | number.NaN').narrow(");
    expect(source).toContain(`v >= -${PG_FLOAT4_MAX} && v <= ${PG_FLOAT4_MAX}`);
    expect(source).toContain("c_double: 'number | number.NaN'");
    // The insert and update schemas take the same values, since the narrow rides on the Type and
    // the optional marker rides on the key.
    for (const schema of [m.InserttSchema, m.UpdatetSchema]) {
      expect(accepts(schema, 'c_real', NaN)).toBe(true);
      expect(accepts(schema, 'c_real', 1e300)).toBe(false);
      expect(accepts(schema, 'c_double', NaN)).toBe(true);
    }
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
    expect(accepts(m.SelecttSchema, 'n_real', 1e300), 'the narrow still holds').toBe(false);
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
    // Two branches, so it stays in the DSL and the range stays declarative.
    expect(source).toContain(`-${JS_MAX} <= number <= ${JS_MAX} | number.NaN`);
    expect(source, 'no narrow needed').not.toContain('.narrow(');
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
    expect(source).toContain('-2147483648 <= number.integer <= 2147483647');
    expect(source, 'no NaN branch anywhere').not.toContain('number.NaN');
    for (const name of ['c_int', 'm_float']) {
      expect(accepts(m.SelecttSchema, name, NaN), `${name} NaN`).toBe(false);
      expect(accepts(m.SelecttSchema, name, Infinity), `${name} Infinity`).toBe(false);
      expect(accepts(m.SelecttSchema, name, -Infinity), `${name} -Infinity`).toBe(false);
    }
  });
});
