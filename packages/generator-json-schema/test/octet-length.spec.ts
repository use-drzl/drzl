/**
 * `CHECK (octet_length(col) <= n)` in a format with no byte-length keyword.
 *
 * The same trade `byte-caps.spec.ts` documents for MySQL's TEXT budget, reached from a CHECK
 * instead of from the column type, and extended to the one column that carries bytes rather than a
 * string.
 *
 * On a **text** column the cap becomes `maxLength`, which counts characters. UTF-8 spends at least
 * one byte per character, so every string inside the byte budget is inside a character cap of the
 * same number: the cap refuses nothing the column accepts. It cannot catch a multi-byte string that
 * fits the count and not the budget, and that goes in `description` rather than unsaid.
 *
 * On a **bytea** column the value travels as base64, so the only length this format can bound is
 * the encoded string's. Base64 of n bytes is `4 * ceil(n / 3)` characters padded and fewer
 * unpadded, measured over n = 0 to 20:
 *
 *   n       0  1  2  3  4  5  6  7  8  9 10
 *   padded  0  4  4  4  8  8  8 12 12 12 16
 *   4ceil   0  4  4  4  8  8  8 12 12 12 16
 *
 * so that number is an upper bound under either spelling. It is loose by design: 6 bytes encode to
 * the same 8 characters as 5, so a 5 byte cap still admits 6 bytes and the exact rule is stated in
 * prose beside it.
 *
 * A byte *floor* is emitted nowhere. `octet_length(t) >= 10` implies only `length(t) >= 3`, which
 * catches almost nothing, and the base64 minimum differs between the padded and unpadded spellings
 * at every length.
 */
import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import type { Analysis, Column, Table } from '@drzl/analyzer';
import { JsonSchemaGenerator, type JsonSchemaTarget } from '../src/index';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const col = (over: Partial<Column> = {}): Column =>
  ({
    name: 'n',
    tsType: 'string',
    dbType: 'TEXT',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

const blob = () =>
  col({ tsType: 'Uint8Array', dbType: 'BYTEA', shape: { kind: 'buffer' } as never });

let seq = 0;

async function emitted(
  c: Column,
  opts: { target?: JsonSchemaTarget; checks?: { name?: string; expression?: string }[] } = {}
) {
  const table: Table = {
    name: 't',
    tsName: 't',
    columns: [c],
    unique: [],
    indexes: [],
    checks: opts.checks ?? [],
  } as never;
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [table],
    enums: [],
    relations: [],
    issues: [],
  } as never;
  const dir = path.join(__dirname, '.tmp-octets');
  await fs.mkdir(dir, { recursive: true });
  await new JsonSchemaGenerator(analysis).generate({
    outDir: dir,
    ...(opts.target ? { target: opts.target } : {}),
  } as never);
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.schema.ts'), file);
  const mod = await import(file);
  return mod.SelecttSchema.properties.n as Record<string, unknown>;
}

/** Compiled in strict mode, so an invented keyword fails here rather than being ignored. */
function compile(schema: unknown) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  return ajv.compile(schema as never);
}

const GRIN = '\u{1F600}'; // one code point, four bytes

