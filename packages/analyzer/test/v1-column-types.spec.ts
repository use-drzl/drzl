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

  it('types bigint mode string by the string the driver returns', () => {
    // `bigint({ mode: 'string' })` stamps `string int64` with codec `bigint:string` on pg and
    // mysql, measured off real 1.0.0-rc.4 columns (`PgBigIntString`, `MySqlBigIntString`). The
    // driver really returns a string there: the `bigint:string` codec casts the column to text on
    // the wire and registers no normalize, so the text passes through untouched, and a live read
    // through PGlite on the same rc hands back `'123'` and `'9223372036854775807'` as JS strings.
    // The int64 arm keyed only on `js === 'bigint'`, so this shape came back `tsType: 'number'`
    // and every generated select schema rejected every row the column returns.
    expect(describeV1Column(col('string int64', 'bigint:string'))).toMatchObject({
      tsType: 'string',
      dbType: 'BIGINT',
    });
    // SingleStore states the same dataType and no codec at all, measured on a real
    // `singlestoreTable`; the semantic half alone must be enough, as it is for its float.
    expect(describeV1Column({ dataType: 'string int64', dimensions: 0 })).toMatchObject({
      tsType: 'string',
      dbType: 'BIGINT',
    });
    // No numeric facts on the string shape, deliberately, mirroring `string numeric` above:
    // `isIntegerColumn` reads "min and max both present" as an integer column, and the string
    // arms of the generators state no numeric facts to begin with. The digits-and-range
    // tightening is a recorded follow-up, not this shape.
    const d = describeV1Column(col('string int64', 'bigint:string'));
    expect(d?.min).toBeUndefined();
    expect(d?.max).toBeUndefined();
    expect(d?.integer).toBeUndefined();
    // The element description survives an array dimension, as every other element type does.
    expect(describeV1Column(col('string int64', 'bigint:string', { dimensions: 1 }))).toMatchObject(
      {
        tsType: 'string',
        arrayDimensions: 1,
      }
    );
  });

  it('takes the 4 byte float bound from the codec, because the two databases differ', () => {
    // Postgres refuses a `real` past 3.4028235677973366e38 and MySQL refuses a `FLOAT` past
    // 3.4028234663852886e38, both bisected against a real server, so one bound for `number float`
    // would be wrong on one of them. The codec is what tells them apart on v1, and the answer has
    // to match what the class-name table gives the same column on 0.4x or the cross-major diff in
    // verify-packed.sh fails.
    expect(describeV1Column(col('number float', 'float4'))).toMatchObject({
      min: '-340282356779733661637539395458142568448',
      max: '340282356779733661637539395458142568448',
    });
    expect(describeV1Column(col('number float', 'float'))).toMatchObject({
      min: '-340282346638528859811704183484516925440',
      max: '340282346638528859811704183484516925440',
    });
    // SingleStore states the semantic and no codec at all on 1.0.0-rc.4, measured on a real
    // `singlestoreTable`, so it lands here. It is MySQL wire-compatible and was not measured
    // itself, so it takes MySQL's edge rather than the wider one.
    expect(describeV1Column({ dataType: 'number float', dimensions: 0 })).toMatchObject({
      max: '340282346638528859811704183484516925440',
    });
    // 8 byte floats carry no magnitude bound on either database: MySQL's `DOUBLE` returned
    // Number.MAX_VALUE and 1e300 identical while the `FLOAT` beside it refused both.
    const d = describeV1Column(col('number double', 'float8'));
    expect(d?.min).toBeUndefined();
    expect(d?.max).toBeUndefined();
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

  it('separates the object modes, which v1 spells in the dataType it already states', () => {
    // `point({ mode: 'xy' })` is `object point` with codec `point` on v1 and hands back `{ x, y }`;
    // `line({ mode: 'abc' })` is `object line` and hands back `{ a, b, c }`. Both used to reach the
    // same `case 'point'` and `case 'line'` arms as the tuple modes and come back as tuples, so a
    // v1 select schema for either rejected every row the driver returns. Read back through PGlite
    // on 1.0.0-rc.4: `{ x: 1, y: 2 }` inserts and returns as `{ x: 1, y: 2 }`, while `[1, 2]` and
    // `'1,2'` both map to the literal `(undefined,undefined)` and Postgres answers `invalid input
    // syntax for type point`.
    //
    // The discriminator is the JS half of the dataType, not the codec. Both halves were read off
    // real 1.0.0-rc.4 columns: the tuple modes state `array point` / `array line` with codecs
    // `point:tuple` / `line:tuple`, and the object modes state `object point` / `object line` with
    // codecs `point` / `line`. `js` says the same thing without depending on the codec, which
    // three dialects leave undefined elsewhere in this file.
    expect(describeV1Column(col('object point', 'point'))?.shape).toEqual({
      kind: 'numberObject',
      fields: ['x', 'y'],
    });
    expect(describeV1Column(col('object line', 'line'))?.shape).toEqual({
      kind: 'numberObject',
      fields: ['a', 'b', 'c'],
    });
    expect(describeV1Column(col('object point', 'point'))?.tsType).toBe('{ x: number; y: number }');
    expect(describeV1Column(col('object line', 'line'))?.tsType).toBe(
      '{ a: number; b: number; c: number }'
    );
    // `geometry({ type: 'point', mode: 'xy' })` is `object geometry` on the same major, measured
    // on a real column, and reaches the same arm. It hands back `{ x, y }` like the others.
    expect(describeV1Column(col('object geometry', 'geometry(point)'))?.shape).toEqual({
      kind: 'numberObject',
      fields: ['x', 'y'],
    });
    // And the tuple modes are untouched by the split, which is what makes it a split rather than
    // a replacement.
    expect(describeV1Column(col('array point', 'point:tuple'))?.shape).toEqual({
      kind: 'tuple',
      length: 2,
    });
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
