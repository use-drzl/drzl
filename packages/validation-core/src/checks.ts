/**
 * Turning a SQL CHECK constraint into something a validator can enforce.
 *
 * No official Drizzle validator module does this. Verified against `drizzle-orm/zod` at
 * 1.0.0-rc.4: a table with `check('age_adult', sql`${t.age} >= 18`)` produces an insert schema
 * that accepts `{ age: 5 }`. The constraint is in the schema, the database will reject the row,
 * and the validator says nothing.
 *
 * Only expressions whose meaning is unambiguous are translated. Everything else is reported and
 * skipped, because a validator that quietly enforces a *guess* at your constraint is worse than
 * one that enforces nothing: it rejects rows the database would have accepted.
 *
 * Two pieces of SQL semantics that a naive translation gets wrong:
 *
 * 1. **A CHECK passes when it evaluates to TRUE *or NULL*.** So `CHECK (age >= 18)` on a
 *    nullable column accepts NULL. Emitting `.gte(18)` on the inner type and applying
 *    `.nullable()` around it reproduces that exactly, which is why the constraint belongs on the
 *    base expression rather than on the whole field.
 * 2. **A multi-column check cannot live on a field.** `start_date < end_date` is a statement
 *    about the row, so it is not returned here at all.
 * 3. **A conjunction splits and a disjunction does not.** Every part of an `AND` has to hold on
 *    its own, so a list of checks says exactly what it says. An `OR` is *weaker* than either
 *    branch: a schema enforcing one branch turns away every row that satisfied the other. So a
 *    disjunction is read only where the whole of it collapses to one statement, and refused
 *    whole otherwise. See `parseDisjunction`.
 */

/** A comparison of one column against one literal, which is the case worth translating. */
export interface ColumnCheck {
  /** Column the constraint is about, as it appears in the expression. */
  column: string;
  operator: '>=' | '>' | '<=' | '<' | '=' | '<>';
  /** The literal, still as text: a 64 bit bound must not pass through a JS number. */
  value: string;
  /** Whether the literal was quoted, which distinguishes `'5'` from `5`. */
  kind: 'number' | 'string';
  /** Constraint name, used to say which one failed. */
  name?: string;
}

/**
 * A column constrained to a set of literals, from `col IN ('a', 'b')`.
 *
 * Kept separate from `ColumnCheck` rather than folded into it as another operator, so the
 * existing shape is unchanged for anything already consuming it.
 */
export interface ColumnSet {
  column: string;
  values: string[];
  kind: 'number' | 'string';
  name?: string;
}

/**
 * A comparison between two columns of the same row, from `CHECK (start_date < end_date)`.
 *
 * It cannot live on a field, because it is a statement about the row: neither column alone can
 * say whether it holds. It can live on the *object* schema, which is where this ends up.
 */
export interface RowCheck {
  left: string;
  right: string;
  operator: ColumnCheck['operator'];
  name?: string;
}

/**
 * A constraint on a column's *character* count, from `CHECK (length(name) > 3)`.
 *
 * Kept apart from `ColumnCheck` because it is not a comparison of the value: it compares a count
 * derived from it, and the count Postgres takes is code points rather than UTF-16 units. See
 * `CODEPOINT_LENGTH` for why that distinction is load bearing.
 */
export interface LengthCheck {
  column: string;
  operator: ColumnCheck['operator'];
  /** Decimal, as text, matching how the other bounds are carried. */
  value: string;
  name?: string;
}

/**
 * A constraint on an array column's element count, from `CHECK (cardinality(tags) > 0)`.
 *
 * The array analogue of `LengthCheck`, and free of the question that one carries: an element
 * count is the same number in SQL and in JavaScript, with no encoding involved.
 */
export interface CardinalityCheck {
  column: string;
  operator: ColumnCheck['operator'];
  value: string;
  name?: string;
}

