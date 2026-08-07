/**
 * `NaN` through ArkType's optional and nullable arms, on a column that stores no `NaN`.
 *
 * A sibling of `non-finite-numbers.spec.ts` and the other half of the same question. That file
 * asks what a Postgres `real` must *accept*; this one asks what a MySQL `float` must refuse, and
 * the answer differs only because the arbiter is a different database. Measured against a real
 * MySQL 8.4: `float` and `double` refuse `NaN` outright and `decimal(10,2)` silently writes
 * `0.00`, so MySQL stores no `NaN` in any numeric column. The analyzer says exactly this by
 * leaving `allowsNaN` off, and it is the only thing that separates the two dialects here.
 *
 * The mechanism, asserted at the top of this file rather than remembered: a *bounded* ArkType
 * number stops refusing `NaN` the moment it becomes a branch of a union beside a unit. Both arms
 * this generator emits are such a union. `| null` for a nullable column is one, visible on the
 * object itself. The `?` on an optional key is the other, visible through `schema.get(key)`, which
 * is how the packed gate takes a schema apart into one type per column.
 *
 * `number.integer` is not affected, because integrality is a real predicate and `NaN` fails it,
 * so nothing is spent on the integer columns.
 *
 * Everything below runs the emitted module. The union defect already recorded on `atNumberPlan`
 * is a branch that `.json` still lists and the schema then rejects, so reading the emitted text or
 * the parsed type proves nothing here.
 */
import { describe, it, expect } from 'vitest';
import { ArkTypeGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { type } from 'arktype';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** What the analyzer really emits for each of these, read off a run rather than invented. */
const MYSQL_FLOAT_MAX = '340282346638528859811704183484516925440';
const PG_FLOAT4_MAX = '340282356779733661637539395458142568448';

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

// MySQL. `float` carries a range and no `allowsNaN`; `double` and `real` carry neither.
const MYSQL = [
  col('m_float', { dbType: 'REAL', min: `-${MYSQL_FLOAT_MAX}`, max: MYSQL_FLOAT_MAX }),
  col('m_n_float', {
    dbType: 'REAL',
    min: `-${MYSQL_FLOAT_MAX}`,
    max: MYSQL_FLOAT_MAX,
    nullable: true,
  }),
  col('m_double', { dbType: 'DOUBLE' }),
  col('m_n_double', { dbType: 'DOUBLE', nullable: true }),
  col('m_int', { dbType: 'INTEGER', integer: true, min: '-2147483648', max: '2147483647' }),
  col('m_n_int', {
    dbType: 'INTEGER',
    integer: true,
    min: '-2147483648',
    max: '2147483647',
    nullable: true,
  }),
];

// Postgres. Both widths store all three and hand them back, which is what `allowsNaN` says.
const POSTGRES = [
  col('c_real', {
    dbType: 'REAL',
    min: `-${PG_FLOAT4_MAX}`,
    max: PG_FLOAT4_MAX,
    allowsNaN: true,
    allowsInfinity: true,
  }),
  col('n_real', {
    dbType: 'REAL',
    min: `-${PG_FLOAT4_MAX}`,
    max: PG_FLOAT4_MAX,
    allowsNaN: true,
    allowsInfinity: true,
    nullable: true,
  }),
  col('c_double', { dbType: 'DOUBLE', allowsNaN: true, allowsInfinity: true }),
  col('n_double', { dbType: 'DOUBLE', allowsNaN: true, allowsInfinity: true, nullable: true }),
];

async function emit(dialect: string, columns: Column[], label: string, opts: object = {}) {
  const analysis: Analysis = {
    dialect,
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks: [] }] as never,
    enums: [],
    relations: [],
    issues: [],
  } as never;
  const dir = path.join(__dirname, '.tmp-nan-arm');
  await fs.mkdir(dir, { recursive: true });
  await new ArkTypeGenerator(analysis).generate({ outDir: dir, ...opts } as never);
  const file = path.join(dir, `t-${process.pid}-${label}.ts`);
  await fs.rename(path.join(dir, 't.arktype.ts'), file);
  const source = (await fs.readFile(file, 'utf8')).replace(/\s+/g, ' ');
  return { source, module: await import(file) };
}

