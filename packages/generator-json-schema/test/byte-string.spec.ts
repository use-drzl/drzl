/**
 * MySQL/SingleStore `binary(n)`/`varbinary(n)` as JSON Schema, compiled and run by ajv.
 *
 * The measurements these assert are in `packages/generator-zod/test/byte-string.spec.ts` and were
 * taken from MySQL 8.4 through drizzle on both majors.
 *
 * JSON Schema has no way to count bytes, so this generator states the one cap it can: `maxLength`,
 * which the specification defines in code points. That is exactly the select-side truth, and on
 * the insert side it is a necessary condition rather than the whole one, since every value the
 * server accepts is at most n bytes and therefore at most n code points. The generator already
 * carries the same incompleteness for MySQL's TEXT byte budget, where it emits nothing at all.
 *
 * The four columns used to come out `{ type: 'string', pattern: '^[01]*$' }` on v1, which rejects
 * every row, and `{ type: 'string', contentEncoding: 'base64' }` on 0.4x, which accepted the row
 * only because that keyword is an annotation ajv does not enforce.
 */
import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { Column, Table } from '@drzl/analyzer';
import { tableSchemas } from '../src/index';

const col = (length?: number): Column =>
  ({
    name: 'vbin',
    tsType: 'string',
    dbType: 'BINARY',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    shape: { kind: 'byteString', length },
  }) as Column;

const table = (c: Column): Table =>
  ({ name: 't', tsName: 't', columns: [c], unique: [], indexes: [], checks: [] }) as never;

function compile(schema: unknown) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv as never);
  return ajv.compile(schema as never);
}

const SELECTED_FF = Buffer.from([0xff, 0xff, 0xff]).toString();

describe('json schema, a byte-string column', () => {
  it('accepts the row a varbinary(3) returns rather than demanding 0 and 1', () => {
    const validate = compile(tableSchemas(table(col(3))).select);
    expect(validate({ vbin: SELECTED_FF })).toBe(true);
    expect(validate({ vbin: 'zzz' }), 'not a run of 0 and 1').toBe(true);
    expect(validate({ vbin: '' }), 'an empty varbinary').toBe(true);
  });

  it('is a string, so the bytes themselves are not it', () => {
    const validate = compile(tableSchemas(table(col(3))).select);
    expect(validate({ vbin: [255, 255, 255] })).toBe(false);
  });

  it('states the width in the one unit JSON Schema counts', () => {
    // Code points, per RFC 8259. A row out of a varbinary(3) has at most 3 of them, so this never
    // turns one away, and a fourth cannot have come from that column.
    const validate = compile(tableSchemas(table(col(3))).select);
    expect(validate({ vbin: 'ABC' })).toBe(true);
    expect(validate({ vbin: 'ABCD' })).toBe(false);
    for (const mode of ['insert', 'update'] as const) {
      const v = compile(tableSchemas(table(col(8)))[mode]);
      expect(v({ vbin: 'abcdefgh' }), mode).toBe(true);
      expect(v({ vbin: 'abcdefghi' }), mode).toBe(false);
    }
  });

  it('is a plain string when the column declares no width', () => {
    const validate = compile(tableSchemas(table(col(undefined))).select);
    expect(validate({ vbin: 'anything at all' })).toBe(true);
    expect(validate({ vbin: 42 })).toBe(false);
  });
});