/**
 * A test of whether a column holds NULL, from `CHECK (col IS NOT NULL)`.
 *
 * Not a comparison: SQL's comparison operators all yield NULL against a NULL operand, and these
 * two are the operators that answer TRUE or FALSE instead. That is why they are a kind of their
 * own rather than another `operator` on `ColumnCheck`, whose whole placement rule is that a check
 * sits *inside* the nullable wrapper because NULL never reaches it.
 *
 * `notNull` is the only direction any emitted schema states, and it states it by not being
 * nullable rather than by carrying a predicate. `IS NULL` is carried so the constraint can be
 * reported precisely rather than as "not understood", and is enforced nowhere.
 */
export interface NullCheck {
  column: string;
  /** `true` for `IS NOT NULL`, `false` for `IS NULL`. */
  notNull: boolean;
  name?: string;
}

/** A check that was understood, or the reason it was not. */
export type ParsedCheck =
  | {
      ok: true;
      checks: ColumnCheck[];
      sets?: ColumnSet[];
      rows?: RowCheck[];
      lengths?: LengthCheck[];
      cardinalities?: CardinalityCheck[];
      nulls?: NullCheck[];
    }
  | { ok: false; reason: string };

const COMPARISON = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(>=|<=|<>|!=|>|<|=)\s*(.+?)\s*$/;
const IN_LIST = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+IN\s*\((.+)\)\s*$/i;
// `length` and `char_length` are the same function in Postgres and both count characters.
// `octet_length` is deliberately absent: it counts bytes, which depends on the encoding and
// cannot be derived from a JavaScript string without choosing one.
// `cardinality(a)` is the element count. `array_length(a, 1)` is the length of the first
// dimension, which is the same number for a one-dimensional array; any other dimension is not an
// element count and is refused.
const CARDINALITY_OF =
  /^\s*(?:cardinality\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)|array_length\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*1\s*\))\s*(>=|<=|<>|!=|>|<|=)\s*(\d+)\s*$/i;
const LENGTH_OF =
  /^\s*(?:length|char_length)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*(>=|<=|<>|!=|>|<|=)\s*(\d+)\s*$/i;

/** What a SQL identifier is made of, and so what does and does not end a keyword. */
const WORD = /[A-Za-z0-9_]/;

/**
 * Split on a keyword at the top level, outside parentheses and outside quotes.
 *
 * A naive `split(/AND/i)` would cut through `'A AND B'` as a string literal and through the
 * `AND` inside a `BETWEEN`, which is why this walks the expression instead. Returns a single
 * element when there is nothing to split.
 *
 * The keyword is recognised as a whole token rather than as a substring surrounded by spaces.
 * That is what keeps the `OR` inside `XOR` and the `AND` inside `BRAND` from being read as
 * operators, and it is also what lets `(a=1)OR(a=2)` split, which Postgres accepts and which the
 * spaces-only form quietly failed to see.
 */
function splitTopLevel(expr: string, keyword: 'AND' | 'OR'): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]!;
    if (inString) {
      // SQL escapes a quote by doubling it, so `''` inside a string is not the end of it.
      if (c === "'") {
        if (expr[i + 1] === "'") i++;
        else inString = false;
      }
      continue;
    }
    if (c === "'") {
      inString = true;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && WORD.test(c)) {
      // Only at the start of a token, and only when nothing word-like follows it.
      if (i > 0 && WORD.test(expr[i - 1]!)) continue;
      if (expr.slice(i, i + keyword.length).toUpperCase() !== keyword) continue;
      const after = expr[i + keyword.length];
      if (after !== undefined && WORD.test(after)) continue;
      parts.push(expr.slice(start, i));
      i += keyword.length - 1;
      start = i + 1;
    }
  }
  parts.push(expr.slice(start));
  return parts;
}

/**
 * Whether the expression negates something logically, as opposed to spelling an `IS NOT` operator.
 *
 * `NOT` is refused wherever it appears, because negating a predicate this parser reads produces
 * one it does not, and pushing the negation inwards is a job for a real parser. But `IS NOT NULL`
 * and `IS NOT DISTINCT FROM` are not negations: `IS NOT` is one operator, spelled with a space in
 * it. A guard that could not tell them apart refused every unary null test in the language, which
 * is exactly the constraint this file was asked to start reading.
 *
 * String literals are skipped, so a `NOT` inside `'A NOT B'` is text rather than an operator.
 */
