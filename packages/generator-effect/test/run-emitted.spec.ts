/**
 * Real values through real emitted modules, in all three modes.
 *
 * Nothing here reads the generated text. Every assertion imports the module the generator wrote
 * and pushes a value at the schema it exports, because the failures worth catching are the ones
 * where the text looks exactly right: a cap counting the wrong unit, a bound that silently admits
 * an infinity, a nullable column whose key stopped being required.
 */
import { describe, it, expect } from 'vitest';
import { accepts, analysisOf, col, emit, emitColumn, EMOJI, table } from './fixtures';

const S = (m: Record<string, unknown>) => m.SelecttSchema;
const I = (m: Record<string, unknown>) => m.InserttSchema;
const U = (m: Record<string, unknown>) => m.UpdatetSchema;

describe('scalar column types, read back', () => {
  it('a string column takes a string and nothing else', async () => {
    const m = await emitColumn(col('n'));
    expect(accepts(S(m), { n: 'x' })).toBe(true);
    expect(accepts(S(m), { n: 1 })).toBe(false);
    expect(accepts(S(m), { n: null })).toBe(false);
    expect(accepts(S(m), {}), 'a NOT NULL column is required on select').toBe(false);
  });

  it('a boolean column takes a boolean and refuses the strings a database would coerce', async () => {
    const m = await emitColumn(col('n', { tsType: 'boolean', dbType: 'BOOLEAN' }));
    expect(accepts(S(m), { n: true })).toBe(true);
    expect(accepts(S(m), { n: 'true' })).toBe(false);
    expect(accepts(S(m), { n: 1 })).toBe(false);
  });

  it('an integer column refuses a fraction and honours its declared range', async () => {
    const m = await emitColumn(
      col('n', {
        tsType: 'number',
        dbType: 'INTEGER',
        integer: true,
        min: '-2147483648',
        max: '2147483647',
      })
    );
    expect(accepts(S(m), { n: 5 })).toBe(true);
    expect(accepts(S(m), { n: 5.5 })).toBe(false);
    expect(accepts(S(m), { n: 2147483648 })).toBe(false);
    expect(accepts(S(m), { n: -2147483648 })).toBe(true);
  });

  it('a float column takes a fraction', async () => {
    const m = await emitColumn(
      col('n', { tsType: 'number', dbType: 'DOUBLE PRECISION', integer: false })
    );
    expect(accepts(S(m), { n: 1.5 })).toBe(true);
    expect(accepts(S(m), { n: 1 })).toBe(true);
  });

  it('a bigint column takes a bigint and refuses the number that would round', async () => {
    const m = await emitColumn(
      col('n', {
        tsType: 'bigint',
        dbType: 'BIGINT',
        min: '-9223372036854775808',
        max: '9223372036854775807',
      })
    );
    expect(accepts(S(m), { n: 5n })).toBe(true);
    expect(accepts(S(m), { n: 5 })).toBe(false);
    expect(accepts(S(m), { n: 9223372036854775807n })).toBe(true);
    expect(accepts(S(m), { n: 9223372036854775808n }), 'past the 64 bit ceiling').toBe(false);
  });

  it('a date column takes a Date and refuses an Invalid Date', async () => {
    const m = await emitColumn(col('n', { tsType: 'Date', dbType: 'TIMESTAMP' }));
    expect(accepts(S(m), { n: new Date(0) })).toBe(true);
    expect(accepts(S(m), { n: new Date('nonsense') })).toBe(false);
  });

  it('a bytea column takes a Uint8Array, and a Buffer is one', async () => {
    const m = await emitColumn(
      col('n', { tsType: 'Uint8Array', dbType: 'BYTEA', shape: { kind: 'buffer' } as never })
    );
    expect(accepts(S(m), { n: new Uint8Array([1, 2]) })).toBe(true);
    expect(accepts(S(m), { n: Buffer.from([1, 2]) })).toBe(true);
    expect(accepts(S(m), { n: 'AQI=' })).toBe(false);
  });

  it('an enum column is the union of its values', async () => {
    const m = await emitColumn(col('n', { enumValues: ['a', 'b'] }));
    expect(accepts(S(m), { n: 'a' })).toBe(true);
    expect(accepts(S(m), { n: 'c' })).toBe(false);
  });

  it('a uuid column refuses a string that is not one', async () => {
    const m = await emitColumn(col('n', { format: 'uuid', dbType: 'UUID' }));
    expect(accepts(S(m), { n: '123e4567-e89b-12d3-a456-426614174000' })).toBe(true);
    expect(accepts(S(m), { n: 'not-a-uuid' })).toBe(false);
  });
});