describe('a byte budget on a text column', () => {
  it('states the ceiling as maxLength, which no draft spells in bytes', async () => {
    const s = await emitted(col(), { checks: [{ expression: 'octet_length(n) <= 5' }] });
    expect(s.maxLength).toBe(5);
    expect(s.minLength, 'nothing invents a floor from a ceiling').toBeUndefined();
    expect(Object.keys(s)).not.toContain('maxBytes');
  });

  it('refuses nothing Postgres accepted', async () => {
    // Measured: Postgres took 'hello' and one emoji, and refused 'hellos' and two emoji.
    const v = compile(await emitted(col(), { checks: [{ expression: 'octet_length(n) <= 5' }] }));
    expect(v('hello'), 'five ascii, five bytes').toBe(true);
    expect(v(GRIN), 'one emoji, one character, four bytes').toBe(true);
    expect(v('hellos'), 'six ascii, six bytes, which Postgres refused').toBe(false);
  });

  it('says in prose what a character count cannot enforce, rather than pretending', async () => {
    const s = await emitted(col(), { checks: [{ expression: 'octet_length(n) <= 5' }] });
    const v = compile(s);
    // Two emoji: two characters and eight bytes. Postgres refused the row and no character count
    // can say so, so the schema takes it and names the budget it cannot check.
    expect(v(GRIN.repeat(2))).toBe(true);
    expect(String(s.description)).toContain('At most 5 bytes');
  });

  it('keeps the narrower of a byte budget and a character count', async () => {
    // A byte ceiling of 5 and a character ceiling of 3 are two different measurements, and 3
    // characters is the stricter statement about a string that is also at most 5 bytes.
    const s = await emitted(col(), {
      checks: [{ expression: 'octet_length(n) <= 5' }, { expression: 'length(n) <= 3' }],
    });
    expect(s.maxLength).toBe(3);
  });

  it('takes an exclusive bound down to the integer below it', async () => {
    const s = await emitted(col(), { checks: [{ expression: 'octet_length(n) < 5' }] });
    expect(s.maxLength).toBe(4);
  });

  it('emits no keyword for a floor, which no character count can state', async () => {
    const s = await emitted(col(), { checks: [{ expression: 'octet_length(n) >= 10' }] });
    expect(s.minLength).toBeUndefined();
    expect(s.maxLength).toBeUndefined();
  });
});

describe('a byte budget on a bytea column', () => {
  it('caps the base64 string the value travels as', async () => {
    const s = await emitted(blob(), { checks: [{ expression: 'octet_length(n) <= 5' }] });
    expect(s.contentEncoding).toBe('base64');
    // 4 * ceil(5 / 3) = 8, the padded length of five bytes.
    expect(s.maxLength).toBe(8);
  });

  it('refuses nothing the column accepts, under either base64 spelling', async () => {
    const v = compile(await emitted(blob(), { checks: [{ expression: 'octet_length(n) <= 5' }] }));
    for (let n = 0; n <= 5; n++) {
      const bytes = Buffer.alloc(n);
      expect(v(bytes.toString('base64')), `${n} bytes, padded`).toBe(true);
      expect(v(bytes.toString('base64url')), `${n} bytes, unpadded`).toBe(true);
    }
  });

  it('catches an overflow the encoding is wide enough to show', async () => {
    const v = compile(await emitted(blob(), { checks: [{ expression: 'octet_length(n) <= 5' }] }));
    expect(v(Buffer.alloc(7).toString('base64')), 'seven bytes, twelve characters').toBe(false);
    // The gap the prose names: six bytes encode to the same eight characters as five.
    expect(v(Buffer.alloc(6).toString('base64')), 'six bytes, eight characters').toBe(true);
  });

  it('names the exact rule in prose, since the keyword is not it', async () => {
    const s = await emitted(blob(), { checks: [{ expression: 'octet_length(n) <= 5' }] });
    expect(String(s.description)).toContain('At most 5 bytes');
    expect(String(s.description)).toContain('base64');
  });

  it('says the same thing in an OpenAPI 3.0 document, where base64 is a format', async () => {
    const s = await emitted(blob(), {
      target: 'openapi-3.0',
      checks: [{ expression: 'octet_length(n) <= 5' }],
    });
    expect(s.format).toBe('byte');
    expect(s.maxLength).toBe(8);
    expect(s.contentEncoding, '3.0 has no such keyword and its Schema Object is closed').toBe(
      undefined
    );
  });
});

describe('a byte budget on a column that cannot answer one', () => {
  it('emits nothing for a MySQL varbinary', async () => {
    const bin = col({ dbType: 'VARBINARY', shape: { kind: 'byteString', length: 8 } as never });
    const s = await emitted(bin, { checks: [{ expression: 'octet_length(n) <= 5' }] });
    // The column's own declared width survives; the CHECK adds nothing to it.
    expect(s.maxLength).toBe(8);
    expect(s.description).toBeUndefined();
  });
});
