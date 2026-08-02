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
    // `start < end` is a statement about the row, not about either field, so it is not returned
    // as a field check. It is returned as a row check instead, and the object schema carries it.
    const r = parseCheck('start_date < end_date');
    expect(r.ok && r.checks).toHaveLength(0);
    expect(r.ok && r.rows).toHaveLength(1);
  });

  it('refuses an expression whose value was lost', () => {
    expect(rejected('age >= ?')).toMatch(/unresolved/);
  });

  it('refuses a disjunction, whose scope cannot be split', () => {
    // A conjunction is safe to break apart because every part has to hold on its own. A
    // disjunction is not, and telling the two apart inside a mixed expression needs a real
    // parser, so anything containing OR or NOT is refused outright.
    expect(rejected('age >= 18 OR age <= 65')).toMatch(/OR/);
    expect(rejected('NOT (age >= 18)')).toMatch(/NOT/);
  });

  it('refuses a whole conjunction when any one part is not understood', () => {
    // Enforcing half of a constraint is enforcing a different constraint.
    expect(rejected("age >= 18 AND lower(name) = 'x'")).toMatch(/part of an AND/);
    expect(rejected("age >= 18 AND email ~ '^[a-z]+$'")).toMatch(/part of an AND/);
  });

  it('refuses a function call it cannot map exactly', () => {
    // `length` is read, because a character count maps exactly. These do not: `lower` would need
    // a locale to be faithful, and `octet_length` counts bytes, which depends on the encoding and
    // cannot be derived from a JavaScript string without picking one.
    expect(rejected("lower(name) = 'x'")).toBeTruthy();
    expect(rejected('octet_length(name) > 3')).toBeTruthy();
    expect(rejected('abs(n) > 3')).toBeTruthy();
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

describe('conjunctions', () => {
  // Every part of an AND has to hold independently, which is exactly what a list of checks means,
  // so a conjunction can be split where a disjunction cannot. Verified against Postgres: a column
  // with `CHECK (age >= 18 AND age <= 65)` accepts 18, 40 and 65, rejects 17 and 66, and accepts
  // NULL, which is what the checks sitting inside `.nullable()` reproduces.
  it('splits into one check per part', () => {
    const r = parseCheck('age >= 18 AND age <= 65', 'age_range');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.checks).toHaveLength(2);
    expect(r.checks.map((c) => `${c.operator}${c.value}`)).toEqual(['>=18', '<=65']);
  });

  it('handles more than two parts', () => {
    const r = parseCheck('n > 0 AND n < 10 AND n <> 5');
    expect(r.ok && r.checks).toHaveLength(3);
  });

  it('sees through parentheses wrapping the whole expression', () => {
    const r = parseCheck('(age >= 18 AND age <= 65)');
    expect(r.ok && r.checks).toHaveLength(2);
  });

  it('does not split the AND inside a BETWEEN', () => {
    // That AND belongs to the operator. Splitting on it first turned every BETWEEN into an
    // unparseable pair and silently dropped a constraint that had been enforced.
    const r = parseCheck('x BETWEEN 1 AND 10');
    expect(r.ok && r.checks.map((c) => `${c.operator}${c.value}`)).toEqual(['>=1', '<=10']);
  });

  it('does not split an AND inside a string literal', () => {
    const r = parseCheck("label = 'A AND B'");
    expect(r.ok && r.checks).toHaveLength(1);
    expect(r.ok && r.checks[0].value).toBe('A AND B');
  });
});

describe('IN lists', () => {
  // The constraint most often written as a CHECK, and one no official validator module enforces.
  it('reads a string set', () => {
    const r = parseCheck("status IN ('active', 'archived')", 'status_valid');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sets).toHaveLength(1);
    expect(r.sets![0]).toMatchObject({
      column: 'status',
      values: ['active', 'archived'],
      kind: 'string',
    });
  });

  it('reads a numeric set', () => {
    const r = parseCheck('level IN (1, 2, 3)');
    expect(r.ok && r.sets![0]).toMatchObject({ values: ['1', '2', '3'], kind: 'number' });
  });

  it('combines with a comparison on another column', () => {
    const r = parseCheck("status IN ('a', 'b') AND age > 0");
    expect(r.ok && r.checks).toHaveLength(1);
    expect(r.ok && r.sets).toHaveLength(1);
  });

  it('refuses a list that mixes types or holds a non-literal', () => {
    expect(rejected("s IN ('a', 1)")).toMatch(/mixes types/);
    expect(rejected('s IN (a, b)')).toBeTruthy();
    expect(rejected('s IN (other_column)')).toBeTruthy();
  });

  it('keeps a quoted comma inside one value', () => {
    const r = parseCheck("s IN ('a,b', 'c')");
    expect(r.ok && r.sets![0].values).toEqual(['a,b', 'c']);
  });
});

