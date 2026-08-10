/**
 * Every constraint on a table, as data a consumer can read without holding a validator.
 *
 * `meta` already carries most of these facts, and this is deliberately not a second copy of it.
 * Three differences, each of which is why both exist.
 *
 *   **shape**       `meta` renders a CHECK as prose: `"age_adult: age >= 18"`. That is the right
 *                   form for its destination, which is `z.toJSONSchema` and then an OpenAPI
 *                   viewer, and the wrong form for a form builder, which wants the bound as a
 *                   number and would otherwise have to parse SQL back out of a sentence. Here the
 *                   operand is data and the sentence is beside it.
 *
 *   **content**     `meta` has no foreign keys at all, and its `unique` is a list of column groups
 *                   with the constraint names dropped. A form cannot render a picker without the
 *                   first, and, more sharply, nothing can be mapped back to a constraint that has
 *                   no name, which is what makes the second load bearing rather than cosmetic.
 *
 *   **addressing**  `meta` is reachable only by holding the emitted schema object and asking each
 *                   field, per mode. This is a plain record keyed by table, so the answer to "what
 *                   constrains this table" costs one property read and no validator import.
 *
 * What is *not* here is anything `meta` states about a column rather than a constraint: the SQL
 * type, whether the database defaults the value, the numeric range of the column's own type. Those
 * are facts about a field, `meta` carries them, and restating them here would be exactly the
 * duplication the paragraph above is arguing against.
 *
 * Both halves are built from `classifyTableChecks` below, which `meta` also uses, so the two can
 * disagree about what is enforced only by both being wrong at once.
 */
import type { Column, ForeignKey, Key, Table } from '@drzl/analyzer';
import {
  lengthCheckLabel,
  lengthMeasure,
  parseCheck,
  wireLiteralFit,
  type CardinalityCheck,
  type ColumnCheck,
  type ColumnSet,
  type NullCheck,
  type RowCheck,
} from './checks.js';

/** `name: expr`, matching how every emitted failure message labels the constraint it came from. */
function labelled(name: string | undefined, text: string): string {
  return name ? `${name}: ${text}` : text;
}

/** A literal as it reads inside the expression it came from, quoted exactly when it was quoted. */
function literalText(value: string, kind: 'number' | 'string'): string {
  return kind === 'string' ? `'${value}'` : value;
}

function columnCheckText(k: ColumnCheck): string {
  return labelled(k.name, `${k.column} ${k.operator} ${literalText(k.value, k.kind)}`);
}
function setText(k: ColumnSet): string {
  return labelled(
    k.name,
    `${k.column} IN (${k.values.map((v) => literalText(v, k.kind)).join(', ')})`
  );
}
/** Re-exported spelling, so nothing here can render a count differently from a generator. */
const lengthText = lengthCheckLabel;
function cardinalityText(k: CardinalityCheck): string {
  return labelled(k.name, `cardinality(${k.column}) ${k.operator} ${k.value}`);
}
function rowText(k: RowCheck): string {
  return labelled(k.name, `${k.left} ${k.operator} ${k.right}`);
}
function nullText(k: NullCheck): string {
  return labelled(k.name, `${k.column} IS ${k.notNull ? 'NOT NULL' : 'NULL'}`);
}

/**
 * What a shaped column is, for a sentence about a count it cannot answer.
 *
 * The same vocabulary `drzl doctor` uses, so a reader meeting a constraint in both places meets one
 * noun for it. Every `ColumnShape` kind has an arm, so a shape added later reads as "a structured"
 * rather than as a wrong noun.
 */
function shapeArticle(c: Column): string {
  switch (c.shape?.kind) {
    case 'json':
      return 'a JSON';
    case 'buffer':
      return 'a binary';
    case 'numberVector':
      return 'a vector';
    case 'bitstring':
      return 'a bit-string';
    case 'byteString':
      return 'a byte-string';
    case 'custom':
      return 'a customType';
    default:
      return 'a structured';
  }
}

