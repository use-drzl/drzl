/**
 * The short-circuit around a code-point count, held to the one thing that makes it sound.
 *
 * `[...v].length` allocates an array of code points, and it sits on the path every ordinary row
 * takes. A UTF-16 unit count is free and is never smaller than a code-point count, since only a
 * surrogate pair spends two units on one code point. That single fact is what lets each operator
 * skip the spread in one direction, and it is the fact this file attacks: every case here builds
 * the emitted expression, evaluates it, and compares it against the bare spread on the same input.
 *
 * The awkward inputs are chosen to break the assumption if it can be broken (astral pairs,
 * combining marks that are two code points and look like one, a lone surrogate, the empty string,
 * CJK exactly at the bound), and a pseudo-random pool runs behind them because chosen cases test
 * what the author thought of.
 */
import { describe, it, expect } from 'vitest';
import { codePointCompare, measureCompare } from '../src/checks';

const OPS = ['<=', '<', '>=', '>', '===', '!=='] as const;

/** The plain form, which is what the short-circuit has to agree with on every input. */
const plain = (op: (typeof OPS)[number], v: string, n: number) => {
  switch (op) {
    case '<=':
      return [...v].length <= n;
    case '<':
      return [...v].length < n;
    case '>=':
      return [...v].length >= n;
    case '>':
      return [...v].length > n;
    case '===':
      return [...v].length === n;
    case '!==':
      return [...v].length !== n;
  }
};

/** The emitted expression, evaluated. Built as source, because source is what ships. */
const emitted = (op: (typeof OPS)[number], v: string, n: number) => {
  const expr = codePointCompare('v', op, n);
  return new Function('v', `return ${expr};`)(v) as boolean;
};

const AWKWARD: Array<[string, string]> = [
  ['empty', ''],
  ['one ascii', 'x'],
  ['ascii at the bound', 'x'.repeat(8)],
  ['ascii one over', 'x'.repeat(9)],
  ['CJK at the bound', '一'.repeat(8)],
  ['emoji, half the units', '\u{1F44D}'.repeat(4)],
  ['emoji at the bound in code points', '\u{1F44D}'.repeat(8)],
  ['emoji one over', '\u{1F44D}'.repeat(9)],
  ['combining marks', 'é'.repeat(4)],
  ['a lone high surrogate', '\uD83D'],
  ['a lone low surrogate', '\uDE00'],
  ['mixed', 'a\u{1F600}b一'],
];

describe('codePointCompare agrees with the spread it replaces', () => {
  it.each(OPS)('on %s, over the awkward inputs', (op) => {
    for (const [label, v] of AWKWARD) {
      for (const n of [0, 1, 8, 9, 64]) {
        expect(emitted(op, v, n), `${label} against ${n}`).toBe(plain(op, v, n));
      }
    }
  });

  it('agrees over a pseudo-random pool, because chosen cases test what the author thought of', () => {
    let seed = 987654321;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let checked = 0;
    for (let i = 0; i < 4000; i++) {
      const len = Math.floor(rnd() * 20);
      let v = '';
      for (let j = 0; j < len; j++) {
        const r = rnd();
        v +=
          r < 0.5
            ? 'x'
            : r < 0.7
              ? '一'
              : r < 0.9
                ? String.fromCodePoint(0x1f600 + Math.floor(rnd() * 40))
                : '́';
      }
      const n = Math.floor(rnd() * 20);
      for (const op of OPS) {
        expect(emitted(op, v, n), `${JSON.stringify(v)} ${op} ${n}`).toBe(plain(op, v, n));
        checked++;
      }
    }
    expect(checked).toBe(4000 * OPS.length);
  });
});

describe('which direction each operator skips the spread in', () => {
  it('short-circuits a cap on the accept side, where every ordinary row lands', () => {
    // The point of the change: a string whose unit count already fits never gets spread.
    expect(codePointCompare('v', '<=', 64)).toBe('(v.length <= 64 || [...v].length <= 64)');
  });

  it('short-circuits a minimum on the reject side, which is the only sound half there', () => {
    expect(codePointCompare('v', '>=', 3)).toBe('(v.length >= 3 && [...v].length >= 3)');
  });

  it('reads the variable it is given, since the generators put the count in three places', () => {
    expect(codePointCompare('o["blob"]', '<=', 5)).toContain('o["blob"].length <= 5');
  });
});

describe('measureCompare picks the rewrite by measurement', () => {
  it('rewrites a code-point count', () => {
    expect(measureCompare('codePoints', 'v', '<=', 10)).toBe('(v.length <= 10 || [...v].length <= 10)');
  });

  it('leaves a byte count alone, since its own length is already the answer', () => {
    expect(measureCompare('byteLength', 'v', '<=', 10)).toBe('v.length <= 10');
  });

  it('leaves the UTF-8 encoding alone, which has a different allocation to weigh', () => {
    expect(measureCompare('utf8Bytes', 'v', '>=', 3)).toBe(
      'new TextEncoder().encode(v).length >= 3'
    );
  });

  it('takes the SQL spelling of the operator, so no generator maps it twice', () => {
    expect(measureCompare('codePoints', 'v', '=', 4)).toBe('(v.length >= 4 && [...v].length === 4)');
    expect(measureCompare('codePoints', 'v', '<>', 4)).toBe('(v.length < 4 || [...v].length !== 4)');
  });
});