describe('row-level comparisons', () => {
  // `start_date < end_date` is a statement about the row: neither column alone can say whether it
  // holds, so it cannot be a field refinement. It was refused outright for that reason. It is
  // exactly expressible on the *object* schema, which is where it goes now.
  it('reads a comparison between two columns', () => {
    const r = parseCheck('start_date < end_date', 'date_order');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.checks).toHaveLength(0);
    expect(r.rows).toEqual([
      { left: 'start_date', right: 'end_date', operator: '<', name: 'date_order' },
    ]);
  });

  it('normalises != to <>', () => {
    const r = parseCheck('a != b');
    expect(r.ok && r.rows![0].operator).toBe('<>');
  });

  it('carries through a conjunction alongside field checks', () => {
    const r = parseCheck('price > 0 AND price <= max_price');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.checks).toHaveLength(1);
    expect(r.rows).toHaveLength(1);
  });

  it('still refuses an expression on the right, which is not a column', () => {
    // `a + b` is arithmetic this parser does not model, and guessing at it would enforce
    // something the schema never said.
    expect(rejected('a > b + 1')).toBeTruthy();
    expect(rejected('a + b > 0')).toBeTruthy();
  });
});

describe('character-count constraints', () => {
  // The one function call this parser reads, because the mapping is exact. Counted in code
  // points by the generators, since Postgres counts characters and `.length` counts UTF-16 units.
  it('reads length() and char_length() alike', () => {
    for (const e of ['length(name) > 3', 'char_length(name) > 3', 'LENGTH(name) > 3']) {
      const r = parseCheck(e, 'min_name');
      expect(r.ok, e).toBe(true);
      if (!r.ok) continue;
      expect(r.checks, 'not a value comparison').toHaveLength(0);
      expect(r.lengths).toEqual([{ column: 'name', operator: '>', value: '3', name: 'min_name' }]);
    }
  });

  it('carries both ends of a conjunction', () => {
    const r = parseCheck('length(a) > 3 AND length(a) < 10');
    expect(r.ok && r.lengths).toHaveLength(2);
  });

  it('normalises != to <>', () => {
    const r = parseCheck('length(a) != 5');
    expect(r.ok && r.lengths![0].operator).toBe('<>');
  });

  it('refuses a comparison against anything but a number', () => {
    expect(rejected('length(a) > b')).toBeTruthy();
    expect(rejected("length(a) > '3'")).toBeTruthy();
  });
});

describe('array cardinality', () => {
  // `cardinality(tags) > 0` is the array analogue of `length(name) > 3`, and the mapping is just
  // as exact: it is the element count, which JavaScript spells `.length` on an array with no
  // encoding question attached. Verified against Postgres: the constraint rejects `[]` and
  // accepts `['a']`.
  it('reads cardinality() as an element count', () => {
    const r = parseCheck('cardinality(tags) > 0', 'not_empty');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.checks, 'not a value comparison').toHaveLength(0);
    expect(r.cardinalities).toEqual([
      { column: 'tags', operator: '>', value: '0', name: 'not_empty' },
    ]);
  });

  it('reads array_length(col, 1) too, which is the older spelling', () => {
    // `array_length(a, 1)` is the length of the first dimension, which for a one-dimensional
    // array is the same number `cardinality` gives.
    const r = parseCheck('array_length(tags, 1) <= 5');
    expect(r.ok && r.cardinalities).toEqual([{ column: 'tags', operator: '<=', value: '5' }]);
  });

  it('refuses a dimension other than the first, which is not the element count', () => {
    expect(rejected('array_length(grid, 2) > 0')).toBeTruthy();
  });

  it('carries both ends of a conjunction', () => {
    const r = parseCheck('cardinality(a) > 0 AND cardinality(a) < 10');
    expect(r.ok && r.cardinalities).toHaveLength(2);
  });
});
