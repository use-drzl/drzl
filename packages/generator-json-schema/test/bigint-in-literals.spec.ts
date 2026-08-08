/**
 * `CHECK (big IN (1, 2))` on a `bigint({ mode: 'bigint' })` column, compiled and run under ajv.
 *
 * A bigint column is a string in a JSON document: `JSON.stringify` throws on a bigint, so this
 * generator already emits `{ type: 'string', pattern: '^-?\\d+$' }` for the bare column. The set
 * has to follow the same wire: `{ enum: [1, 2] }` states numbers, and no serialised row ever
 * holds one, so the select document refused every row. The digit strings are also what keeps a
 * 64 bit member exact: `Number('9223372036854775807')` rounds to 9223372036854775808 the moment
 * it becomes a number.
 *
 * The driver-side ground truth is in `packages/analyzer/test/decimal-modes.spec.ts` and the
 * `PgBigInt53`/`PgBigInt64` arms of `packages/analyzer/src/index.ts`; the digit-string policy for
 * this generator is beside the `bigint` arm in `src/schemas.ts`.
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

/** `bigint({ mode: 'bigint' })` as the analyzer records it: tsType bigint, int64 range. */
const bigB = () =>
  col('big', {
    tsType: 'bigint',
    dbType: 'BIGINT',
    integer: true,
    min: '-9223372036854775808',
    max: '9223372036854775807',
  });

/** `bigint({ mode: 'number' })`: a JS number, which serialises as a JSON number. */
const bigN = () =>
  col('big', {
    tsType: 'number',
    dbType: 'BIGINT',
    integer: true,
    min: '-9007199254740991',
    max: '9007199254740991',
  });

describe('CHECK (big IN (1, 2)) on bigint mode bigint', () => {
  const IN = [{ name: 'big_valid', expression: 'big IN (1, 2)' }];

  it('accepts the digit strings a serialised row holds and rejects the rest, in every mode', () => {
    const s = tableSchemas(table([bigB()], IN));
    for (const [mode, schema] of Object.entries(s)) {
      if (mode === 'components') continue;
      const v = compile(schema);
      expect(v({ big: '1' }), `${mode} '1'`).toBe(true);
      expect(v({ big: '2' }), `${mode} '2'`).toBe(true);
      expect(v({ big: '3' }), `${mode} '3'`).toBe(false);
      // The serialised wire is a string: the number 1 is not a value this column ever renders as.
      expect(v({ big: 1 }), `${mode} number 1`).toBe(false);
    }
  });

  it('still accepts null, which the database does', () => {
    const v = compile(tableSchemas(table([bigB()], IN)).select);
    expect(v({ big: null })).toBe(true);
  });

  it('keeps a 64 bit member exact instead of rounding it', () => {
    const v = compile(
      tableSchemas(table([bigB()], [{ expression: 'big IN (9223372036854775807)' }])).select
    );
    expect(v({ big: '9223372036854775807' })).toBe(true);
    expect(v({ big: '9223372036854775806' })).toBe(false);
    expect(v({ big: '9223372036854775808' })).toBe(false);
  });

  it('produces the same schema the OR fold of it produces', () => {
    const a = tableSchemas(table([bigB()], [{ expression: 'big = 1 OR big = 2' }])).select;
    const b = tableSchemas(table([bigB()], [{ expression: 'big IN (1, 2)' }])).select;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('a single equality on the bigint wire', () => {
  it('CHECK (big = 1) accepts the digit string and rejects the neighbour', () => {
    const v = compile(tableSchemas(table([bigB()], [{ expression: 'big = 1' }])).select);
    expect(v({ big: '1' })).toBe(true);
    expect(v({ big: '2' })).toBe(false);
    expect(v({ big: 1 })).toBe(false);
  });

  it('keeps a 64 bit equality exact', () => {
    const v = compile(
      tableSchemas(table([bigB()], [{ expression: 'big = 9223372036854775807' }])).select
    );
    expect(v({ big: '9223372036854775807' })).toBe(true);
    expect(v({ big: '9223372036854775806' })).toBe(false);
  });
});

describe('bigint mode number keeps its number members', () => {
  it('accepts the numbers a serialised row holds there and refuses a digit string', () => {
    const v = compile(tableSchemas(table([bigN()], [{ expression: 'big IN (1, 2)' }])).select);
    expect(v({ big: 1 })).toBe(true);
    expect(v({ big: 3 })).toBe(false);
    expect(v({ big: '1' })).toBe(false);
  });
});
