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

/** A check that was understood, or the reason it was not. */
export type ParsedCheck =
  { ok: true; checks: ColumnCheck[]; sets?: ColumnSet[] } | { ok: false; reason: string };

const COMPARISON = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(>=|<=|<>|!=|>|<|=)\s*(.+?)\s*$/;
const IN_LIST = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+IN\s*\((.+)\)\s*$/i;

/**
 * Split on `AND`s that are at the top level, outside parentheses and outside quotes.
 *
 * A naive `split(/AND/i)` would cut through `'A AND B'` as a string literal and through the
 * `AND` inside a `BETWEEN`, which is why this walks the expression instead. Returns a single
 * element when there is nothing to split.
 */
function splitTopLevelAnd(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
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
    else if (depth === 0 && /\s/.test(c)) {
      const m = /^\s+AND\s+/i.exec(expr.slice(i));
      if (m) {
        parts.push(expr.slice(start, i));
        i += m[0].length - 1;
        start = i + 1;
      }
    }
  }
  parts.push(expr.slice(start));
  return parts;
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

function literal(raw: string): { value: string; kind: 'number' | 'string' } | undefined {
  const t = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return { value: t, kind: 'number' };
  // A quoted string, with SQL's doubled-quote escape undone.
  const m = t.match(/^'((?:[^']|'')*)'$/);
  if (m) return { value: m[1].replace(/''/g, "'"), kind: 'string' };
  return undefined;
}

/**
 * Parse one check expression.
 *
 * Deliberately narrow. `BETWEEN` is included because it is common and means exactly two
 * inclusive bounds; `AND` of arbitrary predicates is not, because getting its scope wrong would
 * silently change what is enforced.
 */
export function parseCheck(expression: string | undefined, name?: string): ParsedCheck {
  const expr = unwrap((expression ?? '').trim());
  if (!expr) return { ok: false, reason: 'empty expression' };
  if (expr.includes('?')) return { ok: false, reason: 'expression contains an unresolved value' };

  // `OR` anywhere disqualifies the whole expression. Conjunction is safe to split because every
  // part has to hold independently; disjunction is not, and telling the two apart in a mixed
  // expression needs a real parser. Refusing is the behaviour that cannot silently enforce the
  // wrong thing.
  if (/(^|[\s)])OR($|[\s(])/i.test(expr)) return { ok: false, reason: 'contains OR' };
  if (/(^|[\s(])NOT($|[\s(])/i.test(expr)) return { ok: false, reason: 'contains NOT' };

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
  const parts = splitTopLevelAnd(expr);
  if (parts.length > 1) {
    const checks: ColumnCheck[] = [];
    const sets: ColumnSet[] = [];
    for (const part of parts) {
      const parsed = parseCheck(part, name);
      if (!parsed.ok)
        return { ok: false, reason: `part of an AND was not understood: ${parsed.reason}` };
      checks.push(...parsed.checks);
      if (parsed.sets) sets.push(...parsed.sets);
    }
    return sets.length ? { ok: true, checks, sets } : { ok: true, checks };
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

  const cmp = expr.match(COMPARISON);
  if (!cmp) return { ok: false, reason: 'not a single comparison this version understands' };

  const value = literal(cmp[3]);
  if (!value) {
    // The right side names something else, e.g. another column. That is a statement about the
    // row rather than about this field, so it cannot be attached to one.
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
