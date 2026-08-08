/**
 * `CHECK (octet_length(col) <= n)`: a byte budget declared as a constraint.
 *
 * The measurements this file is written against were taken on PostgreSQL 17.5 through PGlite, and
 * they are the whole reason the parser needs a `unit` rather than one more operator:
 *
 *   | expression            | `text` holding 3 emoji | `bytea` holding 6 bytes |
 *   | --------------------- | ---------------------- | ----------------------- |
 *   | `octet_length(x)`     | 12                     | 6                       |
 *   | `length(x)`           | 3                      | 6                       |
 *   | `char_length(x)`      | 3                      | does not exist          |
 *
 * So `length` is the *character* count on a text column and the *byte* count on a bytea one, and
 * `octet_length` is the byte count on both. A parser that read `octet_length` as one more spelling
 * of `length` would emit a character cap for a byte budget, which on a multi-byte string accepts a
 * value the column refuses. The three JavaScript expressions that answer each of them are asserted
 * below, because "`.length` on a Uint8Array is a byte count" is exactly the kind of thing that is
 * obviously true and worth measuring anyway.
 */
import { describe, expect, it } from 'vitest';
import type { Column, Table } from '@drzl/analyzer';
import { lengthCheckLabel, lengthMeasure, parseCheck, type LengthCheck } from '../src/checks';
import { classifyTableChecks, tableConstraints } from '../src/constraints';
import { columnMetaFacts, tableMetaFacts } from '../src/meta';

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

const blobCol = (name = 'blob') =>
  col(name, { tsType: 'Uint8Array', dbType: 'BYTEA', sqlType: 'bytea', shape: { kind: 'buffer' } });

const table = (cols: Column[], checks: { name?: string; expression: string }[] = []): Table =>
  ({
    name: 'files',
    tsName: 'files',
    columns: cols,
    unique: [],
    indexes: [],
    checks,
  }) as Table;

const lengths = (expr: string): LengthCheck[] => {
  const r = parseCheck(expr);
  expect(r.ok, `expected to parse: ${expr}`).toBe(true);
  return r.ok ? (r.lengths ?? []) : [];
};

describe('the three counts, as JavaScript answers them', () => {
  const emoji = '\u{1F600}\u{1F600}\u{1F600}';

  it('matches what Postgres reported for the same values', () => {
    // Postgres: octet_length = 12, length = char_length = 3.
    expect(new TextEncoder().encode(emoji).length).toBe(12);
    expect([...emoji].length).toBe(3);
    // The one that is neither, and the reason no count here is spelled `.length` on a string.
    expect(emoji.length).toBe(6);
  });

  it('measures a Uint8Array in bytes, which is what Postgres counts for a bytea', () => {
    // Postgres: octet_length(b) = length(b) = 6 for these bytes.
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    expect(bytes.length).toBe(6);
    // A Buffer is a Uint8Array, and drizzle hands one of the two up depending on the driver.
    expect(Buffer.from(bytes).length).toBe(6);
    // Not the code-point count of anything: the same six bytes decoded as UTF-8 need not be six.
    expect(new Uint8Array([0xf0, 0x9f, 0x98, 0x80]).length).toBe(4);
  });
});

describe('parsing octet_length', () => {
  it.each([
    ['octet_length(blob) <= 5', '<=', '5'],
    ['octet_length(blob) < 5', '<', '5'],
    ['octet_length(blob) >= 1', '>=', '1'],
    ['octet_length(blob) > 0', '>', '0'],
    ['octet_length(blob) = 4', '=', '4'],
    ['octet_length(blob) <> 4', '<>', '4'],
  ])('understands %s', (expr, operator, value) => {
    expect(lengths(expr)[0]).toMatchObject({ column: 'blob', operator, value, unit: 'bytes' });
  });

  it('normalises != to <>', () => {
    expect(lengths('octet_length(blob) != 4')[0]!.operator).toBe('<>');
  });

  it('is case insensitive and tolerates whitespace, as the other function forms are', () => {
    expect(lengths('OCTET_LENGTH ( blob )  <=  5')[0]).toMatchObject({
      column: 'blob',
      unit: 'bytes',
    });
  });

  it('keeps length and char_length as character counts', () => {
    expect(lengths('length(name) >= 3')[0]).toMatchObject({ unit: 'characters' });
    expect(lengths('char_length(name) >= 3')[0]).toMatchObject({ unit: 'characters' });
  });

  it('reads it inside a conjunction, where the AND split runs first', () => {
    const r = parseCheck('octet_length(blob) <= 5 AND octet_length(blob) >= 1');
    expect(r.ok && r.lengths).toMatchObject([
      { operator: '<=', value: '5', unit: 'bytes' },
      { operator: '>=', value: '1', unit: 'bytes' },
    ]);
  });

  it('still refuses a non-integer bound, which is not a count', () => {
    expect(parseCheck('octet_length(blob) <= 5.5').ok).toBe(false);
    expect(parseCheck("octet_length(blob) <= 'x'").ok).toBe(false);
  });

  it('still refuses a count compared against another column', () => {
    expect(parseCheck('octet_length(blob) <= cap').ok).toBe(false);
  });
});