/**
 * Whether a field-level constraint reaches this column at all.
 *
 * The same three guards every validation generator applies. A comparison against a scalar says
 * nothing usable about an array or a tuple, and a character count says nothing about either; a
 * cardinality is the mirror image and only means something on an array. A constraint that fails
 * its guard is enforced nowhere, so it is reported as unenforced rather than silently attributed
 * to a field that does not check it.
 */
function takesScalarChecks(c: Column): boolean {
  return !c.arrayDimensions && !c.shape;
}

/**
 * Whether a numeric comparison is folded into the column's own range rather than stated as a
 * predicate carrying a message.
 *
 * The condition the zod and valibot generators each apply, held once so this cannot drift from
 * what they emit. It decides whether the constraint has a message to be matched on at all: a
 * folded bound becomes `.gte(18)` / `v.minValue(18)`, and the failure is then worded by the
 * library, with the constraint name nowhere in it.
 */
function foldsIntoBounds(c: Column, k: ColumnCheck): boolean {
  if (c.arrayDimensions || c.shape) return false;
  if (c.tsType !== 'number' && c.tsType !== 'bigint') return false;
  return k.kind === 'number' && k.operator !== '=' && k.operator !== '<>';
}

/**
 * Whether a string column's declared width reaches the emitted schema as a predicate.
 *
 * A column whose value space is stated some other way never gets one: a structured column, a
 * column narrowed to a set of literals by a CHECK, a declared enum, and a `uuid` or `numeric`
 * column, whose format supersedes any width. Mirrors the branch order in every generator's column
 * expression, and is the difference between a message this ledger can be matched on and one the
 * emitted module never writes.
 */
function statesCap(c: Column, hasSet: boolean): boolean {
  if (c.shape || hasSet) return false;
  if (c.enumValues && c.enumValues.length) return false;
  if (c.tsType !== 'string') return false;
  // `uuid` becomes `z.uuid()` and `numeric` a pattern; both replace the width rather than adding
  // to it. Those are the only two the analyzer produces.
  return !c.format;
}

/** Where one part of a parsed CHECK lands. */
export type CheckPartPlace = 'column' | 'row' | 'none';

/**
 * One clause of one CHECK, classified by what the generated schemas do with it.
 *
 * A single `CHECK` declaration can split into several of these: `BETWEEN` is two bounds, and a
 * conjunction is one part per operand. They are kept apart here because enforcement is decided
 * per clause, and rejoined into one constraint by `tableConstraints`, because a database has one
 * constraint there and quotes one name back.
 */
export interface CheckPart {
  /** The clause as text. Also the message the emitted schema attaches, when it attaches one. */
  text: string;
  /** The columns the clause is about, in the order the expression names them. */
  columns: string[];
  place: CheckPartPlace;
  /** Why nothing enforces it, when nothing does. */
  reason?: string;
  /** Present when the clause was folded into the column's range instead of a predicate. */
  bound?: { column: string; operator: ColumnCheck['operator']; value: string };
  /** Present when the clause was folded into a set of literals instead of a predicate. */
  set?: { column: string; values: string[]; kind: 'number' | 'string' };
  /**
   * Present when the clause is enforced by the field's shape rather than by a predicate.
   *
   * The third fold, after a bound and a set, and the one that leaves *nothing* to match on:
   * `CHECK (col IS NOT NULL)` is enforced by the field not being nullable, and the failure it
   * produces is the library's own "expected string, received null". Marked so `tableConstraints`
   * does not offer the clause text as a message, which would have the error map keying on a
   * string no emitted module writes.
   */
  shape?: 'notNull';
}

/** One declared CHECK, with each of its clauses placed. */
export interface ClassifiedCheck {
  name?: string;
  /** The expression as declared, trimmed. */
  expression: string;
  parts: CheckPart[];
}

