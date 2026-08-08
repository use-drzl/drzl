/**
 * CHECK literals reconciled with the column's wire, Effect half of addendum BL.
 *
 * Ground truth and the measurement table live in the zod twin,
 * `packages/generator-zod/test/numeric-wire-literals.spec.ts`: a `numeric(10,2)` returns '1.00'
 * for a stored 1 and the database compares scale insensitively, so `Schema.Literal(1, 2)`
 * rejected every returned row, and `Schema.Literal("1", "2")` on a bigint wire rejected every
 * `1n`. The canonical compare is a `Schema.filter` over the emitted `DrzlNumericCanon`, the
 * same vehicle the character caps use.
 */
import { describe, it, expect } from 'vitest';
import * as Schema from 'effect/Schema';
import * as Either from 'effect/Either';
import { EffectGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const RUN = (schema: any, input: unknown) =>
  Either.isRight(Schema.decodeUnknownEither(schema as Schema.Schema<unknown>)(input));

const col = (name: string, over: Partial<Column> = {}): Column =>
  ({
    name,
    tsType: 'string',
    dbType: 'TEXT',
    nullable: true,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

const numS2 = (name = 'n') =>
  col(name, {
    tsType: 'string',
    dbType: 'NUMERIC',
    format: 'numeric',
    integer: false,
    min: '-99999999.99',
    max: '99999999.99',
  });
const numBare = (name = 'n') =>
  col(name, { tsType: 'string', dbType: 'NUMERIC', format: 'numeric' });
const bigB = (name = 'big') =>
  col(name, {
    tsType: 'bigint',
    dbType: 'BIGINT',
    integer: true,
    min: '-9223372036854775808',
    max: '9223372036854775807',
  });
const intC = (name = 'age') =>
  col(name, {
    tsType: 'number',
    dbType: 'INTEGER',
    integer: true,
    min: '-2147483648',
    max: '2147483647',
  });

let seq = 0;

async function emit(
  columns: Column[],
  checks: { name?: string; expression?: string }[]
): Promise<{ modules: Record<string, any>; text: string }> {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-numeric-wire');
  await fs.mkdir(dir, { recursive: true });
  await new EffectGenerator(analysis).generate({ outDir: dir } as never);
  const text = await fs.readFile(path.join(dir, 't.effect.ts'), 'utf8');
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.effect.ts'), file);
  return { modules: await import(file), text };
}

describe('CHECK (n IN (1, 2)) on the numeric string wire', () => {
  const IN = [{ name: 'n_valid', expression: 'n IN (1, 2)' }];

  it('accepts every driver spelling of an admitted value and rejects the rest, in every mode', async () => {
    const { modules: m } = await emit([numS2()], IN);
    for (const s of ['SelecttSchema', 'InserttSchema', 'UpdatetSchema']) {
      expect(RUN(m[s], { n: '1.00' }), `${s} '1.00'`).toBe(true);
      expect(RUN(m[s], { n: '2.00' }), `${s} '2.00'`).toBe(true);
      expect(RUN(m[s], { n: '1' }), `${s} '1'`).toBe(true);
      expect(RUN(m[s], { n: '1.000000' }), `${s} '1.000000'`).toBe(true);
      expect(RUN(m[s], { n: '3' }), `${s} '3'`).toBe(false);
      expect(RUN(m[s], { n: '3.00' }), `${s} '3.00'`).toBe(false);
      expect(RUN(m[s], { n: '1.5' }), `${s} '1.5'`).toBe(false);
      expect(RUN(m[s], { n: 1 }), `${s} number 1`).toBe(false);
      expect(RUN(m[s], { n: 'NaN' }), `${s} 'NaN'`).toBe(false);
    }
  });

  it('still accepts NULL, which the database does', async () => {
    const { modules: m } = await emit([numS2()], IN);
    expect(RUN(m.SelecttSchema, { n: null })).toBe(true);
  });

  it('keeps a 20 digit member exact instead of rounding it through a double', async () => {
    const { modules: m } = await emit(
      [numBare()],
      [{ expression: 'n IN (99999999999999999999)' }]
    );
    expect(RUN(m.SelecttSchema, { n: '99999999999999999999' })).toBe(true);
    expect(RUN(m.SelecttSchema, { n: '99999999999999999998' })).toBe(false);
  });
});

describe('the OR fold of the same constraint', () => {
  it('emits byte for byte what the IN list it means emits', async () => {
    const a = await emit([numS2()], [{ name: 'n_valid', expression: 'n = 1 OR n = 2' }]);
    const b = await emit([numS2()], [{ name: 'n_valid', expression: 'n IN (1, 2)' }]);
    expect(a.text).toBe(b.text);
  });
});

describe('equality and inequality on the numeric string wire', () => {
  it('CHECK (n = 1) accepts the scale padded return and rejects 2', async () => {
    const { modules: m } = await emit([numS2()], [{ expression: 'n = 1' }]);
    expect(RUN(m.SelecttSchema, { n: '1.00' })).toBe(true);
    expect(RUN(m.SelecttSchema, { n: '1' })).toBe(true);
    expect(RUN(m.SelecttSchema, { n: '2.00' })).toBe(false);
  });

  it('CHECK (n <> 1) rejects every spelling of 1 and accepts 2', async () => {
    const { modules: m } = await emit([numS2()], [{ expression: 'n <> 1' }]);
    expect(RUN(m.SelecttSchema, { n: '1.00' })).toBe(false);
    expect(RUN(m.SelecttSchema, { n: '1' })).toBe(false);
    expect(RUN(m.SelecttSchema, { n: '2.00' })).toBe(true);
  });
});

describe('quoted literals on the wrong wires', () => {
  it("CHECK (big IN ('1', '2')) accepts the bigints the driver returns", async () => {
    const { modules: m } = await emit([bigB()], [{ expression: "big IN ('1', '2')" }]);
    expect(RUN(m.SelecttSchema, { big: 1n })).toBe(true);
    expect(RUN(m.SelecttSchema, { big: 2n })).toBe(true);
    expect(RUN(m.SelecttSchema, { big: 3n })).toBe(false);
    expect(RUN(m.SelecttSchema, { big: '1' })).toBe(false);
  });

  it("CHECK (big = '1') accepts 1n and rejects 2n", async () => {
    const { modules: m } = await emit([bigB()], [{ expression: "big = '1'" }]);
    expect(RUN(m.SelecttSchema, { big: 1n })).toBe(true);
    expect(RUN(m.SelecttSchema, { big: 2n })).toBe(false);
  });

  it("CHECK (age IN ('18')) accepts the number 18 the driver returns", async () => {
    const { modules: m } = await emit([intC()], [{ expression: "age IN ('18')" }]);
    expect(RUN(m.SelecttSchema, { age: 18 })).toBe(true);
    expect(RUN(m.SelecttSchema, { age: 19 })).toBe(false);
    expect(RUN(m.SelecttSchema, { age: '18' })).toBe(false);
  });
});

describe('members no exact compare can state fall back to leniency', () => {
  it("CHECK (n IN ('1e3', '2')) enforces nothing rather than rejecting admitted rows", async () => {
    const { modules: m } = await emit([numBare()], [{ expression: "n IN ('1e3', '2')" }]);
    expect(RUN(m.SelecttSchema, { n: '1000' })).toBe(true);
    expect(RUN(m.SelecttSchema, { n: '7' })).toBe(true);
    expect(RUN(m.SelecttSchema, { n: 'hello' })).toBe(false);
  });

  it('CHECK (s IN (1, 2)) on a text wire enforces nothing rather than rejecting rows', async () => {
    const { modules: m } = await emit([col('s')], [{ expression: 's IN (1, 2)' }]);
    expect(RUN(m.SelecttSchema, { s: '1.00' })).toBe(true);
    expect(RUN(m.SelecttSchema, { s: 'x' })).toBe(true);
  });
});

describe('ranges on the numeric string wire', () => {
  it('CHECK (n >= 1) compares numerically and is spelled type clean', async () => {
    const { modules: m, text } = await emit([numS2()], [{ expression: 'n >= 1' }]);
    expect(RUN(m.SelecttSchema, { n: '1.00' })).toBe(true);
    expect(RUN(m.SelecttSchema, { n: '0.99' })).toBe(false);
    expect(text).toContain('Number(');
  });
});

describe('what the emitted module carries', () => {
  it('emits the canonical helper once, and only where a column needs it', async () => {
    const a = await emit([numS2()], [{ name: 'n_valid', expression: 'n IN (1, 2)' }]);
    expect(a.text).toContain('DrzlNumericCanon');
    expect(a.text.split('const DrzlNumericCanon').length).toBe(2);
    const b = await emit([intC()], [{ expression: 'age IN (18, 21)' }]);
    expect(b.text).not.toContain('DrzlNumericCanon');
  });
});