function hasLogicalNot(expr: string): boolean {
  let inString = false;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]!;
    if (inString) {
      if (c === "'") {
        if (expr[i + 1] === "'") i++;
        else inString = false;
      }
      continue;
    }
    if (c === "'") {
      inString = true;
      continue;
    }
    if (c !== 'N' && c !== 'n') continue;
    if (i > 0 && WORD.test(expr[i - 1]!)) continue;
    if (!/^NOT($|[^A-Za-z0-9_])/i.test(expr.slice(i))) continue;
    // `IS NOT` is one operator. Anything else reaching here negates a predicate.
    if (/(^|[^A-Za-z0-9_])IS\s+$/i.test(expr.slice(0, i))) continue;
    return true;
  }
  return false;
}

/**
 * The arithmetic or concatenation operator combining two operands, if there is one.
 *
 * Only for the refusal message: nothing here evaluates one. Requiring whitespace on both sides is
 * what keeps `balance >= -100` from reading as a subtraction, and it matches how the operator is
 * written in a `sql` template, where the column interpolations already put spaces around it.
 */
const COMBINING = /(?:^|\s)(\|\||[+\-*/%])(?:\s)/;
function combiningOperator(expr: string): string | undefined {
  let inString = false;
  let bare = '';
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]!;
    if (inString) {
      if (c === "'") {
        if (expr[i + 1] === "'") i++;
        else inString = false;
      }
      // A space stands in for the literal, so an operator cannot be read out of its contents and
      // the operands on either side of it stay separated.
      continue;
    }
    if (c === "'") {
      inString = true;
      bare += ' ';
      continue;
    }
    bare += c;
  }
  return COMBINING.exec(bare)?.[1];
}

/** Strip one layer of parentheses wrapping the whole expression, as many times as it is wrapped. */
function unwrap(expr: string): string {
  let e = expr.trim();
  while (e.startsWith('(') && e.endsWith(')')) {
    let depth = 0;
    let inString = false;
    let wrapsWhole = true;
    for (let i = 0; i < e.length; i++) {
      const c = e[i];
      if (inString) {
        if (c === "'") {
          if (e[i + 1] === "'") i++;
          else inString = false;
        }
        continue;
      }
      if (c === "'") inString = true;
      else if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        // Closed before the end, so the outer parens are not wrapping everything: `(a) AND (b)`.
        if (depth === 0 && i < e.length - 1) {
          wrapsWhole = false;
          break;
        }
      }
    }
    if (!wrapsWhole) break;
    e = e.slice(1, -1).trim();
  }
  return e;
}

/** Top-level commas, for an `IN` list. Same walk as the `AND` split. */
function splitTopLevelCommas(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (inString) {
      if (c === "'") {
        if (list[i + 1] === "'") i++;
        else inString = false;
      }
      continue;
    }
    if (c === "'") inString = true;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start));
  return parts;
}
const BETWEEN = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+BETWEEN\s+(.+?)\s+AND\s+(.+?)\s*$/i;

// The unary `IS` predicates. Unlike `BETWEEN`, none of these holds an `AND` or an `OR` inside it,
// which is why they are matched *after* the splits rather than before: matched first, the trailing
// operand of `a IS DISTINCT FROM 5 AND b > 0` would read `5 AND b > 0` and the second predicate
// would vanish. That is the same trap `BETWEEN` documents, and it points the other way.
const IS_NULL = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+IS\s+(NOT\s+)?NULL\s*$/i;
const IS_DISTINCT = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+IS\s+(NOT\s+)?DISTINCT\s+FROM\s+(.+?)\s*$/i;
const IS_BOOLEAN = /^\s*[A-Za-z_][A-Za-z0-9_]*\s+IS\s+(?:NOT\s+)?(TRUE|FALSE|UNKNOWN)\s*$/i;