describe('structured columns', () => {
  it('a point in tuple mode is two numbers, not a string', async () => {
    const m = await emitColumn(
      col('n', { tsType: 'unknown', shape: { kind: 'tuple', length: 2 } as never })
    );
    expect(accepts(S(m), { n: [1, 2] })).toBe(true);
    expect(accepts(S(m), { n: [1] })).toBe(false);
    expect(accepts(S(m), { n: '1,2' })).toBe(false);
  });

  it('a point in xy mode is an object of named numbers, and an extra key is ignored', async () => {
    const m = await emitColumn(
      col('n', { tsType: 'unknown', shape: { kind: 'numberObject', fields: ['x', 'y'] } as never })
    );
    expect(accepts(S(m), { n: { x: 1, y: 2 } })).toBe(true);
    expect(accepts(S(m), { n: { x: 1 } })).toBe(false);
    expect(accepts(S(m), { n: { x: 1, y: 2, z: 3 } }), 'the column stores (1,2)').toBe(true);
  });

  it('a vector with a declared length holds exactly that many numbers', async () => {
    const m = await emitColumn(
      col('n', { tsType: 'unknown', shape: { kind: 'numberVector', length: 3 } as never })
    );
    expect(accepts(S(m), { n: [1, 2, 3] })).toBe(true);
    expect(accepts(S(m), { n: [1, 2] })).toBe(false);
  });

  it('a Postgres bit(3) is exactly three binary digits', async () => {
    const m = await emitColumn(
      col('n', { shape: { kind: 'bitstring', length: 3, exact: true } as never })
    );
    expect(accepts(S(m), { n: '101' })).toBe(true);
    expect(accepts(S(m), { n: '10' })).toBe(false);
    expect(accepts(S(m), { n: '102' })).toBe(false);
  });

  it('a Cockroach varbit(3) is at most three, so the empty string fits', async () => {
    const m = await emitColumn(
      col('n', { shape: { kind: 'bitstring', length: 3, exact: false } as never })
    );
    expect(accepts(S(m), { n: '' })).toBe(true);
    expect(accepts(S(m), { n: '101' })).toBe(true);
    expect(accepts(S(m), { n: '1010' })).toBe(false);
  });

  it('a json column is checked all the way down and refuses what cannot round trip', async () => {
    const m = await emitColumn(col('n', { tsType: 'unknown', shape: { kind: 'json' } as never }));
    expect(accepts(S(m), { n: { a: { b: [1, 'x', null, true] } } })).toBe(true);
    expect(accepts(S(m), { n: NaN })).toBe(false);
    expect(accepts(S(m), { n: Infinity })).toBe(false);
    expect(accepts(S(m), { n: new Date() }), 'a Date is not JSON').toBe(false);
    expect(accepts(S(m), { n: { a: new Date() } }), 'nor is one nested').toBe(false);
    expect(accepts(S(m), { n: 1n })).toBe(false);
    expect(accepts(S(m), { n: undefined })).toBe(false);
  });

  it('a customType column has no runtime type, so it accepts anything', async () => {
    const m = await emitColumn(
      col('n', { tsType: 'unknown', shape: { kind: 'custom', sqlType: 'citext' } as never })
    );
    expect(accepts(S(m), { n: 'anything' })).toBe(true);
    expect(accepts(S(m), { n: 42 })).toBe(true);
  });

  it('a column the analyzer could not type accepts anything and does not throw', async () => {
    const m = await emitColumn(col('n', { tsType: 'nonsense-type', dbType: 'SOMETHING' }));
    expect(accepts(S(m), { n: 'anything' })).toBe(true);
    expect(accepts(S(m), { n: { deeply: ['nested'] } })).toBe(true);
  });
});

