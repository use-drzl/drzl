/**
 * CHECK literals reconciled with the column's wire, JSON Schema half of addendum BL.
 *
 * Ground truth and the measurement table live in the zod twin,
 * `packages/generator-zod/test/numeric-wire-literals.spec.ts`. In a JSON document a numeric
 * column is the driver's string, spelled by its declared scale, so `{ enum: [1, 2] }` refused
 * every serialised row and `{ enum: ['1', '2'] }` would refuse the '1.00' a `numeric(10,2)`
 * returns.
 *
 * A JSON Schema cannot run a function, so the canonical compare becomes a `pattern`: one
 * alternation, each branch accepting exactly the spellings that canonicalise to one member
 * (optional plus sign, leading integer zeros, trailing fraction zeros, a bare trailing dot).
 * That is the honest cost of this format: the document stays ajv strict valid and exact, and
 * what it gives up is readability of the regex, not admitted rows. On a bigint string wire the
 * fraction tail is left off, because '1.0' is not valid bigint input to Postgres, measured.
 */
import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { Column, Table } from '@drzl/analyzer';
import { tableSchemas } from '../src/index';

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

const table = (columns: Column[], checks: { name?: string; expression?: string }[] = []): Table =>
  ({ name: 't', tsName: 't', columns, unique: [], indexes: [], checks }) as never;

function compile(schema: unknown) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv as never);
  return ajv.compile(schema as never);
}

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
const bigS = (name = 'big') => col(name, { tsType: 'string', dbType: 'BIGINT' });
const intC = (name = 'age') =>
  col(name, {
    tsType: 'number',
    dbType: 'INTEGER',
    integer: true,
    min: '-2147483648',
    max: '2147483647',
  });

describe('CHECK (n IN (1, 2)) on the numeric string wire', () => {
  const IN = [{ name: 'n_valid', expression: 'n IN (1, 2)' }];

  it('accepts every driver spelling of an admitted value and rejects the rest, in every mode', () => {
    const s = tableSchemas(table([numS2()], IN));
    for (const [mode, schema] of Object.entries(s)) {
      if (mode === 'components') continue;
      const v = compile(schema);
      expect(v({ n: '1.00' }), `${mode} '1.00'`).toBe(true);
      expect(v({ n: '2.00' }), `${mode} '2.00'`).toBe(true);
      expect(v({ n: '1' }), `${mode} '1'`).toBe(true);
      expect(v({ n: '1.000000' }), `${mode} '1.000000'`).toBe(true);
      expect(v({ n: '3' }), `${mode} '3'`).toBe(false);
      expect(v({ n: '3.00' }), `${mode} '3.00'`).toBe(false);
      expect(v({ n: '1.5' }), `${mode} '1.5'`).toBe(false);
      expect(v({ n: 1 }), `${mode} number 1`).toBe(false);
      expect(v({ n: 'NaN' }), `${mode} 'NaN'`).toBe(false);
      expect(v({ n: null }), `${mode} null`).toBe(true);
    }
  });

  it('keeps a 20 digit member exact instead of rounding it through a double', () => {
    const s = tableSchemas(table([numBare()], [{ expression: 'n IN (99999999999999999999)' }]));
    const v = compile(s.select);
    expect(v({ n: '99999999999999999999' })).toBe(true);
    expect(v({ n: '99999999999999999998' })).toBe(false);
  });

  it('stays ajv strict valid on the openapi target too', () => {
    const s = tableSchemas(table([numS2()], IN), { target: 'openapi-3.0' } as never);
    expect(JSON.stringify(s.select)).toContain('pattern');
  });
});

describe('equality on the numeric string wire', () => {
  it('CHECK (n = 1) accepts the scale padded return and rejects 2', () => {
    const s = tableSchemas(table([numS2()], [{ expression: 'n = 1' }]));
    const v = compile(s.select);
    expect(v({ n: '1.00' })).toBe(true);
    expect(v({ n: '1' })).toBe(true);
    expect(v({ n: '2.00' })).toBe(false);
  });

  it('CHECK (n <> 1) refuses every spelling of the excluded value, not just one', () => {
    // This generator stated no inequality in any wire until the CHECK fixture grew one and the
    // gate caught it. On this wire a literal exclusion would enforce almost nothing, because the
    // driver spells a stored 1 by declared scale: excluding "1" would still admit "1.00". So the
    // exclusion is a `not: { pattern }` over the canonical spellings, which is the same shape the
    // `IN` branch above uses and refuses all of them.
    const s = tableSchemas(table([numS2()], [{ expression: 'n <> 1' }]));
    const v = compile(s.select);
    expect(v({ n: '1' }), "'1'").toBe(false);
    expect(v({ n: '1.00' }), "'1.00'").toBe(false);
    expect(v({ n: '1.000000' }), "'1.000000'").toBe(false);
    expect(v({ n: '2.00' }), "'2.00'").toBe(true);
    // Null is untouched: SQL never applied the comparison, so neither does this.
    expect(v({ n: null }), 'null').toBe(true);
  });
});

describe('quoted literals on the wrong wires', () => {
  it("CHECK (big IN ('1', '2')) keeps the digit strings a serialised bigint row holds", () => {
    const s = tableSchemas(table([bigB()], [{ expression: "big IN ('1', '2')" }]));
    const v = compile(s.select);
    expect(v({ big: '1' })).toBe(true);
    expect(v({ big: '2' })).toBe(true);
    expect(v({ big: '3' })).toBe(false);
    expect(v({ big: 1 })).toBe(false);
  });

  it("CHECK (age IN ('18')) accepts the serialised number 18", () => {
    const s = tableSchemas(table([intC()], [{ expression: "age IN ('18')" }]));
    const v = compile(s.select);
    expect(v({ age: 18 })).toBe(true);
    expect(v({ age: 19 })).toBe(false);
    expect(v({ age: '18' })).toBe(false);
  });

  it("CHECK (age = '18') pins the serialised number", () => {
    const s = tableSchemas(table([intC()], [{ expression: "age = '18'" }]));
    const v = compile(s.select);
    expect(v({ age: 18 })).toBe(true);
    expect(v({ age: 19 })).toBe(false);
  });
});

describe('the v1 bigint mode string wire', () => {
  it('CHECK (big IN (1, 2)) accepts the digit strings the driver returns', () => {
    const s = tableSchemas(table([bigS()], [{ expression: 'big IN (1, 2)' }]));
    const v = compile(s.select);
    expect(v({ big: '1' })).toBe(true);
    expect(v({ big: '2' })).toBe(true);
    expect(v({ big: '3' })).toBe(false);
    // No fraction tail on this wire: '1.0' is not valid bigint input to Postgres.
    expect(v({ big: '1.0' })).toBe(false);
  });
});

describe('members no exact compare can state fall back to leniency', () => {
  it("CHECK (n IN ('1e3', '2')) enforces nothing rather than rejecting admitted rows", () => {
    const s = tableSchemas(table([numBare()], [{ expression: "n IN ('1e3', '2')" }]));
    const v = compile(s.select);
    expect(v({ n: '1000' })).toBe(true);
    expect(v({ n: '7' })).toBe(true);
    expect(v({ n: 'hello' })).toBe(false);
  });

  it('CHECK (s IN (1, 2)) on a text wire enforces nothing rather than rejecting rows', () => {
    const s = tableSchemas(table([col('s')], [{ expression: 's IN (1, 2)' }]));
    const v = compile(s.select);
    expect(v({ s: '1.00' })).toBe(true);
    expect(v({ s: 'x' })).toBe(true);
  });
});
