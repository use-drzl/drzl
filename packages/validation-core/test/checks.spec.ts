import { describe, it, expect } from 'vitest';
import { parseCheck } from '../src/checks';

const ok = (e: string) => {
  const r = parseCheck(e);
  expect(r.ok, `expected to parse: ${e}`).toBe(true);
  return r.ok ? r.checks : [];
};
const rejected = (e: string) => {
  const r = parseCheck(e);
  expect(r.ok, `expected NOT to parse: ${e}`).toBe(false);
  return r.ok ? '' : r.reason;
};

describe('comparisons against a literal', () => {
  it.each([
    ['age >= 18', '>=', '18'],
    ['age > 18', '>', '18'],
    ['age <= 65', '<=', '65'],
    ['age < 65', '<', '65'],
    ['age = 18', '=', '18'],
    ['age <> 0', '<>', '0'],
  ])('understands %s', (expr, operator, value) => {
    expect(ok(expr)[0]).toMatchObject({ column: 'age', operator, value, kind: 'number' });
  });

  it('normalises != to <>, which mean the same thing', () => {
    expect(ok('age != 0')[0].operator).toBe('<>');
  });

  it('handles a negative bound', () => {
    expect(ok('balance >= -100')[0]).toMatchObject({ value: '-100', kind: 'number' });
  });

  it('handles a decimal bound', () => {
    expect(ok('ratio >= 0.5')[0]).toMatchObject({ value: '0.5', kind: 'number' });
  });

  it('keeps a big bound as text, since a number would round it', () => {
    const c = ok('n <= 9223372036854775807')[0];
    expect(c.value).toBe('9223372036854775807');
    expect(String(Number(c.value))).not.toBe(c.value);
  });
});

describe('string literals', () => {
  it('understands a quoted comparison and unquotes it', () => {
    expect(ok("tier = 'gold'")[0]).toMatchObject({ value: 'gold', kind: 'string' });
  });

  it('undoes SQL doubled quotes', () => {
    expect(ok("name <> 'O''Brien'")[0].value).toBe("O'Brien");
  });
});

describe('BETWEEN', () => {
  it('becomes two inclusive bounds', () => {
    expect(ok('score BETWEEN 0 AND 100')).toEqual([
      { column: 'score', operator: '>=', value: '0', kind: 'number', name: undefined },
      { column: 'score', operator: '<=', value: '100', kind: 'number', name: undefined },
    ]);
  });

  it('is case insensitive, as SQL is', () => {
    expect(ok('score between 0 and 100')).toHaveLength(2);
  });

  it('refuses mixed types, which would mean something unclear', () => {
    expect(rejected("score BETWEEN 0 AND 'x'")).toMatch(/mixed types/);
  });
});

describe('what it refuses, and why that matters', () => {
  it('refuses a comparison between two columns', () => {
    // `start < end` is a statement about the row, not about either field. Attaching it to one
    // would reject rows the database accepts.
    expect(rejected('start_date < end_date')).toMatch(/not a literal/);
  });

  it('refuses an expression whose value was lost', () => {
    expect(rejected('age >= ?')).toMatch(/unresolved/);
  });

  it('refuses a compound predicate rather than guessing its scope', () => {
    expect(rejected('age >= 18 AND age <= 65')).toBeTruthy();
  });

  it('refuses a function call', () => {
    expect(rejected('length(name) > 3')).toBeTruthy();
  });

  it('refuses a regex match, whose dialect is not JavaScript', () => {
    // Postgres `~` is POSIX ERE. Handing that to RegExp would change what is enforced.
    expect(rejected("email ~ '^[a-z]+$'")).toBeTruthy();
  });

  it('refuses an empty expression', () => {
    expect(rejected('')).toMatch(/empty/);
  });
});

describe('the constraint name', () => {
  it('is carried through so a failure can say which check failed', () => {
    const r = parseCheck('age >= 18', 'age_adult');
    expect(r.ok && r.checks[0].name).toBe('age_adult');
  });
});