describe('how a count is measured, once the column is known', () => {
  const k = (expr: string) => lengths(expr)[0]!;

  it('counts UTF-8 bytes for octet_length on a string column', () => {
    expect(lengthMeasure(col('name'), k('octet_length(name) <= 5'))).toBe('utf8Bytes');
  });

  it('counts code points for length on a string column', () => {
    expect(lengthMeasure(col('name'), k('length(name) <= 5'))).toBe('codePoints');
  });

  it('counts bytes for either function on a bytea column', () => {
    // Measured: `octet_length(b)` and `length(b)` are the same number on a bytea, and
    // `char_length(bytea)` is not a function Postgres has, so it cannot reach this.
    expect(lengthMeasure(blobCol(), k('octet_length(blob) <= 5'))).toBe('byteLength');
    expect(lengthMeasure(blobCol(), k('length(blob) <= 5'))).toBe('byteLength');
  });

  it('measures nothing on a byte-string column, whose width is two numbers', () => {
    // A MySQL `varbinary(n)` arrives as a string from a lossy decode, so neither the code points
    // it hands back nor their UTF-8 re-encoding is the server's byte count. See `ColumnShape`.
    const bin = col('bin', { dbType: 'VARBINARY', shape: { kind: 'byteString', length: 8 } });
    expect(lengthMeasure(bin, k('octet_length(bin) <= 5'))).toBeUndefined();
  });

  it('measures nothing on an array, a json payload or a number', () => {
    expect(
      lengthMeasure(col('tags', { arrayDimensions: 1 }), k('length(tags) <= 5'))
    ).toBeUndefined();
    expect(
      lengthMeasure(col('prefs', { shape: { kind: 'json' } }), k('length(prefs) <= 5'))
    ).toBeUndefined();
    expect(
      lengthMeasure(col('n', { tsType: 'number', dbType: 'INTEGER' }), k('length(n) <= 5'))
    ).toBeUndefined();
  });
});

describe('the label, which every emitted message and the ledger both key on', () => {
  it('names the function the unit came from', () => {
    expect(lengthCheckLabel(lengths('octet_length(blob) <= 5')[0]!)).toBe(
      'octet_length(blob) <= 5'
    );
    expect(lengthCheckLabel(lengths('length(name) >= 3')[0]!)).toBe('length(name) >= 3');
  });

  it('normalises char_length to length, as it always has', () => {
    expect(lengthCheckLabel(lengths('char_length(name) >= 3')[0]!)).toBe('length(name) >= 3');
  });

  it('carries the constraint name', () => {
    const r = parseCheck('octet_length(blob) <= 5', 'blob_bytes');
    expect(r.ok && lengthCheckLabel(r.lengths![0]!)).toBe('blob_bytes: octet_length(blob) <= 5');
  });
});

describe('the classification the ledger and meta share', () => {
  it('places a byte cap on a bytea column', () => {
    const t = table([blobCol()], [{ name: 'blob_bytes', expression: 'octet_length(blob) <= 5' }]);
    expect(classifyTableChecks(t)[0]!.parts).toMatchObject([
      { text: 'blob_bytes: octet_length(blob) <= 5', columns: ['blob'], place: 'column' },
    ]);
  });

  it('places a byte cap on a text column', () => {
    const t = table([col('name')], [{ expression: 'octet_length(name) <= 5' }]);
    expect(classifyTableChecks(t)[0]!.parts[0]!.place).toBe('column');
  });

  it('reports a byte cap on a byte-string column as unenforced, with the reason', () => {
    const bin = col('bin', { dbType: 'VARBINARY', shape: { kind: 'byteString', length: 8 } });
    const t = table([bin], [{ expression: 'octet_length(bin) <= 5' }]);
    const part = classifyTableChecks(t)[0]!.parts[0]!;
    expect(part.place).toBe('none');
    expect(part.reason).toMatch(/byte-string/);
  });
});

describe('the ledger', () => {
  it('reports a bytea byte cap as enforced, with the message a schema attaches', () => {
    const t = table([blobCol()], [{ name: 'blob_bytes', expression: 'octet_length(blob) <= 5' }]);
    const found = tableConstraints(t).constraints.find((c) => c.id === 'blob_bytes');
    expect(found).toMatchObject({
      kind: 'check',
      columns: ['blob'],
      rule: 'CHECK (octet_length(blob) <= 5)',
      enforced: true,
      messages: ['blob_bytes: octet_length(blob) <= 5'],
    });
    expect(found!.unenforced).toBeUndefined();
  });
});

describe('meta', () => {
  it('carries the byte cap on the column it constrains', () => {
    const t = table([blobCol()], [{ name: 'blob_bytes', expression: 'octet_length(blob) <= 5' }]);
    expect(columnMetaFacts(t.columns[0], t).checks).toEqual([
      'blob_bytes: octet_length(blob) <= 5',
    ]);
    expect(tableMetaFacts(t, { mode: 'insert' }).unenforcedChecks).toBeUndefined();
  });
});