function literal(raw: string): { value: string; kind: 'number' | 'string' } | undefined {
  const t = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return { value: t, kind: 'number' };
  // A quoted string, with SQL's doubled-quote escape undone.
  const m = t.match(/^'((?:[^']|'')*)'$/);
  if (m) return { value: m[1].replace(/''/g, "'"), kind: 'string' };
  return undefined;
}

/** Every column a parsed check talks about, in no particular order. */
function columnsOf(parsed: Extract<ParsedCheck, { ok: true }>): Set<string> {
  const out = new Set<string>();
  for (const c of parsed.checks) out.add(c.column);
  for (const s of parsed.sets ?? []) out.add(s.column);
  for (const l of parsed.lengths ?? []) out.add(l.column);
  for (const a of parsed.cardinalities ?? []) out.add(a.column);
  for (const n of parsed.nulls ?? []) out.add(n.column);
  for (const r of parsed.rows ?? []) {
    out.add(r.left);
    out.add(r.right);
  }
  return out;
}

/**
 * A disjunction, read only where the whole of it says one thing.
 *
 * This is the half of the file that has to be argued rather than described. A conjunction splits
 * because each part is independently *necessary*: enforcing one enforces something the database
 * enforces too. A disjunction is the opposite. `CHECK (a OR b)` is satisfied by a row that breaks
 * `a`, so a schema enforcing `a` refuses rows the database takes, which is the one failure this
 * whole file exists to avoid. There is no partial reading of an `OR`: it is understood whole or
 * refused whole, and the refusal is what `drzl doctor` and the constraint ledger report.
 *
 * Two shapes are understood whole.
 *
 * **A set.** Every branch pins the same column to a literal, by `=` or by `IN`. `s = 'a' OR
 * s = 'b'` and `s IN ('a','b')` are the same statement in SQL, NULL included: both yield NULL
 * when `s` is, and a CHECK passes on NULL. So the union of the branches is returned as the one
 * `ColumnSet` it already was, and every generator states it the way it already states an `IN`.
 *
 * **A null guard.** `col IS NULL OR P` states nothing beyond `P` when `P` is NULL exactly when
 * `col` is, because a CHECK already passes on NULL. Every operator this parser reads is strict:
 * it yields NULL whenever any column it names is NULL. So the guard is dropped, and the soundness
 * condition is that `P` *names* the guarded column and contains no null test of its own, which is
 * the one predicate here that answers FALSE rather than NULL.
 */
function parseDisjunction(branches: string[], name?: string): ParsedCheck {
  const guarded: string[] = [];
  const rest: string[] = [];
  for (const b of branches) {
    // `m[2]` is the optional `NOT`. Only the bare `IS NULL` is a guard; `IS NOT NULL` is a claim.
    const m = unwrap(b).match(IS_NULL);
    if (m && !m[2]) guarded.push(m[1]!);
    else rest.push(b);
  }

  const reduced = ((): ParsedCheck => {
    if (!rest.length)
      return {
        ok: false,
        reason: 'every branch of the OR is a null test, which is a rule about the row',
      };
    if (rest.length === 1) return parseCheck(rest[0]!, name);
    return foldDisjunctionToSet(rest, name);
  })();

  if (!reduced.ok || !guarded.length) return reduced;

  if (reduced.nulls?.length)
    return {
      ok: false,
      reason: 'a null test guarded by IS NULL, which is true of every row rather than a narrowing',
    };
  const named = columnsOf(reduced);
  const stray = guarded.filter((g) => !named.has(g));
  if (stray.length)
    return {
      ok: false,
      reason: `${stray.map((s) => `"${s}"`).join(' and ')} IS NULL guards a predicate that does not name it`,
    };
  return reduced;
}

/**
 * The branches of a disjunction as the one set of literals they pin a column to, or why not.
 *
 * Every reason names the shape it found, because the alternative is a `drzl doctor` line that
 * says "OR" and leaves the reader to work out which of four different things went wrong.
 */
