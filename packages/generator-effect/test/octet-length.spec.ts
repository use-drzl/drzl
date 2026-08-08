/**
 * `CHECK (octet_length(col) <= 5)` in Effect output.
 *
 * See the zod generator's file of the same name for the PGlite measurements this is written
 * against. The row that matters is two emoji: two characters and eight bytes, refused by Postgres
 * and accepted by any cap that counts characters.
 */
import { describe, it, expect } from 'vitest';
import { accepts, col, emitColumn, emitText, analysisOf, table } from './fixtures';

const GRIN = '\u{1F600}'; // one code point, four UTF-8 bytes

const S = (m: Record<string, unknown>) => m.SelecttSchema;

const blob = (name = 'blob') =>
  col(name, { tsType: 'Uint8Array', dbType: 'BYTEA', shape: { kind: 'buffer' } as never });

describe('a byte budget on a text column', () => {
  it('accepts and refuses exactly what Postgres did', async () => {
    const m = await emitColumn(col('body'), [{ expression: 'octet_length(body) <= 5' }]);
    expect(accepts(S(m), { body: 'hello' }), 'five ascii').toBe(true);
    expect(accepts(S(m), { body: 'hellos' }), 'six ascii').toBe(false);
    expect(accepts(S(m), { body: GRIN }), 'one emoji, four bytes').toBe(true);
    expect(accepts(S(m), { body: GRIN.repeat(2) }), 'two emoji, eight bytes').toBe(false);
  });

  it('names the constraint in the filter description', async () => {
    const src = await emitText(
      analysisOf([
        table('t', [col('body')], {
          checks: [{ name: 'body_bytes', expression: 'octet_length(body) <= 5' }],
        } as never),
      ])
    );
    expect(src).toContain('body_bytes: octet_length(body) <= 5');
  });

  it('skips a null, because a CHECK passes on NULL', async () => {
    const m = await emitColumn(col('body', { nullable: true }), [
      { expression: 'octet_length(body) <= 5' },
    ]);
    expect(accepts(S(m), { body: null })).toBe(true);
    expect(accepts(S(m), { body: 'hellos' })).toBe(false);
  });
});

describe('a byte budget on a bytea column', () => {
  it('counts the array, which is what Postgres counted', async () => {
    const m = await emitColumn(blob(), [{ expression: 'octet_length(blob) <= 5' }]);
    expect(accepts(S(m), { blob: new Uint8Array(5) })).toBe(true);
    expect(accepts(S(m), { blob: new Uint8Array(6) })).toBe(false);
  });

  it('pipes the count onto the shaped schema rather than replacing it', async () => {
    const m = await emitColumn(blob(), [{ expression: 'octet_length(blob) <= 5' }]);
    expect(accepts(S(m), { blob: 'hello' }), 'a five character string is not a bytea').toBe(false);
  });
});

describe('a byte budget on a column that cannot answer one', () => {
  it('emits nothing for a MySQL varbinary', async () => {
    const bin = col('bin', {
      dbType: 'VARBINARY',
      shape: { kind: 'byteString', length: 8 } as never,
    });
    const src = await emitText(
      analysisOf([
        table('t', [bin], { checks: [{ expression: 'octet_length(bin) <= 5' }] } as never),
      ])
    );
    expect(src).not.toContain('octet_length(bin)');
  });
});
