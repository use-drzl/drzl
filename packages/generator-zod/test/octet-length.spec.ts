/**
 * `CHECK (octet_length(col) <= 5)`, which is a byte budget rather than a character count.
 *
 * Measured against PostgreSQL 17.5 through PGlite, on the two column types the expression is legal
 * on, with the emitted schema asked the same four questions:
 *
 *   | value                       | `text` with `octet_length(t) <= 5` | a character cap of 5 |
 *   | --------------------------- | ---------------------------------- | -------------------- |
 *   | `'hello'`, 5 ascii          | accepted                           | accepts              |
 *   | `'hellos'`, 6 ascii         | REFUSED                            | refuses              |
 *   | one emoji, 4 bytes          | accepted                           | accepts              |
 *   | two emoji, 8 bytes          | REFUSED                            | **accepts**          |
 *
 * The last row is the whole point: two emoji are two characters and eight bytes, so a schema that
 * read `octet_length` as one more spelling of `length` takes a write the column refuses. And on a
 * `bytea`, where `octet_length(b)` and `length(b)` are the same number, five bytes insert and six
 * do not.
 *
 * The predicate is the same one the MySQL TEXT byte budget already used, so this is that machinery
 * reached from a CHECK rather than a second copy of it.
 */
import { describe, it, expect } from 'vitest';
import { ZodGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const GRIN = '\u{1F600}'; // one code point, four UTF-8 bytes, two UTF-16 units

const col = (name: string, over: Partial<Column> = {}): Column =>
  ({
    name,
    tsType: 'string',
    dbType: 'TEXT',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

const blob = (name = 'blob') =>
  col(name, { tsType: 'Uint8Array', dbType: 'BYTEA', shape: { kind: 'buffer' } as never });

let seq = 0;

async function schemasFor(columns: Column[], checks: unknown[]): Promise<Record<string, any>> {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-octets');
  await fs.mkdir(dir, { recursive: true });
  await new ZodGenerator(analysis).generate({ outDir: dir } as never);
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.zod.ts'), file);
  return await import(file);
}

describe('a byte budget on a text column', () => {
  it('accepts and refuses exactly what Postgres did', async () => {
    const m = await schemasFor([col('body')], [{ expression: 'octet_length(body) <= 5' }]);
    const f = m.SelecttSchema.shape.body;
    expect(f.safeParse('hello').success, 'five ascii, which Postgres took').toBe(true);
    expect(f.safeParse('hellos').success, 'six ascii, which Postgres refused').toBe(false);
    expect(f.safeParse(GRIN).success, 'one emoji, four bytes, which Postgres took').toBe(true);
    expect(
      f.safeParse(GRIN.repeat(2)).success,
      'two emoji, eight bytes, which Postgres refused and a character cap would take'
    ).toBe(false);
  });

  it('measures bytes rather than characters or UTF-16 units', async () => {
    const m = await schemasFor([col('body')], [{ expression: 'octet_length(body) <= 5' }]);
    // Three characters, six UTF-16 units, twelve bytes. Every count but the byte one is inside 5.
    expect(m.SelecttSchema.shape.body.safeParse(GRIN.repeat(3)).success).toBe(false);
  });

  it('names the constraint in the failure, exactly as the ledger records it', async () => {
    const m = await schemasFor(
      [col('body')],
      [{ name: 'body_bytes', expression: 'octet_length(body) <= 5' }]
    );
    const r = m.SelecttSchema.shape.body.safeParse('hellos');
    expect(r.success).toBe(false);
    expect(r.error.issues[0].message).toBe('body_bytes: octet_length(body) <= 5');
  });

  it('leaves a nullable column taking null, because a CHECK passes on NULL', async () => {
    const m = await schemasFor(
      [col('body', { nullable: true })],
      [{ expression: 'octet_length(body) <= 5' }]
    );
    expect(m.SelecttSchema.shape.body.safeParse(null).success).toBe(true);
    expect(m.SelecttSchema.shape.body.safeParse('hellos').success).toBe(false);
  });
});

describe('a byte budget on a bytea column', () => {
  it('counts the array, which is what Postgres counted', async () => {
    const m = await schemasFor([blob()], [{ expression: 'octet_length(blob) <= 5' }]);
    const f = m.SelecttSchema.shape.blob;
    expect(f.safeParse(new Uint8Array(5)).success, 'five bytes, which Postgres took').toBe(true);
    expect(f.safeParse(new Uint8Array(6)).success, 'six bytes, which Postgres refused').toBe(false);
    expect(f.safeParse(new Uint8Array(0)).success, 'the empty value, which Postgres took').toBe(
      true
    );
  });

  it('reads length() on a bytea as bytes too, which is what Postgres does', async () => {
    // Measured: `length(b)` and `octet_length(b)` are the same number on a bytea, and
    // `char_length(bytea)` is not a function Postgres has.
    const m = await schemasFor([blob()], [{ expression: 'length(blob) <= 5' }]);
    expect(m.SelecttSchema.shape.blob.safeParse(new Uint8Array(6)).success).toBe(false);
  });

  it('does not spread the array, which would count differently and cost the copy', async () => {
    const src = await fs.readFile(
      path.join(__dirname, '.tmp-octets', `t-${process.pid}-${seq - 1}.ts`),
      'utf8'
    );
    expect(src).toContain('v.length <=');
    expect(src).not.toContain('[...v].length');
  });
});

describe('a byte budget on a column that cannot answer one', () => {
  it('emits nothing for a MySQL varbinary, whose bytes JavaScript cannot see', async () => {
    // The value arrives as a string produced by a lossy decode: `<ff ff ff>` from a varbinary(3)
    // comes back as three code points that re-encode to nine bytes. Neither count is the server's.
    const bin = col('bin', {
      dbType: 'VARBINARY',
      shape: { kind: 'byteString', length: 8 } as never,
    });
    const m = await schemasFor([bin], [{ expression: 'octet_length(bin) <= 5' }]);
    const src = await fs.readFile(
      path.join(__dirname, '.tmp-octets', `t-${process.pid}-${seq - 1}.ts`),
      'utf8'
    );
    expect(src).not.toContain('octet_length(bin)');
    // Still a working schema, and still carrying the column's own declared width.
    expect(m.SelecttSchema.shape.bin.safeParse('abc').success).toBe(true);
  });

  it('emits nothing for an array, which has no bytes to count', async () => {
    await schemasFor(
      [col('tags', { arrayDimensions: 1 })],
      [{ expression: 'octet_length(tags) <= 5' }]
    );
    const src = await fs.readFile(
      path.join(__dirname, '.tmp-octets', `t-${process.pid}-${seq - 1}.ts`),
      'utf8'
    );
    expect(src).not.toContain('octet_length(tags)');
  });
});
