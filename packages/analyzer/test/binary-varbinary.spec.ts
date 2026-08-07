/**
 * A MySQL/SingleStore `binary(n)`/`varbinary(n)` hands the caller a string.
 *
 * Asked of MySQL 8.4 through drizzle itself, on both majors, rather than read off a type
 * declaration. The same table, the same row, the same three layers:
 *
 *   raw mysql2        bin -> Buffer <68656c6c6f00...>   vbin -> Buffer <00ff41>
 *   drizzle 0.45.2    bin -> string (16 code points)    vbin -> string (3 code points)
 *   drizzle 1.0.0-rc.4  identical to 0.45.2
 *
 * `instanceof Uint8Array` is false for every one of them on both majors, and no value the column
 * returns is a run of `0` and `1`. So the two answers this file replaces were each wrong in their
 * own way and wrong about the same thing: 0.4x said `Uint8Array`, which the class-name path
 * inferred from the word "Binary", and v1 said a `bitstring`, which is what a Postgres `bit(n)` is
 * and what this shares a `dataType` with.
 *
 * The length is a byte budget on the way in and a code-point ceiling on the way out, which is not
 * a distinction without a difference: measured on varbinary(3), the row `<ff ff ff>` comes back as
 * 3 code points that re-encode to 9 UTF-8 bytes, so a byte cap applied to a select schema rejects
 * a row the column itself returned. Both halves are carried by the shape and applied per mode by
 * the generators, which their own specs run.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SchemaAnalyzer, describeV1Column } from '../src/index';

const dir = path.resolve(__dirname, 'fixtures');

async function columnsOf(name: string, source: string) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.mjs`);
  await fs.writeFile(file, source, 'utf8');
  const a = await new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({});
  return new Map(a.tables.flatMap((t) => t.columns.map((c) => [`${t.name}.${c.name}`, c])));
}

describe('drizzle 0.4x, against real mysql-core and singlestore-core columns', () => {
  const SOURCE = `
    import { mysqlTable, int, binary, varbinary } from 'drizzle-orm/mysql-core';
    import {
      singlestoreTable,
      int as ssInt,
      binary as ssBinary,
      varbinary as ssVarbinary,
    } from 'drizzle-orm/singlestore-core';

    export const my = mysqlTable('my', {
      id: int('id').primaryKey(),
      bin: binary('bin', { length: 16 }),
      binNoLen: binary('bin_no_len'),
      vbin: varbinary('vbin', { length: 32 }),
    });

    export const ss = singlestoreTable('ss', {
      id: ssInt('id').primaryKey(),
      bin: ssBinary('bin', { length: 16 }),
      vbin: ssVarbinary('vbin', { length: 32 }),
    });
  `;

  it('types all four column builders as the string the driver returns', async () => {
    // Four builders, both dialects, enumerated from drizzle's own exports rather than assumed:
    // mysql-core and singlestore-core each export `binary` and `varbinary` and no `blob` at all on
    // 0.45.2, so this is the whole set on this major.
    const cols = await columnsOf('binary-varbinary-0.4x', SOURCE);
    for (const key of ['my.bin', 'my.binNoLen', 'my.vbin', 'ss.bin', 'ss.vbin']) {
      expect(cols.get(key)?.tsType, key).toBe('string');
      expect(cols.get(key)?.dbType, key).toBe('BINARY');
    }
  });

  it('carries the declared width as a byte-string shape', async () => {
    const cols = await columnsOf('binary-varbinary-0.4x', SOURCE);
    expect(cols.get('my.bin')?.shape).toEqual({ kind: 'byteString', length: 16 });
    expect(cols.get('my.vbin')?.shape).toEqual({ kind: 'byteString', length: 32 });
    expect(cols.get('ss.bin')?.shape).toEqual({ kind: 'byteString', length: 16 });
    expect(cols.get('ss.vbin')?.shape).toEqual({ kind: 'byteString', length: 32 });
  });

  it('states the width once, on the shape', async () => {
    // `maxLength` is what every generator applies as a plain character cap in every mode, and the
    // whole point of the shape is that this width is not that. Two numbers meaning different
    // things under the same name is how the wrong one gets picked up.
    const cols = await columnsOf('binary-varbinary-0.4x', SOURCE);
    for (const key of ['my.bin', 'my.vbin', 'ss.bin', 'ss.vbin']) {
      expect(cols.get(key)?.maxLength, key).toBeUndefined();
    }
  });

  it('leaves a column with no declared width unbounded rather than inventing one', async () => {
    // `binary()` with no length is `binary(1)` in the server, but drizzle 0.4x records no length
    // at all, so there is nothing to carry. v1 does record 1, and says so below.
    const cols = await columnsOf('binary-varbinary-0.4x', SOURCE);
    expect(cols.get('my.binNoLen')?.shape).toEqual({ kind: 'byteString', length: undefined });
  });
});

/**
 * v1 column descriptors, taken from a real drizzle-orm 1.0.0-rc.4 by enumerating every export of
 * every dialect whose `dataType` has the semantic half `binary`. That census is the whole set
 * reaching this arm, and the trap it exposes is that the codec cannot discriminate:
 *
 *   pg          bit        codec 'bit'         PgBinaryVector
 *   mysql       binary     codec 'binary'      MySqlBinary
 *   mysql       varbinary  codec 'varbinary'   MySqlVarBinary
 *   singlestore binary     codec undefined     SingleStoreBinary
 *   singlestore varbinary  codec undefined     SingleStoreVarBinary
 *   cockroach   bit        codec undefined     CockroachBit
 *   cockroach   varbit     codec undefined     CockroachVarbit
 *
 * SingleStore and Cockroach both carry no codec, so `codec === 'binary' || codec === 'varbinary'`
 * would leave both SingleStore columns on the bit-string path while looking like it had moved
 * them. `drizzle:entityKind` is the discriminator, as it is everywhere else in this file.
 *
 * MSSQL `binary`/`varbinary` report `object buffer` and never reach this arm at all.
 */