/**
 * Every CHECK on a table, split into clauses and placed.
 *
 * The single reading of `parseCheck` plus the shape guards, shared by `meta` and by the constraint
 * ledger so that "the database also checks this and we do not" is one answer rather than two.
 */
export function classifyTableChecks(table: Table): ClassifiedCheck[] {
  const byName = new Map(table.columns.map((c) => [c.name, c]));
  const out: ClassifiedCheck[] = [];

  for (const k of table.checks ?? []) {
    const expression = (k.expression ?? '').trim();
    // The table's engine decides what `length()` counts, so the ledger reads a check the same way
    // the emitted schema does. Without it the two surfaces disagree about the same constraint.
    const parsed = parseCheck(k.expression, k.name, table.dialect);
    if (!parsed.ok) {
      out.push({
        ...(k.name ? { name: k.name } : {}),
        expression,
        parts: [
          {
            text: labelled(k.name, expression),
            columns: [],
            place: 'none',
            reason: parsed.reason,
          },
        ],
      });
      continue;
    }

    const parts: CheckPart[] = [];
    const place = (
      column: string,
      text: string,
      guard: (c: Column) => boolean,
      guardReason: (c: Column) => string,
      extra: Partial<CheckPart> = {}
    ) => {
      const c = byName.get(column);
      if (!c) {
        parts.push({
          text,
          columns: [column],
          place: 'none',
          reason: `"${column}" is not a column of that table`,
        });
        return;
      }
      if (!guard(c)) {
        parts.push({ text, columns: [column], place: 'none', reason: guardReason(c) });
        return;
      }
      parts.push({ text, columns: [column], place: 'column', ...extra });
    };

    const notScalar = (c: Column) =>
      c.arrayDimensions
        ? `"${c.name}" is an array, and the clause describes a scalar`
        : `"${c.name}" is a structured column, and the clause describes a scalar`;

    // The wire policy, applied here exactly as the generators apply it through
    // `applyWirePolicy`: a clause it leaves unenforced is reported with its reason instead of
    // being claimed, and a respelled literal is rendered in its respelled form, because the
    // error map matches an issue's message against these texts exactly and the emitted modules
    // spell their messages from the respelled clause.
    const literalFit = (
      column: string,
      kind: 'number' | 'string',
      values: string[],
      comparison: 'equality' | 'range'
    ) => {
      const col = byName.get(column);
      return col ? wireLiteralFit(col, { kind, values, comparison }) : ({ fit: 'keep' } as const);
    };

    for (const c of parsed.checks) {
      const fit = literalFit(
        c.column,
        c.kind,
        [c.value],
        c.operator === '=' || c.operator === '<>' ? 'equality' : 'range'
      );
      if (fit.fit === 'unenforced') {
        parts.push({
          text: columnCheckText(c),
          columns: [c.column],
          place: 'none',
          reason: fit.reason,
        });
        continue;
      }
      const shown =
        fit.fit === 'respell' ? { ...c, kind: 'number' as const, value: fit.values[0]! } : c;
      const col = byName.get(c.column);
      place(c.column, columnCheckText(shown), takesScalarChecks, notScalar, {
        ...(col && foldsIntoBounds(col, shown)
          ? { bound: { column: c.column, operator: shown.operator, value: shown.value } }
          : {}),
      });
    }
    for (const s of parsed.sets ?? []) {
      const fit = literalFit(s.column, s.kind, s.values, 'equality');
      if (fit.fit === 'unenforced') {
        parts.push({ text: setText(s), columns: [s.column], place: 'none', reason: fit.reason });
        continue;
      }
      const shown =
        fit.fit === 'respell' ? { ...s, kind: 'number' as const, values: fit.values } : s;
      place(s.column, setText(shown), takesScalarChecks, notScalar, {
        set: { column: s.column, values: shown.values, kind: shown.kind },
      });
    }
    for (const l of parsed.lengths ?? []) {
      // Not the scalar guard the comparisons use. A count is answerable on a `bytea`, which is a
      // shaped column, and unanswerable on a `varbinary(n)`, which is not; `lengthMeasure` is the
      // one place that distinction is made and every generator asks it the same question.
      place(
        l.column,
        lengthText(l),
        (c) => lengthMeasure(c, l) !== undefined,
        (c) =>
          c.arrayDimensions
            ? `"${c.name}" is an array, so it has no ${l.unit === 'bytes' ? 'bytes' : 'characters'} to count`
            : c.shape
              ? `"${c.name}" is ${shapeArticle(c)} column, whose ${l.unit === 'bytes' ? 'byte' : 'character'} count in JavaScript is not the one the database took`
              : `"${c.name}" is not a string, so it has no ${l.unit === 'bytes' ? 'bytes' : 'characters'} to count`
      );
    }
    for (const a of parsed.cardinalities ?? []) {
      place(
        a.column,
        cardinalityText(a),
        (c) => !!c.arrayDimensions,
        (c) => `"${c.name}" is not an array, so it has no elements to count`
      );
    }
    for (const n of parsed.nulls ?? []) {
      const text = nullText(n);
      if (!byName.has(n.column)) {
        parts.push({
          text,
          columns: [n.column],
          place: 'none',
          reason: `"${n.column}" is not a column of that table`,
        });
        continue;
      }
      // `IS NOT NULL` reaches every column shape: an array, a json payload and a scalar are all
      // either there or not, so there is no shape guard to apply. It is enforced whichever way the
      // column arrived at not being nullable, by its own declaration or by this constraint, which
      // is why nothing here reads `c.nullable`: `selectColumns` has already applied it and the two
      // answers must not be able to differ.
      //
      // `IS NULL` is the other direction and nothing states it. Narrowing a field to *only* null
      // would mean replacing the column's type rather than wrapping it, and no generator has a
      // hook for that; reported rather than guessed at.
      parts.push(
        n.notNull
          ? { text, columns: [n.column], place: 'column', shape: 'notNull' }
          : {
              text,
              columns: [n.column],
              place: 'none',
              reason: 'the column may hold only NULL, which these schemas do not narrow it to',
            }
      );
    }
    for (const r of parsed.rows ?? []) {
      const text = rowText(r);
      const missing = [r.left, r.right].filter((n) => !byName.has(n));
      parts.push(
        missing.length
          ? {
              text,
              columns: [r.left, r.right],
              place: 'none',
              reason: `${missing.map((n) => `"${n}"`).join(' and ')} ${
                missing.length > 1 ? 'are not columns' : 'is not a column'
              } of that table`,
            }
          : { text, columns: [r.left, r.right], place: 'row' }
      );
    }

    out.push({ ...(k.name ? { name: k.name } : {}), expression, parts });
  }
  return out;
}