describe('arrays', () => {
  it('a text[] is an array of strings, not a string', async () => {
    const m = await emitColumn(col('n', { arrayDimensions: 1 }));
    expect(accepts(S(m), { n: ['a', 'b'] })).toBe(true);
    expect(accepts(S(m), { n: 'a' })).toBe(false);
  });

  it('a text[][] is two deep', async () => {
    const m = await emitColumn(col('n', { arrayDimensions: 2 }));
    expect(accepts(S(m), { n: [['a'], ['b']] })).toBe(true);
    expect(accepts(S(m), { n: ['a'] })).toBe(false);
  });

  it('a cap on varchar(3)[] caps each element, not the array', async () => {
    const m = await emitColumn(col('n', { maxLength: 3, arrayDimensions: 1 }));
    expect(accepts(S(m), { n: ['abc', 'abc', 'abc', 'abc'] })).toBe(true);
    expect(accepts(S(m), { n: ['abcd'] })).toBe(false);
  });
});

describe('nullable against optional, which are different questions', () => {
  it('a nullable column takes null on select and still requires the key', async () => {
    const m = await emitColumn(col('n', { nullable: true }));
    expect(accepts(S(m), { n: null })).toBe(true);
    expect(accepts(S(m), { n: 'x' })).toBe(true);
    expect(accepts(S(m), {}), 'select returns every column').toBe(false);
  });

  it('a nullable column may be omitted on insert', async () => {
    const m = await emitColumn(col('n', { nullable: true }));
    expect(accepts(I(m), {})).toBe(true);
    expect(accepts(I(m), { n: null })).toBe(true);
  });

  it('a NOT NULL column with no default is required on insert and refuses null', async () => {
    const m = await emitColumn(col('n'));
    expect(accepts(I(m), {})).toBe(false);
    expect(accepts(I(m), { n: null })).toBe(false);
    expect(accepts(I(m), { n: 'x' })).toBe(true);
  });

  it('a NOT NULL column with a default may be omitted on insert but never be null', async () => {
    const m = await emitColumn(col('n', { hasDefault: true }));
    expect(accepts(I(m), {})).toBe(true);
    expect(accepts(I(m), { n: null })).toBe(false);
  });

  it('every column is optional on update, and a NOT NULL one still refuses null', async () => {
    const m = await emitColumn(col('n'));
    expect(accepts(U(m), {})).toBe(true);
    expect(accepts(U(m), { n: 'x' })).toBe(true);
    expect(accepts(U(m), { n: null })).toBe(false);
  });

  it('a generated column is absent from insert and update and present on select', async () => {
    const m = await emit(
      analysisOf([table('t', [col('n'), col('g', { isGenerated: true, hasDefault: true })])])
    );
    expect(accepts(S(m), { n: 'x', g: 'y' })).toBe(true);
    expect(accepts(S(m), { n: 'x' }), 'select carries the generated column').toBe(false);
    expect(accepts(I(m), { n: 'x' }), 'insert does not').toBe(true);
  });

  it('a primary key is dropped from update, since it identifies the row', async () => {
    const m = await emit(
      analysisOf([table('t', [col('id'), col('n')], { primaryKey: { columns: ['id'] } } as never)])
    );
    // Nothing to assert about `id` being refused: Effect Structs ignore unlisted keys, exactly as
    // every other generator's do. What is checked is that the rest survived the drop.
    expect(accepts(U(m), { n: 'x' })).toBe(true);
    expect(accepts(S(m), { id: 'a', n: 'x' })).toBe(true);
  });
});