/**
 * One column of one schema, as the packed gate takes it: `schema.get(key)`, which is where an
 * optional key becomes a union with `undefined` and where this defect is visible at all.
 */
const field = (schema: any, key: string, x: unknown) =>
  !(schema.get(key)(x) instanceof type.errors);

/**
 * The same column through the whole object, which is where the nullable arm shows the same leak.
 *
 * Every other column is filled with a value it accepts, because a select schema demands them all
 * and a row missing one fails for a reason that has nothing to do with the column under test.
 */
const rowOf =
  (base: Record<string, unknown>) =>
  (schema: any, key: string, x: unknown): boolean =>
    !(schema({ ...base, [key]: x }) instanceof type.errors);

const MODES = ['Select', 'Insert', 'Update'] as const;

describe('what ArkType does on its own', () => {
  it('stops refusing NaN once a bounded number joins a union with a unit', () => {
    const R = `-${MYSQL_FLOAT_MAX} <= number <= ${MYSQL_FLOAT_MAX}`;
    const required = type({ m: R });
    expect(required({ m: NaN }) instanceof type.errors, 'required key, on the object').toBe(true);
    expect(required.get('m')(NaN) instanceof type.errors, 'required key, on the field').toBe(true);

    // The optional arm. The object still refuses it, so nothing that parses a whole row sees this;
    // the field pulled out of the schema does not.
    const optional = type({ 'm?': R });
    expect(optional({ m: NaN }) instanceof type.errors, 'optional key, on the object').toBe(true);
    expect(optional.get('m')(NaN) instanceof type.errors, 'optional key, on the field').toBe(false);

    // The nullable arm, which leaks on the object too.
    const nullable = type({ m: `(${R} | null)` });
    expect(nullable({ m: NaN }) instanceof type.errors, 'nullable, on the object').toBe(false);

    // It is `NaN` alone. An infinity fails the bound in a union exactly as it does outside one,
    // because only `NaN` compares false against both ends.
    expect(nullable({ m: Infinity }) instanceof type.errors, 'nullable, Infinity').toBe(true);
    expect(nullable({ m: 1e300 }) instanceof type.errors, 'nullable, out of range').toBe(true);

    // And integrality is a predicate rather than a comparison, so an integer column is untouched.
    const int = type({ m: '(-2147483648 <= number.integer <= 2147483647 | null)' });
    expect(int({ m: NaN }) instanceof type.errors, 'integer, nullable').toBe(true);
    expect(type({ 'm?': 'number.integer' }).get('m')(NaN) instanceof type.errors).toBe(true);
  });
});

const MYSQL_ROW = {
  m_float: 1.5,
  m_n_float: 1.5,
  m_double: 1.5,
  m_n_double: 1.5,
  m_int: 7,
  m_n_int: 7,
};
const PG_ROW = { c_real: 1.5, n_real: 1.5, c_double: 1.5, n_double: 1.5 };