/** What a constraint is. */
export type ConstraintKind =
  'primaryKey' | 'unique' | 'foreignKey' | 'check' | 'maxLength' | 'maxBytes';

/** One clause of a constraint that nothing in the generated schemas checks. */
export interface UnenforcedPart {
  part: string;
  reason: string;
}

/** One constraint on one table. */
export interface ConstraintFacts {
  /**
   * Stable identifier, unique within the table.
   *
   * The SQL constraint name where the declaration has one, and a derived name where it does not.
   * This is what an error map keys on and what a caller stores against its own copy for a
   * message, so it has to exist even for the constraints SQL leaves anonymous.
   */
  id: string;
  /** The SQL constraint name, absent where the declaration did not give one. */
  name?: string;
  kind: ConstraintKind;
  /** The columns the constraint is about, in declaration order. */
  columns: string[];
  /** The rule as a sentence, for a form with nothing better to show. */
  rule: string;
  /** Whether a generated schema can reject a row for this constraint. */
  enforced: boolean;
  /** The clauses nothing enforces, and why. Absent when there are none. */
  unenforced?: UnenforcedPart[];
  /**
   * The exact messages a generated schema attaches for this constraint.
   *
   * Absent where the schema states the constraint in the validator's own vocabulary instead, which
   * is where the constraint name is lost and the error map has to key on something else.
   */
  messages?: string[];
  /** Bounds folded into a column's range. What a bound-carrying issue is matched against. */
  bounds?: { column: string; operator: string; value: string }[];
  /** A set of literals folded into an enum. */
  values?: { column: string; values: string[]; kind: 'number' | 'string' };
  /** Where a foreign key points. */
  references?: {
    table: string;
    schema?: string;
    columns: string[];
    onDelete?: string;
    onUpdate?: string;
  };
}