describe('character and byte caps', () => {
  it('counts code points, so ten astral characters fit a varchar(10)', async () => {
    const m = await emitColumn(col('n', { maxLength: 10 }));
    expect(accepts(S(m), { n: EMOJI.repeat(10) }), 'the database accepts this row').toBe(true);
    expect(accepts(S(m), { n: EMOJI.repeat(11) })).toBe(false);
    expect(accepts(S(m), { n: 'a'.repeat(10) })).toBe(true);
    expect(accepts(S(m), { n: 'a'.repeat(11) })).toBe(false);
  });

  it('a byte budget fills four times as fast on a four-byte character', async () => {
    const m = await emitColumn(col('n', { maxBytes: 255 }));
    expect(accepts(S(m), { n: 'a'.repeat(255) })).toBe(true);
    expect(accepts(S(m), { n: 'a'.repeat(256) })).toBe(false);
    expect(accepts(S(m), { n: EMOJI.repeat(63) }), '252 bytes').toBe(true);
    expect(accepts(S(m), { n: EMOJI.repeat(64) }), '256 bytes').toBe(false);
  });

  it('a MySQL varbinary is characters out and bytes in', async () => {
    const m = await emitColumn(col('n', { shape: { kind: 'byteString', length: 4 } as never }));
    expect(accepts(S(m), { n: EMOJI.repeat(4) }), 'four characters, read back').toBe(true);
    expect(accepts(I(m), { n: EMOJI.repeat(4) }), 'sixteen bytes, going in').toBe(false);
    expect(accepts(I(m), { n: 'abcd' })).toBe(true);
  });

  it('a column with no cap takes a long string', async () => {
    const m = await emitColumn(col('n'));
    expect(accepts(S(m), { n: 'x'.repeat(100000) })).toBe(true);
  });
});

describe('non-finite numbers', () => {
  it('a plain float column refuses NaN and both infinities', async () => {
    const m = await emitColumn(col('n', { tsType: 'number', dbType: 'REAL', integer: false }));
    expect(accepts(S(m), { n: NaN })).toBe(false);
    expect(accepts(S(m), { n: Infinity })).toBe(false);
    expect(accepts(S(m), { n: -Infinity })).toBe(false);
    expect(accepts(S(m), { n: 1.5 })).toBe(true);
  });

  it('a column the analyzer says stores them accepts all three', async () => {
    const m = await emitColumn(
      col('n', {
        tsType: 'number',
        dbType: 'DOUBLE PRECISION',
        integer: false,
        allowsNaN: true,
        allowsInfinity: true,
      })
    );
    expect(accepts(S(m), { n: NaN })).toBe(true);
    expect(accepts(S(m), { n: Infinity })).toBe(true);
    expect(accepts(S(m), { n: -Infinity })).toBe(true);
    expect(accepts(S(m), { n: 1.5 })).toBe(true);
  });

  it('a numeric(10,2) takes NaN and refuses the infinities, as Postgres does', async () => {
    const m = await emitColumn(
      col('n', {
        tsType: 'number',
        dbType: 'NUMERIC',
        integer: false,
        allowsNaN: true,
        allowsInfinity: false,
      })
    );
    expect(accepts(S(m), { n: NaN })).toBe(true);
    expect(accepts(S(m), { n: Infinity })).toBe(false);
    expect(accepts(S(m), { n: -Infinity })).toBe(false);
    expect(accepts(S(m), { n: 3.14 })).toBe(true);
  });

  it('a bounded column that stores them still takes them beside its range', async () => {
    const m = await emitColumn(
      col('n', {
        tsType: 'number',
        dbType: 'NUMERIC',
        integer: false,
        min: '-99999999.99',
        max: '99999999.99',
        allowsNaN: true,
        allowsInfinity: true,
      })
    );
    expect(accepts(S(m), { n: NaN }), 'no range holds NaN').toBe(true);
    expect(accepts(S(m), { n: Infinity })).toBe(true);
    expect(accepts(S(m), { n: 1 })).toBe(true);
    expect(accepts(S(m), { n: 1e9 }), 'past the declared width').toBe(false);
  });
});

