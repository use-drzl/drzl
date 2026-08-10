/**
 * `length()` is not the same function on every server, and the parser now knows it.
 *
 *              length()      char_length()   octet_length()
 *   Postgres   characters    characters      bytes
 *   SQLite     characters    characters      bytes
 *   MySQL      BYTES         characters      bytes
 *
 * Measured on MySQL 8.4.11 on utf8mb4, with the client charset set. Without that the client counts
 * the bytes it sent and every answer looks like a byte count, which is the trap this measurement
 * fell into first: `CHAR_LENGTH('一二三')` read 9 before the charset was fixed and 3 after.
 *
 *   LENGTH('一二三') = 9        CHAR_LENGTH('一二三') = 3
 *   LENGTH('👍👍')  = 8        CHAR_LENGTH('👍👍')  = 2
 *
 * And through a real constraint, `CHECK (LENGTH(name) <= 5)` on a `varchar(50)`:
 *
 *   'abcde'   5 bytes, 5 chars   ACCEPTED
 *   'abcdef'  6 bytes, 6 chars   refused
 *   '一'      3 bytes, 1 char    ACCEPTED
 *   '一二'    6 bytes, 2 chars   REFUSED
 *
 * That last row is the defect. Read as a five-character cap, a two-character string passes the
 * schema and the server refuses the row. The error was in the safe direction, since five bytes can
 * never be more than five characters, so no valid row was turned away; it under-enforced, which is
 * the half a validator exists for.
 */
import { describe, it, expect } from 'vitest';
import { parseCheck, lengthCheckLabel, type LengthCheck } from '../src/checks';

const lengthsOf = (expr: string, dialect?: string): LengthCheck[] => {
  const r = parseCheck(expr, 'c', dialect);
  expect(r.ok, expr).toBe(true);
  return r.ok ? r.lengths : [];
};

describe('what length() counts', () => {
  it('counts bytes on MySQL', () => {
    expect(lengthsOf('length(name) <= 5', 'mysql')[0]).toMatchObject({ unit: 'bytes' });
  });

  it('counts characters on Postgres and SQLite', () => {
    for (const d of ['postgres', 'sqlite']) {
      expect(lengthsOf('length(name) <= 5', d)[0], d).toMatchObject({ unit: 'characters' });
    }
  });

  it('counts characters when no dialect is given, which is what every caller had before', () => {
    expect(lengthsOf('length(name) <= 5')[0]).toMatchObject({ unit: 'characters' });
  });

  it('leaves char_length alone on MySQL, which is the character count there', () => {
    expect(lengthsOf('char_length(name) <= 5', 'mysql')[0]).toMatchObject({ unit: 'characters' });
  });

  it('leaves octet_length alone everywhere, which was never ambiguous', () => {
    for (const d of ['postgres', 'mysql', 'sqlite', undefined]) {
      expect(lengthsOf('octet_length(name) <= 5', d)[0], String(d)).toMatchObject({
        unit: 'bytes',
      });
    }
  });

  it('does not claim SingleStore, which is MySQL-compatible and was not measured', () => {
    expect(lengthsOf('length(name) <= 5', 'singlestore')[0]).toMatchObject({
      unit: 'characters',
    });
  });
});

describe('the label stays the constraint the user wrote', () => {
  it('says length on MySQL even though it now counts bytes', () => {
    // The ledger matches an issue's message against this string exactly, so a rewrite here is a
    // map that silently answers nothing.
    expect(lengthCheckLabel(lengthsOf('length(name) <= 5', 'mysql')[0]!)).toBe(
      'c: length(name) <= 5'
    );
  });

  it('says octet_length when that is what was written', () => {
    expect(lengthCheckLabel(lengthsOf('octet_length(name) <= 5', 'mysql')[0]!)).toBe(
      'c: octet_length(name) <= 5'
    );
  });

  it('still normalises char_length to length, which Postgres treats as one function', () => {
    expect(lengthCheckLabel(lengthsOf('char_length(name) <= 5', 'postgres')[0]!)).toBe(
      'c: length(name) <= 5'
    );
  });
});