/** Every constraint on one table. */
export interface TableConstraints {
  /** The SQL table name, which is not the Drizzle export name. */
  table: string;
  /** The SQL schema, present only when the table names one. */
  schema?: string;
  constraints: ConstraintFacts[];
}

/** `a, b` for a rule sentence. */
const list = (cols: string[]) => cols.join(', ');

function foreignKeyRule(fk: ForeignKey): string {
  const target = fk.foreignSchema ? `${fk.foreignSchema}.${fk.foreignTable}` : fk.foreignTable;
  return (
    `FOREIGN KEY (${list(fk.columns)}) REFERENCES ${target} (${list(fk.foreignColumns)})` +
    (fk.onDelete ? ` ON DELETE ${fk.onDelete}` : '') +
    (fk.onUpdate ? ` ON UPDATE ${fk.onUpdate}` : '')
  );
}

/**
 * Make every id distinct within one table.
 *
 * Two constraints can arrive with the same derived id, and one database can even carry two CHECKs
 * under the same name in two schemas. An id that repeats would make the error map answer with
 * whichever entry it met first, silently, so a repeat gets a numeric suffix rather than a
 * collision.
 */
function uniquifier() {
  const seen = new Map<string, number>();
  return (id: string) => {
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    return n === 0 ? id : `${id}_${n + 1}`;
  };
}

