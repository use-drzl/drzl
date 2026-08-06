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
import { nonFiniteAccepted } from '../src/index';
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
