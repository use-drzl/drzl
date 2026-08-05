/**
 * The v1 column description for MySQL and SQLite specifically.
 *
 * Postgres is covered by `v1-column-types.spec.ts`. These two carry whole type families Postgres
 * does not, and every case below was a real defect: MySQL owns the narrow integer widths and the
 * intrinsic text caps, SQLite carries no `codec` at all and so was skipped by the v1 path
 * entirely, and `string binary` means two unrelated things depending on dialect.
 *
 * Targets were measured from `drizzle-orm/zod` at 1.0.0-rc.4, and the parity stage in
 * `scripts/verify-packed.sh` re-measures them against the real thing.
 */
import { describe, it, expect } from 'vitest';
import { describeV1Column } from '../src/index';

/** A MySQL column as v1 presents one. The entityKind is what identifies the dialect. */
const my = (dataType: string, codec: string, extra: Record<string, unknown> = {}) => ({
  dataType,
  codec,
  dimensions: 0,
  constructor: { [Symbol.for('drizzle:entityKind')]: 'MySqlSomething' },
  ...extra,
});

/** A SQLite column, which carries a dataType and no codec whatsoever. */
const sq = (dataType: string, extra: Record<string, unknown> = {}) => ({
  dataType,
  dimensions: 0,
  constructor: { [Symbol.for('drizzle:entityKind')]: 'SQLiteSomething' },
  ...extra,
});

describe('MySQL integer widths', () => {
  it('bounds the narrow widths Postgres does not have', () => {
    // These fell through to the bare-number arm, whose safe-integer bounds then overrode the
    // correct ones the class-name table supplied: a tinyint went from +/-127 to +/-9007199254740991
    // and stopped being an integer at all.
    expect(describeV1Column(my('number int8', 'tinyint'))).toMatchObject({
      integer: true,
      min: '-128',
      max: '127',
    });
    expect(describeV1Column(my('number int24', 'mediumint'))).toMatchObject({
      integer: true,
      min: '-8388608',
      max: '8388607',
    });
  });

  it('starts an unsigned serial at zero rather than at the signed floor', () => {
    // MySQL `serial` is `bigint unsigned auto_increment`.
    expect(describeV1Column(my('number uint53', 'serial'))).toMatchObject({
      integer: true,
      min: '0',
      max: '9007199254740991',
    });
  });

  it('holds a YEAR column to the years it can store', () => {
    expect(describeV1Column(my('number year', 'year'))).toMatchObject({
      tsType: 'number',
      integer: true,
      min: '1901',
      max: '2155',
    });
  });
});

describe('the two meanings of "string binary"', () => {
  it('treats a Postgres bit as an exact-width run of 0 and 1', () => {
    const pgBit = {
      dataType: 'string binary',
      codec: 'bit',
      dimensions: 0,
      length: 3,
      constructor: { [Symbol.for('drizzle:entityKind')]: 'PgBinaryVector' },
    };
    expect(describeV1Column(pgBit)?.shape).toEqual({ kind: 'bitstring', length: 3, exact: true });
  });

  it('treats a MySQL binary as arbitrary bytes, which is not a bit string at all', () => {
    // Sharing the Postgres arm made every MySQL binary column reject `''` and anything that was
    // not a run of 0s and 1s. Loosening the width to a ceiling fixed the empty string and left
    // the pattern, which still rejected every row the column returns: asked of MySQL 8.4 through
    // drizzle 1.0.0-rc.4, a varbinary holding `<00 ff 41>` comes back as three code points that
    // are not `0` or `1`. `binary-varbinary.spec.ts` carries the full measurement.
    expect(describeV1Column(my('string binary', 'varbinary', { length: 16 }))?.shape).toEqual({
      kind: 'byteString',
      length: 16,
    });
  });
});

describe('MySQL text and blob caps', () => {
  it('states the width the type itself implies', () => {
    // There is no `length` on a `text` column to read: the type is the limit, so it has to come
    // from a table. Unstated, the schema accepted a megabyte for a column that tops out at 64 KB.
    // In bytes, not characters. MySQL 8 on utf8mb4 takes 255 ascii in a tinytext and refuses 64
    // thumbs-up characters, which are 64 characters and 256 bytes. Carried as `maxLength` the
    // number was applied as a character count and the row validated clean.
    expect(describeV1Column(my('string', 'text'))?.maxBytes).toBe(65535);
    expect(describeV1Column(my('string', 'tinytext'))?.maxBytes).toBe(255);
    expect(describeV1Column(my('string', 'longtext'))?.maxBytes).toBe(4294967295);
    expect(describeV1Column(my('string', 'tinytext'))?.maxLength).toBeUndefined();
  });

  it('does not apply them to Postgres, whose text has no limit', () => {
    // The codec names collide: a Postgres `text` column reports the codec `text` as well.
    const pgText = {
      dataType: 'string',
      codec: 'text',
      dimensions: 0,
      constructor: { [Symbol.for('drizzle:entityKind')]: 'PgText' },
    };
    expect(describeV1Column(pgText)?.maxLength).toBe(undefined);
  });
});

describe('SQLite, which carries no codec', () => {
  it('is described from the dataType alone', () => {
    // Gating the v1 path on `codec` skipped the dialect entirely, so all of these stayed on the
    // class-name path and lost their semantics.
    expect(describeV1Column(sq('object json'))?.shape).toEqual({ kind: 'json' });
    expect(describeV1Column(sq('object buffer'))?.shape).toEqual({ kind: 'buffer' });
    expect(describeV1Column(sq('bigint int64'))).toMatchObject({
      tsType: 'bigint',
      min: '-9223372036854775808',
      max: '9223372036854775807',
    });
    expect(describeV1Column(sq('number int53'))).toMatchObject({ integer: true, tsType: 'number' });
    expect(describeV1Column(sq('number double'))).toMatchObject({ integer: false });
    expect(describeV1Column(sq('string numeric'))).toMatchObject({ tsType: 'string' });
  });

  it('still declines a bare dataType, which a 0.4x column also has', () => {
    // `string` with no semantic half and no codec is indistinguishable from Drizzle 0.4x, so the
    // class-name path keeps handling it.
    expect(describeV1Column({ dataType: 'string' })).toBe(null);
  });
});