/** Every constraint on a table, as data. */
export function tableConstraints(table: Table): TableConstraints {
  const out: ConstraintFacts[] = [];
  const id = uniquifier();
  const named = (key: Key | ForeignKey, fallback: string) =>
    key.name ? { id: id(key.name), name: key.name } : { id: id(fallback) };

  if (table.primaryKey?.columns.length) {
    const pk = table.primaryKey;
    out.push({
      ...named(pk, `${table.name}_pkey`),
      kind: 'primaryKey',
      columns: [...pk.columns],
      rule: `PRIMARY KEY (${list(pk.columns)})`,
      // No per-row validator can check a key: whether a value is already taken is a fact about
      // the table. `duplicateFinder` checks the half that needs no database, and even that only
      // answers whether a batch collides with itself.
      enforced: false,
    });
  }

  for (const u of table.unique ?? []) {
    if (!u.columns.length) continue;
    out.push({
      ...named(u, `${table.name}_${u.columns.join('_')}_key`),
      kind: 'unique',
      columns: [...u.columns],
      rule: `UNIQUE (${list(u.columns)})`,
      enforced: false,
    });
  }

  for (const fk of table.foreignKeys ?? []) {
    if (!fk.columns.length) continue;
    out.push({
      ...named(fk, `${table.name}_${fk.columns.join('_')}_fkey`),
      kind: 'foreignKey',
      columns: [...fk.columns],
      rule: foreignKeyRule(fk),
      // The referenced row either exists or it does not, and only the database knows.
      enforced: false,
      references: {
        table: fk.foreignTable,
        ...(fk.foreignSchema ? { schema: fk.foreignSchema } : {}),
        columns: [...fk.foreignColumns],
        ...(fk.onDelete ? { onDelete: fk.onDelete } : {}),
        ...(fk.onUpdate ? { onUpdate: fk.onUpdate } : {}),
      },
    });
  }

  const classified = classifyTableChecks(table);
  classified.forEach((k, i) => {
    const columns: string[] = [];
    for (const p of k.parts) for (const c of p.columns) if (!columns.includes(c)) columns.push(c);
    const messages = k.parts
      .filter((p) => p.place !== 'none' && !p.bound && !p.set && !p.shape)
      .map((p) => p.text);
    const bounds = k.parts.filter((p) => p.bound).map((p) => p.bound!);
    const set = k.parts.find((p) => p.set)?.set;
    const unenforced = k.parts
      .filter((p) => p.place === 'none')
      .map((p) => ({ part: p.text, reason: p.reason ?? 'not translated' }));
    out.push({
      ...(k.name ? { id: id(k.name), name: k.name } : { id: id(`${table.name}_check_${i + 1}`) }),
      kind: 'check',
      columns,
      rule: `CHECK (${k.expression})`,
      enforced: k.parts.some((p) => p.place !== 'none'),
      ...(unenforced.length ? { unenforced } : {}),
      ...(messages.length ? { messages } : {}),
      ...(bounds.length ? { bounds } : {}),
      ...(set ? { values: set } : {}),
    });
  });

  // A column narrowed to a set of literals states its value space that way instead of by width,
  // which is what the cap guard asks about. Read off the classification rather than re-parsed.
  const setColumns = new Set(
    classified.flatMap((k) => k.parts.filter((p) => p.set).map((p) => p.set!.column))
  );

  for (const c of table.columns) {
    if (!statesCap(c, setColumns.has(c.name))) continue;
    if (c.maxLength !== undefined) {
      const message = `at most ${c.maxLength} characters`;
      out.push({
        id: id(`${table.name}_${c.name}_maxlength`),
        kind: 'maxLength',
        columns: [c.name],
        rule: message,
        enforced: true,
        messages: [message],
      });
    }
    if (c.maxBytes !== undefined) {
      const message = `at most ${c.maxBytes} bytes`;
      out.push({
        id: id(`${table.name}_${c.name}_maxbytes`),
        kind: 'maxBytes',
        columns: [c.name],
        rule: message,
        enforced: true,
        messages: [message],
      });
    }
  }

  return {
    table: table.name,
    ...(table.schema ? { schema: table.schema } : {}),
    constraints: out,
  };
}

export interface ConstraintsModuleOptions {
  /** Also emit `constraintForIssue`, which is the half that maps a failure back. */
  errorMap?: boolean;
}

/** What `constraints` is asking for, once the boolean shorthand is expanded. */
export type ConstraintsOption = boolean | { enabled?: boolean; errorMap?: boolean };

export function resolveConstraints(
  opt: ConstraintsOption | undefined
): ConstraintsModuleOptions | undefined {
  if (!opt) return undefined;
  if (opt === true) return { errorMap: true };
  if (opt.enabled === false) return undefined;
  return { errorMap: opt.errorMap !== false };
}

/** The file every generator writes the ledger to. Fixed, like the barrel's own name. */
export const CONSTRAINTS_MODULE = 'constraints.ts';