describe('a mysql float and double column', () => {
  const row = rowOf(MYSQL_ROW);

  // Collected rather than asserted one at a time, because the interesting number is how many of
  // the twenty four combinations leak, and a bare `expect` stops at the first.
  it('refuses NaN in every mode, on the field and on the row', async () => {
    const { module: m } = await emit('mysql', MYSQL, 'mysql-nan');
    const leaks: string[] = [];
    for (const mode of MODES) {
      const s = m[`${mode}tSchema`];
      expect(row(s, 'm_float', 1.5), `${mode} the baseline row is accepted`).toBe(true);
      for (const name of ['m_float', 'm_n_float', 'm_double', 'm_n_double']) {
        if (field(s, name, NaN)) leaks.push(`${mode} ${name} field`);
        if (row(s, name, NaN)) leaks.push(`${mode} ${name} row`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('refuses both infinities wherever a bound can hold them back', async () => {
    const { module: m } = await emit('mysql', MYSQL, 'mysql-inf');
    for (const mode of MODES) {
      const s = m[`${mode}tSchema`];
      // `float` carries MySQL's own range, so the bound refuses an infinity by itself.
      for (const name of ['m_float', 'm_n_float']) {
        expect(field(s, name, Infinity), `${mode} ${name} Infinity`).toBe(false);
        expect(field(s, name, -Infinity), `${mode} ${name} -Infinity`).toBe(false);
        expect(field(s, name, 1e300), `${mode} ${name} out of range`).toBe(false);
      }
    }
  });

  it('still takes an ordinary number and still refuses a string and a bare null', async () => {
    const { module: m } = await emit('mysql', MYSQL, 'mysql-ordinary');
    for (const mode of MODES) {
      const s = m[`${mode}tSchema`];
      for (const name of ['m_float', 'm_n_float', 'm_double', 'm_n_double']) {
        expect(field(s, name, 1.5), `${mode} ${name} 1.5`).toBe(true);
        expect(field(s, name, 0), `${mode} ${name} 0`).toBe(true);
        expect(field(s, name, 'x'), `${mode} ${name} a string`).toBe(false);
      }
      for (const name of ['m_float', 'm_double']) {
        expect(field(s, name, null), `${mode} ${name} null on NOT NULL`).toBe(false);
        expect(row(s, name, null), `${mode} ${name} null on NOT NULL, row`).toBe(false);
      }
      for (const name of ['m_n_float', 'm_n_double']) {
        expect(field(s, name, null), `${mode} ${name} null on a nullable column`).toBe(true);
      }
      // An integer column keeps refusing a fraction and its own out-of-range value.
      expect(field(s, 'm_int', 1.5), `${mode} m_int 1.5`).toBe(false);
      expect(field(s, 'm_int', 2147483648), `${mode} m_int out of range`).toBe(false);
      expect(field(s, 'm_int', 7), `${mode} m_int 7`).toBe(true);
      expect(field(s, 'm_int', NaN), `${mode} m_int NaN`).toBe(false);
      expect(field(s, 'm_n_int', NaN), `${mode} m_n_int NaN`).toBe(false);
    }
  });

  it('spends nothing on the integer columns, which refuse NaN by themselves', async () => {
    const { source } = await emit('mysql', MYSQL, 'mysql-cost');
    // `number.integer` is a predicate and holds inside a union, so no integer column carries the
    // narrow. Anything else is bytes in the consumer's bundle for a verdict already reached.
    expect(source, 'm_int stays a plain DSL string').toContain(
      `m_int: '-2147483648 <= number.integer <= 2147483647'`
    );
    expect(source, 'and so does the nullable one').toContain(
      `m_n_int: '(-2147483648 <= number.integer <= 2147483647 | null)'`
    );
    // One narrow per leaking arm and not one per column: a NOT NULL float is a union arm only in
    // update, where every key is optional, while a nullable one is one in all three modes. Two
    // NOT NULL floats at one mode each and two nullable ones at three.
    expect(source.match(/Number\.isNaN/g)?.length ?? 0, 'one narrow per leaking arm').toBe(8);
  });
});

describe('the two wrappers the narrow has to survive', () => {
  // Neither shape occurs on MySQL, which has no array column, but `atNanNarrow` is written against
  // the column rather than the dialect and both paths change with it: the array walk is a
  // different predicate and an applied default moves off the DSL and onto the Type the moment the
  // field carries any narrow at all.
  const ARRAY = col('a_float', {
    dbType: 'REAL',
    min: `-${MYSQL_FLOAT_MAX}`,
    max: MYSQL_FLOAT_MAX,
    arrayDimensions: 1,
    nullable: true,
  });
  const DEFAULTED = col('d_float', {
    dbType: 'REAL',
    min: `-${MYSQL_FLOAT_MAX}`,
    max: MYSQL_FLOAT_MAX,
    nullable: true,
    hasDefault: true,
    defaultValue: 1.5,
  });

  it('reaches into an array and still refuses NaN element by element', async () => {
    const { module: m } = await emit('mysql', [ARRAY], 'array');
    for (const mode of MODES) {
      const s = m[`${mode}tSchema`];
      expect(field(s, 'a_float', [1.5, 0]), `${mode} ordinary elements`).toBe(true);
      expect(field(s, 'a_float', []), `${mode} an empty list`).toBe(true);
      expect(field(s, 'a_float', null), `${mode} the nullable list itself`).toBe(true);
      expect(field(s, 'a_float', [1.5, NaN]), `${mode} a NaN element`).toBe(false);
      expect(field(s, 'a_float', [1e300]), `${mode} an out-of-range element`).toBe(false);
      expect(field(s, 'a_float', NaN), `${mode} a bare element`).toBe(false);
    }
  });

  it('keeps an applied default, which the narrow pushes onto the Type', async () => {
    const { module: m, source } = await emit('mysql', [DEFAULTED], 'defaulted', {
      applyDefaults: true,
    });
    expect(source, 'the default rides on the builder beside the narrow').toContain('.default(1.5)');
    // The default is what an absent key becomes, and the narrow still holds for a present one.
    const filled = m.InserttSchema({});
    expect(filled instanceof type.errors, 'an empty insert').toBe(false);
    expect(filled.d_float).toBe(1.5);
    expect(field(m.InserttSchema, 'd_float', NaN), 'insert NaN').toBe(false);
    expect(field(m.UpdatetSchema, 'd_float', NaN), 'update NaN').toBe(false);
    expect(field(m.SelecttSchema, 'd_float', NaN), 'select NaN').toBe(false);
    expect(field(m.InserttSchema, 'd_float', 1.5), 'insert an ordinary number').toBe(true);
  });
});

describe('a postgres real and double precision column', () => {
  const row = rowOf(PG_ROW);

  it('still accepts NaN and both infinities in every mode, nullable or not', async () => {
    const { module: m } = await emit('postgres', POSTGRES, 'pg-nan');
    for (const mode of MODES) {
      const s = m[`${mode}tSchema`];
      for (const name of ['c_real', 'n_real', 'c_double', 'n_double']) {
        expect(field(s, name, NaN), `${mode} ${name} NaN`).toBe(true);
        expect(field(s, name, Infinity), `${mode} ${name} Infinity`).toBe(true);
        expect(field(s, name, -Infinity), `${mode} ${name} -Infinity`).toBe(true);
        expect(field(s, name, 1.5), `${mode} ${name} 1.5`).toBe(true);
        expect(field(s, name, 0), `${mode} ${name} 0`).toBe(true);
        expect(field(s, name, 'x'), `${mode} ${name} a string`).toBe(false);
        expect(row(s, name, NaN), `${mode} ${name} NaN, row`).toBe(true);
      }
      // The 4 byte column keeps the magnitude bound it really has, and the 8 byte one does not.
      expect(field(s, 'c_real', 1e300), `${mode} c_real at 1e300`).toBe(false);
      expect(field(s, 'c_double', 1e300), `${mode} c_double at 1e300`).toBe(true);
      expect(field(s, 'c_real', null), `${mode} c_real null on NOT NULL`).toBe(false);
      expect(field(s, 'n_real', null), `${mode} n_real null`).toBe(true);
    }
  });

  it('carries no NaN narrow, because the column really does store one', async () => {
    const { source } = await emit('postgres', POSTGRES, 'pg-cost');
    expect(source, 'nothing refuses NaN on a postgres float').not.toContain('Number.isNaN');
    expect(source).toContain(`c_double: 'number | number.NaN'`);
  });
});
