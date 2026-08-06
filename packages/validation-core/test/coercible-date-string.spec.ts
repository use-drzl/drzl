/**
 * The pattern that decides which strings a `mode: 'date'` column may coerce.
 *
 * Every expectation here is a measurement against a real Postgres through PGlite, not a reading of
 * the regex. The columns are `date` and `timestamp`; the two answers per string are "does Postgres
 * take it" and "does `new Date(s)` produce a valid Date", and the pattern's job is to keep the
 * cases where those two disagree out of the coercion.
 */
import { describe, it, expect } from 'vitest';
import { COERCIBLE_DATE_STRING } from '../src/index';

const re = () => new RegExp(COERCIBLE_DATE_STRING);
const coercible = (s: string) => re().test(s);

describe('strings the pattern refuses to coerce', () => {
  it('refuses the three the ground-truth gate caught, which Postgres rejects', () => {
    // `new Date` reads each of these as a year or as month.day. Postgres refuses all three, so
    // the insert passed validation and then failed at the server.
    for (const s of ['0101', '010', '12.5']) {
      expect(coercible(s), s).toBe(false);
    }
  });

  it('refuses every other bare number Postgres rejects', () => {
    for (const s of ['2020', '99', '1', '0', '1700000000000', '.5', '5.', '1e3', ' 2020 ']) {
      expect(coercible(s), s).toBe(false);
    }
  });

  it('refuses the bare numbers Postgres accepts, because the two read them differently', () => {
    // Postgres takes a six or eight digit run as a compact YYMMDD / YYYYMMDD date, so the simple
    // justification "Postgres refuses a bare number" is false. What holds instead is that the two
    // parsers never agree on which date it is: over every all-digit string in the probe set that
    // both accept the two answers differed every single time. Each row below is what a real
    // Postgres stored for that string through PGlite, beside what `new Date` makes of it.
    const BOTH_ACCEPT: Array<[string, string]> = [
      ['200101', '2020-01-01'],
      ['250101', '2025-01-01'],
      ['241231', '2024-12-31'],
      ['121212', '2012-12-12'],
      ['010101', '2001-01-01'],
      ['000101', '2000-01-01'],
      ['111111', '2011-11-11'],
    ];
    for (const [s, postgres] of BOTH_ACCEPT) {
      expect(coercible(s), s).toBe(false);
      const d = new Date(s);
      expect(Number.isNaN(d.getTime()), `${s} is a valid Date in V8`).toBe(false);
      expect(d.toISOString().slice(0, 10), `${s} in V8 vs Postgres`).not.toBe(postgres);
    }
    // Eight digits: Postgres accepts, V8 refuses outright since the year exceeds its 275760 cap.
    for (const s of ['20200101', '19990108']) {
      expect(coercible(s), s).toBe(false);
      expect(Number.isNaN(new Date(s).getTime()), `${s} in V8`).toBe(true);
    }
  });

  it('refuses a leading sign, which V8 accepts and Postgres does not', () => {
    for (const s of ['+2020-01-01', '-2020-01-01', '+1', '-1']) {
      expect(coercible(s), s).toBe(false);
    }
    // The sign-prefixed strings Postgres does take, and no JS Date represents any of them, so a
    // `mode: 'date'` column could never carry one whatever this pattern said.
    for (const s of ['+infinity', '-infinity']) {
      expect(coercible(s), s).toBe(false);
      expect(Number.isNaN(new Date(s).getTime()), `${s} in V8`).toBe(true);
    }
  });

  it('refuses an empty or blank string', () => {
    for (const s of ['', '  ', '\t\n']) {
      expect(coercible(s), JSON.stringify(s)).toBe(false);
    }
  });
});

describe('strings the pattern still coerces', () => {
  it('takes every notation Postgres and V8 both read as the same date', () => {
    for (const s of [
      '2020-01-01',
      '2020-01-01T00:00:00Z',
      '2020-01-01 00:00:00',
      '1999-01-08 04:05:06',
      '01/02/2020',
      'January 8, 1999',
      '2020-1-5',
      '  2020-01-01  ',
    ]) {
      expect(coercible(s), s).toBe(true);
      expect(Number.isNaN(new Date(s).getTime()), `${s} in V8`).toBe(false);
    }
  });

  it('is anchored, so a date buried inside a refused string stays refused', () => {
    // The pattern is all lookahead, and `test` is unhooked from any anchor the caller adds, so
    // this asserts the `^` is doing its work rather than the match sliding along the string.
    expect(coercible('0101')).toBe(false);
    expect(coercible('12.5')).toBe(false);
  });
});