const v1col = (entityKind: string, codec: string | undefined, length?: number) => ({
  dataType: 'string binary',
  codec,
  dimensions: 0,
  ...(length === undefined ? {} : { length }),
  constructor: { [Symbol.for('drizzle:entityKind')]: entityKind },
});

describe('drizzle v1, the four column classes that share a dataType with a Postgres bit', () => {
  it('gives MySQL binary and varbinary a byte string, not a run of 0 and 1', () => {
    expect(describeV1Column(v1col('MySqlBinary', 'binary', 16))).toMatchObject({
      tsType: 'string',
      dbType: 'BINARY',
      shape: { kind: 'byteString', length: 16 },
    });
    expect(describeV1Column(v1col('MySqlVarBinary', 'varbinary', 32))?.shape).toEqual({
      kind: 'byteString',
      length: 32,
    });
  });

  it('gives SingleStore the same answer, which carries no codec to discriminate on', () => {
    expect(describeV1Column(v1col('SingleStoreBinary', undefined, 16))?.shape).toEqual({
      kind: 'byteString',
      length: 16,
    });
    expect(describeV1Column(v1col('SingleStoreVarBinary', undefined, 32))?.shape).toEqual({
      kind: 'byteString',
      length: 32,
    });
  });

  it('leaves a Postgres bit exactly where it was', () => {
    // A `bit(3)` really is three characters of '0' and '1', and that answer is correct and stays.
    expect(describeV1Column(v1col('PgBinaryVector', 'bit', 3))).toMatchObject({
      tsType: 'string',
      dbType: 'BIT',
      shape: { kind: 'bitstring', length: 3, exact: true },
    });
  });

  it('separates a Cockroach bit from a Cockroach varbit', () => {
    // Both used to answer `exact: false`, because `exact` was `codec === 'bit'` and neither of
    // these carries a codec, so `bit(8)` and `varbit(8)` were the same column to this file.
    //
    // GROUND TRUTH, CockroachDB v24.3.5 (`cockroachdb/cockroach:v24.3.5`), on `bit(3)` and
    // `varbit(8)` in one table:
    //
    //   bit(3)      ''           refused, "bit string length 0 does not match type BIT(3)"
    //   bit(3)      '1'          refused, length 1 does not match
    //   bit(3)      '101'        accepted, read back as the string '101'
    //   bit(3)      '1011'       refused, length 4 does not match
    //   varbit(8)   ''           accepted
    //   varbit(8)   '1'          accepted
    //   varbit(8)   '10101010'   accepted, read back as '10101010'
    //   varbit(8)   '101010101'  refused, "bit string length 9 too large for type VARBIT(8)"
    //
    // So the fixed-width one is exact and the varying one is a maximum, which is the same split
    // Postgres draws and which the codec was standing in for. `drizzle-orm/zod` at 1.0.0-rc.4
    // agrees with the server on all eight values.
    //
    // Both entity kinds are asserted here rather than only the one that changed, because the
    // discriminator has to distinguish them: an arm matching a `Cockroach` prefix would have made
    // `varbit` exact too and this file would still have been green on the half that moved.
    expect(describeV1Column(v1col('CockroachBit', undefined, 8))?.shape).toEqual({
      kind: 'bitstring',
      length: 8,
      exact: true,
    });
    expect(describeV1Column(v1col('CockroachVarbit', undefined, 8))?.shape).toEqual({
      kind: 'bitstring',
      length: 8,
      exact: false,
    });
  });

  it('labels both of them BIT, as it labels the Postgres one', () => {
    // They used to be BINARY, which is the label this file gives a MySQL `binary(n)`: a run of
    // arbitrary bytes handed over as a string. A cockroach `bit` is a string of '0' and '1', per
    // the server readings above, and is labelled like the Postgres bit it behaves as.
    expect(describeV1Column(v1col('CockroachBit', undefined, 8))?.dbType).toBe('BIT');
    expect(describeV1Column(v1col('CockroachVarbit', undefined, 8))?.dbType).toBe('BIT');
    expect(describeV1Column(v1col('MySqlBinary', 'binary', 16))?.dbType).toBe('BINARY');
    expect(describeV1Column(v1col('SingleStoreBinary', undefined, 16))?.dbType).toBe('BINARY');
  });
});
