/**
 * The Drizzle v1 column description, read from `dataType` and `codec`.
 *
 * v1 stamps every column with a `dataType` of the form `"<js type> <semantic>"` and a `codec`
 * naming the SQL side. Both are read here instead of the constructor name, which the analyzer
 * matched on before: the class list ran to dozens of names per dialect, drifted between releases,
 * and a miss fell through to a regex that guessed from the name. `PgBinaryVector` is the clearest
 * case against guessing, since it is a bit string and not a vector.
 *
 * Every pair below was taken from a real drizzle-orm 1.0.0-rc.4 column rather than invented, and
 * the parity stage in `scripts/verify-packed.sh` re-measures them against the real thing.
 */
import { describe, it, expect } from 'vitest';
import { describeV1Column } from '../src/index';

/** A column as v1 presents one. `dimensions: 0` is what a scalar carries. */
const col = (dataType: string, codec: string, extra: Record<string, unknown> = {}) => ({
  dataType,
  codec,
  dimensions: 0,
  ...extra,
});

describe('numbers', () => {
  it('bounds each integer width', () => {
    expect(describeV1Column(col('number int16', 'smallint'))).toMatchObject({
      tsType: 'number',
      integer: true,
      min: '-32768',
      max: '32767',
    });
    expect(describeV1Column(col('number int32', 'int'))).toMatchObject({
      min: '-2147483648',
      max: '2147483647',
    });
  });

  it('keeps bigint mode number a number, and bigint mode bigint a bigint', () => {
    // Drizzle names these `PgBigInt53` and `PgBigInt64`. The number mode really does return a JS
    // number, so a schema demanding a bigint there rejects every row.
    expect(describeV1Column(col('number int53', 'bigint:number'))).toMatchObject({
      tsType: 'number',
      max: '9007199254740991',
    });
    expect(describeV1Column(col('bigint int64', 'bigint'))).toMatchObject({
      tsType: 'bigint',
      max: '9223372036854775807',
    });
  });

  it('marks the inexact types as non-integers even though they carry bounds', () => {
    // The generators used to read "declares both bounds" as "is an integer". That held only while
    // integers were the sole bounded type, so stating it outright is the whole point of the flag.
    for (const [dt, codec] of [
      ['number float', 'float4'],
      ['number double', 'float8'],
      ['number', 'numeric:number'],
    ] as const) {
      expect(describeV1Column(col(dt, codec))?.integer, `${dt} should not be an integer`).toBe(
        false
      );
    }
  });

  it('leaves numeric a string, since a JS number cannot hold arbitrary precision', () => {
    expect(describeV1Column(col('string numeric', 'numeric'))).toMatchObject({
      tsType: 'string',
      dbType: 'NUMERIC',
    });
  });
});

describe('structured values', () => {
  it('describes the tuple types by their real arity', () => {
    // These arrive as `[number, number]`. Mapped to a string, as they were, the select schema
    // rejected every row the database returned.
    expect(describeV1Column(col('array point', 'point:tuple'))?.shape).toEqual({
      kind: 'tuple',
      length: 2,
    });
    expect(describeV1Column(col('array line', 'line:tuple'))?.shape).toEqual({
      kind: 'tuple',
      length: 3,
    });
    expect(describeV1Column(col('array geometry', 'geometry(point):tuple'))?.shape).toEqual({
      kind: 'tuple',
      length: 2,
    });
  });

  it('DEFECT: calls the object modes tuples too, and they are objects', () => {
    // `point({ mode: 'xy' })` is `object point` with codec `point` on v1, and hands back
    // `{ x, y }`; `line({ mode: 'abc' })` is `object line` and hands back `{ a, b, c }`. Both
    // reach the same `case 'point'` and `case 'line'` arms above and come back as tuples, so a v1
    // select schema for either rejects every row the driver returns. That is the same class of
    // defect as typing a `point` as a string was, and it is worse than 0.4x's answer rather than
    // better: 0.4x calls them strings, which is also wrong.
    //
    // Filed rather than fixed. Describing `{ x, y }` needs a `ColumnShape` no generator has, and
    // no fixture in either parity pass carries an object-mode column, so there is no gate to turn
    // red first. Pinned here so a change to those arms has to say what it did to these two: the
    // 0.4x half is pinned in floats-and-tuples-0.4x.spec.ts and this is the v1 half, which had
    // none.
    expect(describeV1Column(col('object point', 'point'))?.shape).toEqual({
      kind: 'tuple',
      length: 2,
    });
    expect(describeV1Column(col('object line', 'line'))?.shape).toEqual({
      kind: 'tuple',
      length: 3,
    });
    expect(describeV1Column(col('object point', 'point'))?.tsType).toBe('[number, number]');
  });

  it('carries the declared width of a vector and a bit string', () => {
    expect(describeV1Column(col('array vector', 'vector', { length: 3 }))?.shape).toEqual({
      kind: 'numberVector',
      length: 3,
    });
    // `bit(3)`, which the dataType calls "binary" and the class calls `PgBinaryVector`, is a
    // string of '0' and '1' rather than anything vector shaped.
    expect(describeV1Column(col('string binary', 'bit', { length: 3 }))).toMatchObject({
      tsType: 'string',
      shape: { kind: 'bitstring', length: 3 },
    });
  });

  it('describes json and bytea by shape rather than as any/unknown', () => {
    expect(describeV1Column(col('object json', 'jsonb'))).toMatchObject({
      dbType: 'JSONB',
      shape: { kind: 'json' },
    });
    expect(describeV1Column(col('object buffer', 'bytea'))?.shape).toEqual({ kind: 'buffer' });
  });
});

describe('arrays', () => {
  it('reads a positive dimension as an array of the element type', () => {
    // Drizzle gives an array no class of its own: `text().array()` is still a `PgText`, and only
    // `dimensions` distinguishes it. The element description has to survive.
    const d = describeV1Column(col('number int32', 'int', { dimensions: 1 }));
    expect(d).toMatchObject({ tsType: 'number', arrayDimensions: 1, min: '-2147483648' });
  });

  it('does not treat a sized array as an array', () => {
    // `.array(3)` sets a size rather than a dimension, and Drizzle itself treats the result as a
    // scalar: `drizzle-orm/zod` emits `number` for it, not `number[]`.
    expect(
      describeV1Column(col('number int32', 'int', { dimensions: null }))?.arrayDimensions
    ).toBe(undefined);
    expect(describeV1Column(col('number int32', 'int'))?.arrayDimensions).toBe(undefined);
  });
});

describe('when it declines to answer', () => {
  it('returns null on a 0.4x column, which carries no codec', () => {
    // The class-name mapping stays in place for those, so an older schema is unaffected.
    expect(describeV1Column({ dataType: 'string' })).toBe(null);
    expect(describeV1Column({})).toBe(null);
  });

  it('returns null for a js type it does not model, rather than inventing one', () => {
    // A wrong scalar rejects rows; falling back to the class name only risks failing to catch
    // them, which is the safer of the two.
    expect(describeV1Column(col('symbol whatever', 'newthing'))).toBe(null);
  });
});
