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

  it('refuses a disjunction it cannot state as one set of values', () => {
    // A conjunction is safe to break apart because every part has to hold on its own. A
    // disjunction is not: it is *weaker* than any one branch, so enforcing a branch would turn
    // away rows the database takes. Only the shape that collapses to a single set of literal
    // values is read; everything else is refused whole. See the `disjunctions` block below.
    expect(rejected('age >= 18 OR age <= 65')).toMatch(/range/);
    expect(rejected('NOT (age >= 18)')).toMatch(/NOT/);
  });

  it('refuses a whole conjunction when any one part is not understood', () => {
    // Enforcing half of a constraint is enforcing a different constraint.
    expect(rejected("age >= 18 AND lower(name) = 'x'")).toMatch(/part of an AND/);
    expect(rejected("age >= 18 AND email ~ '^[a-z]+$'")).toMatch(/part of an AND/);
  });

  it('refuses a function call it cannot map exactly', () => {
    // `length` and `octet_length` are read, because each maps exactly onto one JavaScript
    // measurement: see `test/octet-length.spec.ts`. These do not: `lower` would need a locale to
    // be faithful, and `abs` is arithmetic on a value this parser never evaluates.
    expect(rejected("lower(name) = 'x'")).toBeTruthy();
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

  it('splits a bare AND with no spaces around it', () => {
    // Postgres accepts `(a=1)AND(b=2)`. The keyword is matched as a whole token rather than as a
    // substring with spaces on both sides, which is also what keeps the AND inside `BRAND` shut.
    expect(parseCheck('(a=1)AND(b=2)').ok && parseCheck('(a=1)AND(b=2)')).toMatchObject({
      checks: [{ column: 'a' }, { column: 'b' }],
    });
    expect(parseCheck('brand = 1').ok).toBe(true);
  });

  it('reads a NOT inside a string literal as text, not as a negation', () => {
    // The guard walks the expression rather than matching it, so a constraint on a column whose
    // value happens to contain the word is enforced rather than refused.
    const r = parseCheck("label = 'A NOT B'");
    expect(r.ok && r.checks[0].value).toBe('A NOT B');
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
  // Counted in code points by the generators, since Postgres counts characters and `.length`
  // counts UTF-16 units. `octet_length` is the byte-count sibling and has its own file.
  it('reads length() and char_length() alike', () => {
    for (const e of ['length(name) > 3', 'char_length(name) > 3', 'LENGTH(name) > 3']) {
      const r = parseCheck(e, 'min_name');
      expect(r.ok, e).toBe(true);
      if (!r.ok) continue;
      expect(r.checks, 'not a value comparison').toHaveLength(0);
      expect(r.lengths).toEqual([
        { column: 'name', operator: '>', value: '3', unit: 'characters', name: 'min_name' },
      ]);
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

describe('disjunctions', () => {
  // A conjunction splits because every part holds independently. A disjunction does not: it is
  // weaker than any of its branches, so enforcing one branch rejects rows the database accepts.
  // The one shape that survives that is a disjunction of equalities on a single column, which is
  // the same statement as an IN list and is returned as one.
  it('folds equalities on one column into the set they describe', () => {
    const r = parseCheck("status = 'draft' OR status = 'live'", 'status_valid');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.checks, 'stated as a set rather than as two predicates').toHaveLength(0);
    expect(r.sets).toEqual([
      { column: 'status', values: ['draft', 'live'], kind: 'string', name: 'status_valid' },
    ]);
  });

  it('folds a numeric disjunction the same way', () => {
    const r = parseCheck('level = 1 OR level = 2 OR level = 3');
    expect(r.ok && r.sets![0]).toMatchObject({ values: ['1', '2', '3'], kind: 'number' });
  });

  it('absorbs an IN list standing beside an equality', () => {
    const r = parseCheck("s IN ('a', 'b') OR s = 'c'");
    expect(r.ok && r.sets![0].values).toEqual(['a', 'b', 'c']);
  });

  it('drops a value the disjunction names twice', () => {
    const r = parseCheck("s = 'a' OR s = 'a'");
    expect(r.ok && r.sets![0].values).toEqual(['a']);
  });

  it('is case insensitive and sees through parentheses around each branch', () => {
    const r = parseCheck("(s = 'a') or (s = 'b')");
    expect(r.ok && r.sets![0].values).toEqual(['a', 'b']);
  });

  it('splits on a bare OR with no spaces around it', () => {
    expect(parseCheck("(s='a')OR(s='b')").ok).toBe(true);
  });

  it('does not split an OR inside a string literal', () => {
    const r = parseCheck("label = 'A OR B'");
    expect(r.ok && r.checks[0].value).toBe('A OR B');
  });

  it('does not read the OR inside a longer word', () => {
    // `XOR` is one token. Splitting on the OR inside it would cut an operator in half and hand
    // both halves to a parser that would read them as something else.
    expect(rejected('a XOR b')).not.toMatch(/branch/);
  });

  it('refuses the whole constraint when one branch is not understood', () => {
    // Not "emit the parseable branch". A disjunction is satisfied by *either* side, so a schema
    // enforcing only the readable one rejects every row that satisfied the other. The whole
    // constraint is refused, which is visible in `drzl doctor` and in the constraint ledger.
    expect(rejected("s = 'a' OR lower(s) = 'b'")).toMatch(/part of an OR/);
  });

  it('refuses branches over ranges, which are not a set of values', () => {
    expect(rejected('n < 0 OR n > 100')).toMatch(/range/);
    expect(rejected('n BETWEEN 1 AND 5 OR n = 9')).toMatch(/range/);
  });

  it('refuses branches naming different columns, which is a rule about the row', () => {
    const reason = rejected("a = '1' OR b = '2'");
    expect(reason).toMatch(/different columns/);
    expect(reason, 'names them, so the report is actionable').toMatch(/a.*b/);
  });

  it('refuses a disjunction mixing a string and a number', () => {
    expect(rejected("s = 'a' OR s = 1")).toMatch(/mix/);
  });

  it('carries a folded disjunction through a conjunction', () => {
    const r = parseCheck("(s = 'a' OR s = 'b') AND n > 0");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sets![0].values).toEqual(['a', 'b']);
    expect(r.checks).toHaveLength(1);
  });

  it('refuses a conjunction whose disjunctive part is not understood', () => {
    expect(rejected('(n < 0 OR n > 9) AND m > 0')).toMatch(/part of an AND/);
  });
});

describe('a null guard in front of a predicate', () => {
  // `CHECK (col IS NULL OR col > 0)` is written defensively and states nothing extra: a CHECK
  // already passes when it evaluates to NULL, and every operator here yields NULL when its column
  // is NULL. So the guard branch is dropped and the predicate is read on its own.
  it('reduces to the predicate it guards', () => {
    const r = parseCheck('age IS NULL OR age >= 18', 'age_adult');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.checks).toEqual([
      { column: 'age', operator: '>=', value: '18', kind: 'number', name: 'age_adult' },
    ]);
    expect(r.nulls ?? [], 'the guard itself narrows nothing').toHaveLength(0);
  });

  it('reduces in front of a set, and in front of a folded disjunction', () => {
    expect(parseCheck("s IS NULL OR s IN ('a','b')").ok && true).toBe(true);
    const r = parseCheck("s IS NULL OR s = 'a' OR s = 'b'");
    expect(r.ok && r.sets![0].values).toEqual(['a', 'b']);
  });

  it('reduces in front of a character count on the same column', () => {
    const r = parseCheck('name IS NULL OR length(name) > 3');
    expect(r.ok && r.lengths).toHaveLength(1);
  });

  it('reduces in front of a comparison of two columns, one of them the guarded one', () => {
    // `a IS NULL OR a < b` and `a < b` accept the same rows: with `a` NULL the first is TRUE and
    // the second is NULL, and a CHECK passes on both. Measured against Postgres.
    const r = parseCheck('a IS NULL OR a < b');
    expect(r.ok && r.rows).toEqual([{ left: 'a', right: 'b', operator: '<', name: undefined }]);
  });

  it('refuses a guard on a column the predicate never names', () => {
    // `a IS NULL OR b > 0` is not `b > 0`: with `a` NULL every row passes whatever `b` holds.
    // The reduction is sound only because the predicate is NULL exactly when its column is.
    expect(rejected('a IS NULL OR b > 0')).toMatch(/does not name/);
  });

  it('refuses a guard in front of a null test, which is not NULL-yielding', () => {
    // `a IS NULL OR a IS NOT NULL` is true of every row. Reducing it to `a IS NOT NULL` would
    // refuse every NULL the database takes.
    expect(rejected('a IS NULL OR a IS NOT NULL')).toBeTruthy();
  });

  it('refuses a disjunction of guards, which is a rule about the row', () => {
    expect(rejected('a IS NULL OR b IS NULL')).toBeTruthy();
  });
});

describe('unary predicates', () => {
  // `IS NOT NULL` holds the word NOT, and the guard that refuses logical negation would otherwise
  // refuse it. `IS NOT` is one operator, not a negation, and the guard knows the difference.
  it('reads IS NOT NULL', () => {
    const r = parseCheck('email IS NOT NULL', 'email_required');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.checks, 'not a value comparison').toHaveLength(0);
    expect(r.nulls).toEqual([{ column: 'email', notNull: true, name: 'email_required' }]);
  });

  it('reads IS NULL', () => {
    const r = parseCheck('email IS NULL');
    expect(r.ok && r.nulls).toEqual([{ column: 'email', notNull: false }]);
  });

  it('is case insensitive and sees through wrapping parentheses', () => {
    expect(parseCheck('(email is not null)').ok).toBe(true);
  });

  it('carries through a conjunction beside a value comparison', () => {
    const r = parseCheck('email IS NOT NULL AND age >= 18');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.nulls).toHaveLength(1);
    expect(r.checks).toHaveLength(1);
  });

  it('still refuses a logical NOT', () => {
    expect(rejected('NOT (age >= 18)')).toMatch(/NOT/);
    expect(rejected('age >= 18 AND NOT (age > 65)')).toMatch(/NOT/);
    expect(rejected("s NOT IN ('a','b')")).toMatch(/NOT/);
  });

  it('reads IS DISTINCT FROM as the null-safe <>, which as a CHECK is plain <>', () => {
    // `NULL IS DISTINCT FROM 5` is TRUE and `NULL <> 5` is NULL, and a CHECK passes on both, so
    // the two constrain exactly the same rows. Measured against Postgres.
    const r = parseCheck('n IS DISTINCT FROM 5');
    expect(r.ok && r.checks).toEqual([
      { column: 'n', operator: '<>', value: '5', kind: 'number', name: undefined },
    ]);
  });

  it('reads IS NOT DISTINCT FROM as an equality that also refuses NULL', () => {
    const r = parseCheck('n IS NOT DISTINCT FROM 5');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.checks[0]).toMatchObject({ operator: '=', value: '5' });
    expect(r.nulls).toEqual([{ column: 'n', notNull: true }]);
  });

  it('refuses a boolean IS test, whose literal this version does not read', () => {
    const reason = rejected('flag IS TRUE');
    expect(reason).toMatch(/boolean/);
    expect(rejected('flag IS NOT FALSE')).toMatch(/boolean/);
  });

  it('does not let an IS operand swallow a following AND', () => {
    // The same trap `BETWEEN` documents, in the other direction. `BETWEEN` holds an AND and so is
    // matched before the split; `IS DISTINCT FROM` does not, so it is matched *after* it. Matched
    // first, its trailing operand would read `5 AND b > 0` and the second half would be dropped.
    const r = parseCheck('a IS DISTINCT FROM 5 AND b > 0');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.checks).toHaveLength(2);
    expect(r.checks.map((c) => c.column)).toEqual(['a', 'b']);
  });
});

describe('expressions over two columns beyond a comparison', () => {
  // Refused, and deliberately. Postgres computes `numeric` arithmetic exactly and JavaScript
  // computes it in binary floating point: `CHECK (x + y <= 0.3)` on two `numeric` columns accepts
  // (0.1, 0.2), and the same expression in JavaScript is 0.30000000000000004 and rejects it. The
  // parser cannot tell a `numeric` column from a `double precision` one, so the only translation
  // available is one that is wrong for half of them.
  it('refuses arithmetic between columns, and says that is what it is', () => {
    for (const e of ['a + b < 100', 'a > b + 1', 'a - b <= 10', 'a * b > 0', 'qty / n < 5']) {
      expect(rejected(e), e).toMatch(/arithmetic|combin/i);
    }
  });

  it('refuses string concatenation the same way', () => {
    expect(rejected("first || last <> ''")).toMatch(/arithmetic|combin/i);
  });

  it('names the operator, so the report says which part it could not read', () => {
    expect(rejected('a + b < 100')).toContain('+');
  });

  it('does not mistake a negative literal for arithmetic', () => {
    expect(parseCheck('balance >= -100').ok).toBe(true);
  });
});