function foldDisjunctionToSet(branches: string[], name?: string): ParsedCheck {
  let column: string | undefined;
  let kind: 'number' | 'string' | undefined;
  const values: string[] = [];

  for (const branch of branches) {
    const parsed = parseCheck(branch, name);
    if (!parsed.ok)
      return { ok: false, reason: `part of an OR was not understood: ${parsed.reason}` };
    if (parsed.rows?.length)
      return {
        ok: false,
        reason: 'a branch of the OR compares two columns, which is a rule about the row',
      };
    if (parsed.lengths?.length || parsed.cardinalities?.length)
      return {
        ok: false,
        reason: 'a branch of the OR is a count rather than a value, so the OR states no set',
      };
    if (parsed.nulls?.length)
      return { ok: false, reason: 'a branch of the OR is a null test rather than a value' };

    const set = parsed.sets?.[0];
    const range = parsed.checks.find((c) => c.operator !== '=');
    if (range)
      return {
        ok: false,
        reason: `a branch of the OR is a range (${range.column} ${range.operator} ${range.value}) rather than a set of values`,
      };
    if (parsed.checks.length + (parsed.sets?.length ?? 0) !== 1)
      return { ok: false, reason: 'a branch of the OR states more than one thing' };

    const here = set
      ? { column: set.column, kind: set.kind, values: set.values }
      : {
          column: parsed.checks[0]!.column,
          kind: parsed.checks[0]!.kind,
          values: [parsed.checks[0]!.value],
        };

    if (column === undefined) {
      column = here.column;
      kind = here.kind;
    }
    if (here.column !== column)
      return {
        ok: false,
        reason: `the OR branches constrain different columns (${column}, ${here.column}), so it states a rule about the row rather than about a field`,
      };
    if (here.kind !== kind)
      return { ok: false, reason: 'the OR branches mix a string and a number' };
    for (const v of here.values) if (!values.includes(v)) values.push(v);
  }

  return {
    ok: true,
    checks: [],
    sets: [{ column: column!, values, kind: kind!, name }],
  };
}

/**
 * Parse one check expression.
 *
 * Deliberately narrow. `BETWEEN` is included because it is common and means exactly two
 * inclusive bounds; `AND` of arbitrary predicates is not, because getting its scope wrong would
 * silently change what is enforced.
 *
 * **The order below is load bearing, in both directions.** `BETWEEN` is matched before the `AND`
 * split because it *holds* an `AND`; splitting first turned every `BETWEEN` into an unparseable
 * pair and dropped a constraint that had been enforced. The unary `IS` predicates are matched
 * *after* the splits for the mirror-image reason: none of them holds an `AND` or an `OR`, and
 * their trailing operand is greedy, so matching first would let `a IS DISTINCT FROM 5 AND b > 0`
 * swallow the second predicate. `OR` is split before `AND` because SQL binds `AND` tighter, and
 * no SQL operator spells an `OR` inside itself the way `BETWEEN` spells an `AND`.
 */
