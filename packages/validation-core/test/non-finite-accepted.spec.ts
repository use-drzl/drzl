/**
 * `nonFiniteAccepted`, against the real function rather than a copy of it.
 *
 * Four generators read it and each renders a different repair, so what has to hold in one place is
 * the *reading*: which columns answer yes, and which can never answer yes however the analysis
 * drifts. The guard is the part worth a test. Deleting `c.tsType !== 'number' || c.shape` from
 * `src/index.ts` fails the last case below and only that one, run rather than counted, which is the
 * whole point of it: a stale or hand-written analysis carrying the flags on a string or a shaped
 * column would otherwise put a `z.nan()` branch beside a `z.string()`.
 */
import { describe, it, expect } from 'vitest';
import { nonFiniteAccepted, nonFiniteRefused } from '../src/index';
import type { Column } from '@drzl/analyzer';

const col = (over: Partial<Column>): Column =>
  ({
    name: 'c',
    tsType: 'number',
    dbType: 'DOUBLE',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

describe('nonFiniteAccepted', () => {
  it('reads what the analyzer stated for a postgres float', () => {
    expect(nonFiniteAccepted(col({ allowsNaN: true, allowsInfinity: true }))).toEqual({
      nan: true,
      infinity: true,
    });
  });

  it('separates the numeric answer from the float one', () => {
    // `numeric({ mode: 'number' })` takes NaN and no infinity, because Postgres refuses an infinity
    // in any `numeric` carrying a precision and nothing reads a column's precision.
    expect(
      nonFiniteAccepted(col({ dbType: 'NUMERIC', allowsNaN: true, allowsInfinity: false }))
    ).toEqual({ nan: true, infinity: false });
  });

  it('answers no for a column that states nothing, which is every other dialect', () => {
    expect(nonFiniteAccepted(col({ dbType: 'REAL' }))).toEqual({ nan: false, infinity: false });
    expect(nonFiniteAccepted(col({ dbType: 'INTEGER', integer: true }))).toEqual({
      nan: false,
      infinity: false,
    });
  });

  it('refuses to answer yes for anything that is not a plain number', () => {
    // Both guards, with the flags set, so a passing case here cannot be the flags being absent.
    expect(
      nonFiniteAccepted(col({ tsType: 'string', allowsNaN: true, allowsInfinity: true }))
    ).toEqual({ nan: false, infinity: false });
    expect(
      nonFiniteAccepted(
        col({ shape: { kind: 'numberVector', length: 3 }, allowsNaN: true, allowsInfinity: true })
      )
    ).toEqual({ nan: false, infinity: false });
  });
});

describe('nonFiniteRefused', () => {
  it('reads the MySQL answer, which is the flags stated as false rather than left off', () => {
    expect(
      nonFiniteRefused(col({ dbType: 'DOUBLE', allowsNaN: false, allowsInfinity: false }))
    ).toEqual({ nan: true, infinity: true });
  });

  it('is not the negation of nonFiniteAccepted, which is the whole point of it', () => {
    // The third state. A SQLite `real` states neither flag, and the engine really does store both
    // infinities and hand them back, so "not accepted" must not become "refuse it". Both functions
    // answer no here and every generator leaves the column exactly as its library renders it.
    const unstated = col({ dbType: 'REAL' });
    expect(nonFiniteAccepted(unstated)).toEqual({ nan: false, infinity: false });
    expect(nonFiniteRefused(unstated)).toEqual({ nan: false, infinity: false });
  });

  it('separates the two halves, as a postgres numeric in number mode needs', () => {
    // Postgres stores NaN in a `numeric` of any width and refuses either infinity in one carrying a
    // precision, so this column answers yes to one function on one flag and yes to the other on the
    // other. A reading that could only be all or nothing would be wrong about it either way.
    const c = col({ dbType: 'NUMERIC', allowsNaN: true, allowsInfinity: false });
    expect(nonFiniteAccepted(c)).toEqual({ nan: true, infinity: false });
    expect(nonFiniteRefused(c)).toEqual({ nan: false, infinity: true });
  });

  it('refuses to answer yes for anything that is not a plain number', () => {
    // The same guard as its sibling, with the flags set to the answering value, so a passing case
    // here cannot be the flags being absent.
    expect(
      nonFiniteRefused(col({ tsType: 'string', allowsNaN: false, allowsInfinity: false }))
    ).toEqual({ nan: false, infinity: false });
    expect(
      nonFiniteRefused(
        col({ shape: { kind: 'numberVector', length: 3 }, allowsNaN: false, allowsInfinity: false })
      )
    ).toEqual({ nan: false, infinity: false });
  });
});