const TYPES = `/** What a constraint is. */
export type DrzlConstraintKind =
  | 'primaryKey'
  | 'unique'
  | 'foreignKey'
  | 'check'
  | 'maxLength'
  | 'maxBytes';

/** One constraint on one table. */
export interface DrzlConstraint {
  /** Stable within the table. The SQL constraint name where the declaration has one. */
  id: string;
  /** The SQL constraint name, absent where the declaration did not give one. */
  name?: string;
  kind: DrzlConstraintKind;
  /** The columns the constraint is about, in declaration order. */
  columns: string[];
  /** The rule as a sentence, for a form with nothing better to show. */
  rule: string;
  /** Whether a generated schema can reject a row for this constraint. */
  enforced: boolean;
  /** The clauses nothing in these schemas checks, and why. */
  unenforced?: { part: string; reason: string }[];
  /** The exact messages the generated schemas attach for this constraint. */
  messages?: string[];
  /** Bounds folded into a column's range, which is where the constraint name is lost. */
  bounds?: { column: string; operator: string; value: string }[];
  /** A set of literals folded into an enum, which is the other place it is lost. */
  values?: { column: string; values: string[]; kind: 'number' | 'string' };
  /** Where a foreign key points. */
  references?: {
    table: string;
    schema?: string;
    columns: string[];
    onDelete?: string;
    onUpdate?: string;
  };
}

/** Every constraint on one table. */
export interface DrzlTableConstraints {
  /** The SQL table name, which is not the Drizzle export name this is exported under. */
  table: string;
  /** The SQL schema, present only when the table names one. */
  schema?: string;
  constraints: DrzlConstraint[];
}`;

const MATCHER = `/** A validation issue traced back to the constraint that caused it. */
export interface DrzlConstraintMatch {
  constraint: DrzlConstraint;
  /**
   * The column to put the message on.
   *
   * Taken from the issue where the library named one, and from the constraint where it did not.
   * Valibot reports a row-level check with an empty path, so without the fallback a form would
   * have a message and nowhere to show it.
   */
  column?: string;
  /**
   * How the constraint was identified.
   *
   * \`message\` is an exact match on a string these schemas wrote, and is the only tier that is
   * certain. \`bound\` matched the numeric bound the library put on the issue against a bound this
   * constraint folded, which is what a folded CHECK leaves to match on once its name is gone.
   * \`column\` is the last resort: the column has exactly one constraint stated in the validator's
   * own vocabulary, so nothing else on the issue can be wrong about which.
   */
  matchedBy: 'message' | 'bound' | 'column';
}

/**
 * The column an issue is about, across the path shapes these libraries use.
 *
 * zod and ArkType spell a path item as the key itself; valibot spells it as an object carrying
 * one. The last key is taken rather than the first, so an issue inside an array or a nested
 * payload names the field rather than the collection holding it.
 */
function drzlIssueColumn(issue: any): string | undefined {
  const path = issue?.path;
  if (!Array.isArray(path)) return undefined;
  for (let i = path.length - 1; i >= 0; i--) {
    const item: any = path[i];
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object' && typeof item.key === 'string') return item.key;
  }
  return undefined;
}

/**
 * The numeric bound an issue reports, as a decimal string, or nothing.
 *
 * Measured rather than guessed: zod 4.4.3 puts \`minimum\`/\`maximum\` on a \`too_small\`/\`too_big\`
 * issue and valibot 1.4.2 puts \`requirement\` on a \`min_value\`/\`max_value\` one. A bigint bound
 * is read too, since a 64 bit column's range is not representable as a number.
 */
function drzlIssueBound(issue: any): string | undefined {
  for (const key of ['minimum', 'maximum', 'requirement']) {
    const v = issue?.[key];
    if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  }
  return undefined;
}

/**
 * The constraint a validation issue came from, or nothing.
 *
 * Three tiers, because a constraint does not always survive into the issue in the same form. Every
 * constraint stated as a predicate carries a message these schemas wrote, and that is an exact
 * lookup. A numeric CHECK is deliberately folded into the column's own range instead, so the
 * failure is worded by the library and the constraint name is nowhere in it; the bound is, and it
 * is matched on that. A set constraint becomes an enum and leaves neither, so it is resolved by
 * the column alone, which is safe only because a column can carry one such constraint at most.
 *
 * The two folds are kept apart rather than pooled, and that is what stops the third tier
 * over-claiming. A folded bound always reports its bound, in every library measured, so an issue
 * on that column carrying **no** bound is not that constraint: it is the field failing to be a
 * number at all. Pooling them answered \`invalid_type\` on a column with a numeric CHECK with the
 * CHECK, which is a rule the row did not break.
 *
 * Returns nothing rather than a guess, for the same reason. A \`too_small\` reporting the column's
 * own type bound has no matching constraint and gets no answer.
 */
export function constraintForIssue(
  table: string,
  issue: unknown
): DrzlConstraintMatch | undefined {
  const ledger = constraintsByTable[table];
  if (!ledger) return undefined;
  const raw: any = issue;
  const column = drzlIssueColumn(raw);
  const message = typeof raw?.message === 'string' ? raw.message : undefined;

  if (message !== undefined) {
    for (const constraint of ledger.constraints) {
      if (!constraint.messages || constraint.messages.indexOf(message) < 0) continue;
      if (column !== undefined && constraint.columns.indexOf(column) < 0) continue;
      return {
        constraint,
        column: column ?? constraint.columns[0],
        matchedBy: 'message',
      };
    }
  }

  if (column === undefined) return undefined;

  const bound = drzlIssueBound(raw);
  if (bound !== undefined) {
    const hit = ledger.constraints.find(
      (c) => c.bounds && c.bounds.some((b) => b.column === column && b.value === bound)
    );
    return hit ? { constraint: hit, column, matchedBy: 'bound' } : undefined;
  }

  const sets = ledger.constraints.filter((c) => c.values && c.values.column === column);
  return sets.length === 1 ? { constraint: sets[0], column, matchedBy: 'column' } : undefined;
}`;

