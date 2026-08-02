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

/** A check that was understood, or the reason it was not. */
export type ParsedCheck =
  | { ok: true; checks: ColumnCheck[] }
  | { ok: false; reason: string };

const COMPARISON = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(>=|<=|<>|!=|>|<|=)\s*(.+?)\s*$/;
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
  const expr = (expression ?? '').trim();
  if (!expr) return { ok: false, reason: 'empty expression' };
  if (expr.includes('?')) return { ok: false, reason: 'expression contains an unresolved value' };

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

  const cmp = expr.match(COMPARISON);
  if (!cmp) return { ok: false, reason: 'not a single comparison this version understands' };

  const value = literal(cmp[3]);
  if (!value) {
    // The right side names something else, e.g. another column. That is a statement about the
    // row rather than about this field, so it cannot be attached to one.
    return { ok: false, reason: 'right side is not a literal' };
  }

  const op = cmp[2] === '!=' ? '<>' : (cmp[2] as ColumnCheck['operator']);
  return { ok: true, checks: [{ column: cmp[1], operator: op, value: value.value, kind: value.kind, name }] };
}
