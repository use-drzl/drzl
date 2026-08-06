/**
 * `NaN` and the two infinities on a Postgres float column, in TypeBox output.
 *
 * `Type.Number()` refuses all three with no options at all, because TypeBox's number check is
 * `Number.isFinite`, and `minimum`/`maximum` refuse the infinities whatever the numbers are. So a
 * select schema refused three values Postgres stores in the column and returns on SELECT.
 *
 * TypeBox has no `.refine` and no literal that can hold `NaN`: `Type.Literal(NaN)` compares with
 * `===` and `NaN === NaN` is false. What it has is the type registry, which this generator already
 * uses for the character caps, so the branch is a registered kind carrying its own predicate.
 * Both `Value.Check` and `TypeCompiler` honour it, and both are executed here: a registered kind
 * the compiler does not know about is a schema that validates one way interpreted and another way
 * compiled.
 */
import { describe, it, expect } from 'vitest';
import { TypeBoxGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { Value } from '@sinclair/typebox/value';
import { TypeCompiler } from '@sinclair/typebox/compiler';
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
  await new TypeBoxGenerator(analysis).generate({ outDir: dir } as never);
  const file = path.join(dir, `t-${process.pid}-${label}.ts`);
  await fs.rename(path.join(dir, 't.typebox.ts'), file);
  const source = (await fs.readFile(file, 'utf8')).replace(/\s+/g, ' ');
  return { source, module: await import(file) };
}

const accepts = (schema: any, key: string, x: unknown) => Value.Check(schema.properties[key], x);
/** The same question through the compiler, which is a separate implementation of the same check. */
const compiled = (schema: any, key: string, x: unknown) =>
  TypeCompiler.Compile(schema.properties[key]).Check(x);

describe('a postgres real and double precision column', () => {
  it('accepts NaN and both infinities, interpreted and compiled alike', async () => {
    const { module: m, source } = await emit([REAL, DOUBLE], 'floats');
    for (const name of ['c_real', 'c_double']) {
      for (const check of [accepts, compiled]) {
        expect(check(m.SelecttSchema, name, NaN), `${name} NaN`).toBe(true);
        expect(check(m.SelecttSchema, name, Infinity), `${name} Infinity`).toBe(true);
        expect(check(m.SelecttSchema, name, -Infinity), `${name} -Infinity`).toBe(true);
        expect(check(m.SelecttSchema, name, 1.5), `${name} an ordinary number`).toBe(true);
        expect(check(m.SelecttSchema, name, 'x'), `${name} a string`).toBe(false);
        expect(check(m.SelecttSchema, name, null), `${name} null on a NOT NULL column`).toBe(false);
      }
    }
    // The registered kind has to be imported and set up, or the module throws on import. That is
    // the failure mode the shared `tbNeedsCapKind` predicate exists to prevent.
    expect(source).toContain("import { Type, Kind, TypeRegistry } from '@sinclair/typebox'");
    expect(source).toContain("TypeRegistry.Set('DrzlRowCheck'");
    expect(source).toContain("[Kind]: 'DrzlRowCheck'");
    expect(source).toContain('!Number.isFinite(v)');
  });

  it('keeps the magnitude bound the 4 byte column really has', async () => {
    const { module: m } = await emit([REAL, DOUBLE], 'magnitude');
    expect(accepts(m.SelecttSchema, 'c_real', 1e300), 'real at 1e300').toBe(false);
    expect(compiled(m.SelecttSchema, 'c_real', 1e300), 'real at 1e300, compiled').toBe(false);
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
    for (const check of [accepts, compiled]) {
      expect(check(m.SelecttSchema, 'c_numeric_n', NaN)).toBe(true);
      expect(check(m.SelecttSchema, 'c_numeric_n', Infinity)).toBe(false);
      expect(check(m.SelecttSchema, 'c_numeric_n', -Infinity)).toBe(false);
      expect(check(m.SelecttSchema, 'c_numeric_n', 1.5)).toBe(true);
      expect(check(m.SelecttSchema, 'c_numeric_n', 'x')).toBe(false);
      expect(check(m.SelecttSchema, 'c_numeric_n', null)).toBe(false);
    }
    expect(source).toContain('Number.isNaN(v)');
    expect(source, 'no infinity branch').not.toContain('!Number.isFinite(v)');
  });
});

describe('every other number column', () => {
  it('is emitted exactly as before, with no registry entry at all', async () => {
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
    expect(source).toContain('Type.Integer({ minimum: -2147483648, maximum: 2147483647 })');
    expect(source, 'no registered kind').not.toContain('TypeRegistry');
    for (const name of ['c_int', 'm_float']) {
      expect(accepts(m.SelecttSchema, name, NaN), `${name} NaN`).toBe(false);
      expect(accepts(m.SelecttSchema, name, Infinity), `${name} Infinity`).toBe(false);
      expect(accepts(m.SelecttSchema, name, -Infinity), `${name} -Infinity`).toBe(false);
    }
  });
});