export function parseCheck(expression: string | undefined, name?: string): ParsedCheck {
  const expr = unwrap((expression ?? '').trim());
  if (!expr) return { ok: false, reason: 'empty expression' };
  if (expr.includes('?')) return { ok: false, reason: 'expression contains an unresolved value' };

  // A disjunction, which is read only where the whole of it collapses to one statement.
  const branches = splitTopLevel(expr, 'OR');
  if (branches.length > 1) return parseDisjunction(branches, name);

  // `NOT` still disqualifies the expression: negating a predicate this parser reads produces one
  // it does not. `IS NOT NULL` is not a negation, and `hasLogicalNot` is what tells them apart.
  if (hasLogicalNot(expr)) return { ok: false, reason: 'contains NOT' };

  // Before the AND split, because the `AND` in `x BETWEEN 1 AND 10` belongs to the operator
  // rather than joining two predicates. Splitting first turned every BETWEEN into an
  // unparseable pair and silently dropped a constraint that used to be enforced.
  const between = expr.match(BETWEEN);
  if (between) {
    const lo = literal(between[2]);
    const hi = literal(between[3]);
    if (!lo || !hi) return { ok: false, reason: 'BETWEEN bounds are not literals' };
    if (lo.kind !== hi.kind) return { ok: false, reason: 'BETWEEN bounds are of mixed types' };
    return {
      ok: true,
      checks: [
        { column: between[1], operator: '>=', value: lo.value, kind: lo.kind, name },
        { column: between[1], operator: '<=', value: hi.value, kind: hi.kind, name },
      ],
    };
  }

  // A conjunction: every part must hold, so each becomes its own check. Any part this parser
  // cannot read disqualifies the whole expression rather than being dropped, since enforcing
  // half of a constraint is enforcing a different constraint.
  const parts = splitTopLevel(expr, 'AND');
  if (parts.length > 1) {
    const checks: ColumnCheck[] = [];
    const sets: ColumnSet[] = [];
    const rows: RowCheck[] = [];
    const lengths: LengthCheck[] = [];
    const cardinalities: CardinalityCheck[] = [];
    const nulls: NullCheck[] = [];
    for (const part of parts) {
      const parsed = parseCheck(part, name);
      if (!parsed.ok)
        return { ok: false, reason: `part of an AND was not understood: ${parsed.reason}` };
      checks.push(...parsed.checks);
      if (parsed.sets) sets.push(...parsed.sets);
      if (parsed.rows) rows.push(...parsed.rows);
      if (parsed.lengths) lengths.push(...parsed.lengths);
      if (parsed.cardinalities) cardinalities.push(...parsed.cardinalities);
      if (parsed.nulls) nulls.push(...parsed.nulls);
    }
    return {
      ok: true,
      checks,
      ...(sets.length ? { sets } : {}),
      ...(rows.length ? { rows } : {}),
      ...(lengths.length ? { lengths } : {}),
      ...(cardinalities.length ? { cardinalities } : {}),
      ...(nulls.length ? { nulls } : {}),
    };
  }

  // The unary `IS` predicates, after both splits: see the ordering note on this function.
  //
  // `IS NOT NULL` on a nullable column is the one narrowing here that no predicate can carry. A
  // check sits *inside* the nullable wrapper precisely because NULL never reaches it, so the only
  // way to state this is for the field to stop being nullable, which is what
  // `insertColumns`/`selectColumns`/`updateColumns` do with it. `IS NULL` is read so it can be
  // reported precisely; nothing narrows a column to NULL alone.
  const isNull = expr.match(IS_NULL);
  if (isNull) {
    return {
      ok: true,
      checks: [],
      nulls: [{ column: isNull[1]!, notNull: !!isNull[2], ...(name ? { name } : {}) }],
    };
  }

  // `col IS DISTINCT FROM <literal>` is the NULL-safe `<>`, and as a *CHECK* it constrains exactly
  // the rows `<>` does: `NULL IS DISTINCT FROM 5` is TRUE and `NULL <> 5` is NULL, and a CHECK
  // passes on both. Verified against Postgres. `IS NOT DISTINCT FROM` is not symmetric with that:
  // it answers FALSE on NULL, so it is an equality that also refuses NULL, and it says so.
  const isDistinct = expr.match(IS_DISTINCT);
  if (isDistinct) {
    const value = literal(isDistinct[3]!);
    if (!value) return { ok: false, reason: 'the right side of IS DISTINCT FROM is not a literal' };
    const column = isDistinct[1]!;
    const negated = !!isDistinct[2];
    return {
      ok: true,
      checks: [
        { column, operator: negated ? '=' : '<>', value: value.value, kind: value.kind, name },
      ],
      ...(negated ? { nulls: [{ column, notNull: true, ...(name ? { name } : {}) }] } : {}),
    };
  }

  if (IS_BOOLEAN.test(expr))
    return { ok: false, reason: 'a boolean IS test, whose literal this version does not read' };

  // `length(col) <op> n`: a character-count bound. The only function call this parser reads, and
  // it is read rather than refused because the mapping is exact, which is more than can be said
  // for the others: see the skip list in the docs.
  const lengthOf = expr.match(LENGTH_OF);
  if (lengthOf) {
    const op = lengthOf[2] === '!=' ? '<>' : (lengthOf[2] as ColumnCheck['operator']);
    return {
      ok: true,
      checks: [],
      lengths: [{ column: lengthOf[1], operator: op, value: lengthOf[3], name }],
    };
  }

  const cardinalityOf = expr.match(CARDINALITY_OF);
  if (cardinalityOf) {
    const op = cardinalityOf[3] === '!=' ? '<>' : (cardinalityOf[3] as ColumnCheck['operator']);
    return {
      ok: true,
      checks: [],
      cardinalities: [
        {
          column: cardinalityOf[1] ?? cardinalityOf[2],
          operator: op,
          value: cardinalityOf[4],
          ...(name ? { name } : {}),
        },
      ],
    };
  }

  // `col IN (a, b, c)`: a set of literals, which is the constraint most often written as a CHECK
  // and which no official validator module enforces.
  const inList = expr.match(IN_LIST);
  if (inList) {
    const raw = splitTopLevelCommas(inList[2]);
    const parsedValues = raw.map((r) => literal(r));
    if (parsedValues.some((v) => !v)) return { ok: false, reason: 'IN list holds a non-literal' };
    const kinds = new Set(parsedValues.map((v) => v!.kind));
    if (kinds.size > 1) return { ok: false, reason: 'IN list mixes types' };
    if (!parsedValues.length) return { ok: false, reason: 'IN list is empty' };
    return {
      ok: true,
      checks: [],
      sets: [
        {
          column: inList[1],
          values: parsedValues.map((v) => v!.value),
          kind: parsedValues[0]!.kind,
          name,
        },
      ],
    };
  }

  /**
   * Arithmetic between operands, refused by name rather than as "not a comparison".
   *
   * This is a decision and not a gap. `CHECK (x + y <= 0.3)` on two `numeric` columns accepts
   * (0.1, 0.2), because Postgres computes `numeric` exactly; the same expression in JavaScript is
   * 0.30000000000000004 and rejects it. Measured, both halves. On two `double precision` columns
   * Postgres computes the same IEEE-754 sum JavaScript does and rejects it too, so the *correct*
   * translation of one expression depends on a column type the expression does not carry, and a
   * `bigint` pair adds a third answer: Postgres raises on overflow where JS `BigInt` does not.
   * One reading would be wrong for two of the three, in the direction that refuses rows the
   * database accepts, so none is emitted.
   */
  const combining = combiningOperator(expr);
  const arithmetic = () =>
    ({
      ok: false as const,
      reason: `columns combined with "${combining}", which this version does not evaluate`,
    }) satisfies ParsedCheck;

  const cmp = expr.match(COMPARISON);
  if (!cmp) {
    if (combining) return arithmetic();
    return { ok: false, reason: 'not a single comparison this version understands' };
  }

  const value = literal(cmp[3]);
  if (!value) {
    // The right side is not a literal. If it is a bare column name, the expression compares two
    // columns of the same row: `start_date < end_date`. That cannot be attached to either field,
    // since neither alone can say whether it holds, but it can be attached to the object.
    const right = cmp[3].trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(right)) {
      const op = cmp[2] === '!=' ? '<>' : (cmp[2] as ColumnCheck['operator']);
      return { ok: true, checks: [], rows: [{ left: cmp[1], right, operator: op, name }] };
    }
    if (combining) return arithmetic();
    // Anything else is an expression this parser does not model.
    return { ok: false, reason: 'right side is not a literal' };
  }

  const op = cmp[2] === '!=' ? '<>' : (cmp[2] as ColumnCheck['operator']);
  return {
    ok: true,
    checks: [{ column: cmp[1], operator: op, value: value.value, kind: value.kind, name }],
  };
}

/**
 * A human-readable rendering of a set constraint, for an error message.
 *
 * Values are re-quoted the way SQL wrote them, so the message reads like the constraint in the
 * schema rather than like its JavaScript translation.
 */
export function describeSet(set: ColumnSet): string {
  const shown = set.values.map((v) => (set.kind === 'string' ? `'${v}'` : v)).join(', ');
  return `${set.name ? `${set.name}: ` : ''}${set.column} IN (${shown})`;
}