describe('CHECK constraints', () => {
  it('a numeric comparison is enforced', async () => {
    const m = await emitColumn(col('age', { tsType: 'number', dbType: 'INTEGER', integer: true }), [
      { name: 'age_adult', expression: 'age >= 18' },
    ]);
    expect(accepts(S(m), { age: 18 })).toBe(true);
    expect(accepts(S(m), { age: 17 })).toBe(false);
  });

  it('a strict comparison is not folded into a loose one', async () => {
    const m = await emitColumn(col('n', { tsType: 'number', dbType: 'INTEGER', integer: true }), [
      { expression: 'n > 0' },
    ]);
    expect(accepts(S(m), { n: 1 })).toBe(true);
    expect(accepts(S(m), { n: 0 })).toBe(false);
  });

  it('a check passes where the column is null, as SQL does', async () => {
    const m = await emitColumn(
      col('age', { tsType: 'number', dbType: 'INTEGER', integer: true, nullable: true }),
      [{ expression: 'age >= 18' }]
    );
    expect(accepts(S(m), { age: null }), 'a CHECK passes on TRUE or NULL').toBe(true);
    expect(accepts(S(m), { age: 17 })).toBe(false);
  });

  it('an IN list becomes a union of literals', async () => {
    const m = await emitColumn(col('status'), [{ expression: "status IN ('a', 'b')" }]);
    expect(accepts(S(m), { status: 'a' })).toBe(true);
    expect(accepts(S(m), { status: 'z' })).toBe(false);
  });

  it('an equality pins the value', async () => {
    const m = await emitColumn(col('kind'), [{ expression: "kind = 'fixed'" }]);
    expect(accepts(S(m), { kind: 'fixed' })).toBe(true);
    expect(accepts(S(m), { kind: 'other' })).toBe(false);
  });

  it('an inequality is enforced too, which TypeBox declines for want of a form', async () => {
    const m = await emitColumn(col('kind'), [{ expression: "kind <> 'banned'" }]);
    expect(accepts(S(m), { kind: 'ok' })).toBe(true);
    expect(accepts(S(m), { kind: 'banned' })).toBe(false);
  });

  it('a length() check counts code points, not UTF-16 units', async () => {
    const m = await emitColumn(col('n'), [{ expression: 'length(n) <= 3' }]);
    expect(accepts(S(m), { n: EMOJI.repeat(3) }), 'three characters').toBe(true);
    expect(accepts(S(m), { n: EMOJI.repeat(4) })).toBe(false);
  });

  it('a cardinality() check counts elements', async () => {
    const m = await emitColumn(col('tags', { arrayDimensions: 1 }), [
      { expression: 'cardinality(tags) >= 2' },
    ]);
    expect(accepts(S(m), { tags: ['a', 'b'] })).toBe(true);
    expect(accepts(S(m), { tags: ['a'] })).toBe(false);
  });

  it('a scalar check is not applied to an array column', async () => {
    // `CHECK (tags = '{}')` describes an element and would collapse the column to one literal.
    const m = await emitColumn(col('tags', { arrayDimensions: 1 }), [{ expression: "tags = 'x'" }]);
    expect(accepts(S(m), { tags: ['a', 'b'] })).toBe(true);
  });

  it('a two-column check lives on the row and passes where either side is null', async () => {
    const m = await emit(
      analysisOf([
        table(
          't',
          [
            col('lo', { tsType: 'number', dbType: 'INTEGER', integer: true }),
            col('hi', { tsType: 'number', dbType: 'INTEGER', integer: true, nullable: true }),
          ],
          { checks: [{ name: 'ordered', expression: 'lo < hi' }] } as never
        ),
      ])
    );
    expect(accepts(S(m), { lo: 1, hi: 2 })).toBe(true);
    expect(accepts(S(m), { lo: 3, hi: 2 })).toBe(false);
    expect(accepts(S(m), { lo: 3, hi: null }), 'SQL never applied the comparison').toBe(true);
  });

  it('a check naming a column this mode does not carry is left off', async () => {
    const m = await emit(
      analysisOf([
        table(
          't',
          [
            col('lo', { tsType: 'number', dbType: 'INTEGER', integer: true }),
            col('hi', {
              tsType: 'number',
              dbType: 'INTEGER',
              integer: true,
              isGenerated: true,
              hasDefault: true,
            }),
          ],
          { checks: [{ expression: 'lo < hi' }] } as never
        ),
      ])
    );
    expect(accepts(I(m), { lo: 5 }), 'insert has no `hi` to compare against').toBe(true);
    expect(accepts(S(m), { lo: 5, hi: 2 })).toBe(false);
  });

  it('an unparseable check is skipped rather than guessed at', async () => {
    const m = await emitColumn(col('n'), [{ expression: "lower(n) LIKE lower(other) || '%'" }]);
    expect(accepts(S(m), { n: 'anything at all' })).toBe(true);
  });
});