/**
 * A JavaScript identifier that cannot collide with anything else in the module.
 *
 * A Drizzle export name reaches this verbatim, and it is a TypeScript identifier already, so the
 * replacement below only has to survive the shapes a table name can take when it is not one.
 */
function constName(tsName: string): string {
  const safe = tsName.replace(/[^A-Za-z0-9_$]/g, '_');
  return `${/^[0-9]/.test(safe) ? `_${safe}` : safe}Constraints`;
}

/**
 * The `constraints.ts` module, as source.
 *
 * Plain objects and, optionally, one function. Nothing here imports a validator or any part of
 * DRZL, so a consumer can read the ledger from a script, a form builder or a server route without
 * pulling a schema in. The matcher is a separate export for the same reason a separate option
 * turns it off: a consumer who only renders forms should not carry the code that maps failures.
 *
 * `JSON.stringify` rather than a hand-rolled literal, because every string here comes from a
 * schema the user wrote: a table named `it's` or a CHECK holding a quote has to survive into valid
 * TypeScript. The formatter unquotes the keys that do not need quoting.
 */
export function renderConstraintsModule(
  tables: Table[],
  opts: ConstraintsModuleOptions = {}
): string {
  const entries = tables.map((t) => ({ tsName: t.tsName, facts: tableConstraints(t) }));
  const consts = entries
    .map(
      (e) =>
        `/** Every constraint on \`${e.facts.table}\`. */\n` +
        `export const ${constName(e.tsName)}: DrzlTableConstraints = ${JSON.stringify(e.facts, null, 2)};`
    )
    .join('\n\n');
  const record =
    `/** Every table's constraints, keyed by the Drizzle export name its schemas are named after. */\n` +
    `export const constraintsByTable: Record<string, DrzlTableConstraints> = {\n` +
    entries.map((e) => `  ${JSON.stringify(e.tsName)}: ${constName(e.tsName)},`).join('\n') +
    `\n};`;

  return [
    '/**',
    ' * Every CHECK, unique constraint, primary and foreign key on each table, as data.',
    ' *',
    ' * Generated beside the schemas rather than derived from them: a validator states what a value',
    ' * must look like and says nothing about which constraint said so, and the two constraints a',
    ' * per-row schema cannot check at all, uniqueness and a foreign key, are not in it in any form.',
    ' */',
    TYPES,
    consts,
    record,
    ...(opts.errorMap ? [MATCHER] : []),
  ].join('\n\n');
}
