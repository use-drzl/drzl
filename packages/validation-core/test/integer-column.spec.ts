/**
 * `isIntegerColumn`, against the real function rather than a copy of it.
 *
 * The analyzer's float work turned on a claim about this function, and the first attempt to assert
 * that claim reimplemented its three lines inside `packages/analyzer/test`, because the analyzer
 * does not depend on this package. Review showed what that cost: deleting the flag branch from the
 * real function left the analyzer suite at 154 passed. A closed loop over a reimplementation
 * measures the copy.
 *
 * So the assertion lives here, where the function does. Deleting
 * `if (typeof c.integer === 'boolean') return c.integer;` from `src/index.ts` fails two cases, run
 * rather than counted: `is not an integer, because the flag says so` and `lets an explicit true
 * through as well, not only false`, which are the first and the last of the eight. An earlier
 * version of this sentence said "the first two", and the second case is the control for the first:
 * it asserts the fallback, which is all the deletion leaves, so it passes by construction.
 *
 * What the analyzer states, and why each case matters:
 *
 *   real                bounded, integer: false   the flag is the only thing between the emitted
 *                                                 schema and `.int()`, since "declares both
 *                                                 bounds" is the fallback
 *   double precision    unbounded, integer: false the flag decides nothing here, and is stated
 *                                                 because it is true of the column
 *
 * Three comments in the analyzer used to say the flag was on the unbounded column to stop a
 * CHECK-derived pair of bounds being read as an integer range. A CHECK never becomes a column
 * bound at all, so that was false twice over, and the pair below is what is actually true.
 */
import { describe, it, expect } from 'vitest';
import { isIntegerColumn } from '../src/index';
import type { Column } from '@drzl/analyzer';

/** What the analyzer emits for a Postgres `real`: the largest double that column accepts. */
const PG_FLOAT4_MAX = '340282356779733661637539395458142568448';

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

/** The same column with the flag removed, which is the state a pre-1.7 analysis produces. */
const withoutFlag = (c: Column): Column => {
  const { integer: _drop, ...rest } = c;
  return rest as Column;
};

describe('a bounded inexact column', () => {
  const real = col({ dbType: 'REAL', min: `-${PG_FLOAT4_MAX}`, max: PG_FLOAT4_MAX, integer: false });

  it('is not an integer, because the flag says so', () => {
    expect(isIntegerColumn(real)).toBe(false);
  });

  it('and is read as one the moment the flag is gone, which is why it is stated', () => {
    // The control for the case above. Without this, the first assertion passes for a function
    // that ignores the flag entirely.
    expect(isIntegerColumn(withoutFlag(real))).toBe(true);
  });
});

describe('an unbounded inexact column', () => {
  const double = col({ dbType: 'DOUBLE', integer: false });

  it('is not an integer', () => {
    expect(isIntegerColumn(double)).toBe(false);
  });

  it('and is not one without the flag either, so the flag decides nothing here', () => {
    expect(isIntegerColumn(withoutFlag(double))).toBe(false);
  });
});

describe('the fallback for an analysis that predates the flag', () => {
  it('reads a declared integer dbType as an integer', () => {
    expect(isIntegerColumn(withoutFlag(col({ dbType: 'INTEGER' })))).toBe(true);
  });

  it('reads a pair of bounds as an integer range', () => {
    expect(isIntegerColumn(withoutFlag(col({ min: '-32768', max: '32767' })))).toBe(true);
  });

  it('needs both ends before it will', () => {
    expect(isIntegerColumn(withoutFlag(col({ min: '-32768' })))).toBe(false);
  });

  it('lets an explicit true through as well, not only false', () => {
    // Both branches of the flag, so a function that returned a constant false would fail here.
    expect(isIntegerColumn(col({ dbType: 'DOUBLE', integer: true }))).toBe(true);
  });
});
