/**
 * The facts a generated schema can carry beside itself.
 *
 * A validator says what a value must look like. It does not say where the value came from, and a
 * consumer holding only the schema cannot recover that: `z.string()` is a `text`, a `varchar(40)`,
 * a `citext` and a `char(3)` alike, and nothing on it says which, nor whether the database fills
 * it in, nor which columns key the row.
 *
 * Every key here had to pass one test: **it says something the emitted schema does not already
 * say.** Two ways to pass it.
 *
 *   the schema never knew it     the SQL type, the primary key, the unique constraints, the
 *                                dialect, whether the database generates or defaults the value.
 *
 *   the schema enforces it and   a declared width and every CHECK are `.refine()` calls, and
 *   cannot show it               `z.toJSONSchema` drops a refinement in silence. Measured on zod
 *                                4.4.3: `z.object({ s: z.string().refine(...) })` produces
 *                                `{ s: { type: 'string' } }` with no warning and no trace. So a
 *                                JSON Schema built from an emitted module is wrong by omission,
 *                                and nothing in the document says so.
 *
 * Nullability is the counter-example, and its absence is the rule working: `.nullable()` is in the
 * schema and `anyOf: [..., { type: 'null' }]` is in its JSON Schema, so a `nullable` key would be a
 * second copy of an answer the consumer already has. Same for the enum values, the integer-ness of
 * a number and every numeric bound.
 *
 * Nothing here is a user comment, because there are none to carry. Measured against drizzle-orm on
 * both majors: no column, table or builder exposes one, and a `comment` key passed to a column's
 * options object is dropped before the column is built. See the zod generator's documentation.
 */
import type { Column, Table } from '@drzl/analyzer';
import {
  parseCheck,
  type CardinalityCheck,
  type ColumnCheck,
  type ColumnSet,
  type LengthCheck,
  type RowCheck,
} from './checks.js';

/** What a column adds beside its schema. Every key is optional; an empty object is a real answer. */
export interface ColumnMetaFacts {
  /** The type as the database declares it: `varchar(255)`, `numeric(10, 2)`, `text[]`. */
  sqlType?: string;
  /**
   * The declared character limit.
   *
   * Also the JSON Schema keyword of the same name, which is why it is spelled this way: the
   * emitted schema enforces the limit inside a `.refine()` closure, `toJSONSchema` drops that, and
   * this key puts the constraint back in the one spelling every JSON Schema validator enforces.
   *
   * On an array column the limit is the *element's*, since that is where the emitted schema
   * applies it.
   */
  maxLength?: number;
  /** The declared byte limit, which only MySQL's TEXT and BLOB families carry. */
  maxBytes?: number;
  /**
   * The database supplies a value when the write omits one.
   *
   * Not recoverable from the schema: a defaulted column and a nullable one are both `.optional()`
   * on insert, so the wrapper cannot tell them apart, and on select neither leaves a trace.
   */
  hasDefault?: true;
  /** The database computes the value and refuses to be given one. Absent from the write schemas. */
  generated?: true;
  /**
   * The CHECK constraints this field enforces, named as the failure messages name them.
   *
   * Not a restatement of the bound beside it. DRZL deliberately folds a CHECK into the column's
   * own range, so `minimum: 18` in the JSON Schema is indistinguishable from a type bound, and a
   * set constraint renders as an enum indistinguishable from a declared one. The provenance is
   * what this carries, along with the constraint name a database error will quote back.
   */
  checks?: string[];
  /** Prose for a reader, from the constraints the schema enforces and cannot show. Opt-in. */
  description?: string;
}

/** What a table's schema adds beside itself. */
export interface TableMetaFacts {
  /** The SQL table name, which is not the Drizzle export name the schema is named after. */
  table: string;
  /** Which database this was analysed from. The same declaration means different things across them. */
  dialect?: string;
  /** Which of the three schemas this is. The export name says it; the schema object does not. */
  mode: string;
  /** The primary key columns, in order. A per-field flag cannot carry the order or the grouping. */
  primaryKey?: string[];
  /**
   * The unique constraints.
   *
   * The one constraint a per-row validator structurally cannot check, which is why
   * `duplicateFinder` exists at all. Carrying it lets a consumer see what the schema is silent
   * about rather than assume it is silent because there is nothing to say.
   */
  unique?: string[][];
  /** The relation refuses writes, which today means a materialized view. */
  readOnly?: true;
  /** Row-level CHECKs, enforced as object refinements and so invisible for the same reason. */
  checks?: string[];
  /**
   * CHECK constraints the database enforces and this schema does not.
   *
   * Either the parser declined the expression, or it understood it and the column's shape has no
   * way to state it. Both mean the same thing to a caller: the database can reject a row this
   * schema accepted. Nothing else in the emitted module mentions these at all.
   */
  unenforcedChecks?: string[];
  /** Prose for a reader. Opt-in. */
  description?: string;
}

export interface MetaFactOptions {
  /** Also write a `description`, which is what an OpenAPI reader renders. Off by default. */
  description?: boolean;
}

export interface TableMetaOptions extends MetaFactOptions {
  mode: string;
  dialect?: string;
}

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
function lengthText(k: LengthCheck): string {
  return labelled(k.name, `length(${k.column}) ${k.operator} ${k.value}`);
}
function cardinalityText(k: CardinalityCheck): string {
  return labelled(k.name, `cardinality(${k.column}) ${k.operator} ${k.value}`);
}
function rowText(k: RowCheck): string {
  return labelled(k.name, `${k.left} ${k.operator} ${k.right}`);
}

/**
 * Whether a field-level constraint reaches this column at all.
 *
 * The same three guards every validation generator applies. A comparison against a scalar says
 * nothing usable about an array or a tuple, and a character count says nothing about either; a
 * cardinality is the mirror image and only means something on an array. A constraint that fails
 * its guard is enforced nowhere, so it is reported on the table as unenforced rather than
 * silently attributed to a field that does not check it.
 */
function takesScalarChecks(c: Column): boolean {
  return !c.arrayDimensions && !c.shape;
}

/** Every CHECK on the table, split by where it lands. */
function classifyChecks(table: Table) {
  const perColumn = new Map<string, string[]>();
  const rows: string[] = [];
  const unenforced: string[] = [];
  const byName = new Map(table.columns.map((c) => [c.name, c]));

  const add = (column: string, text: string, guard: (c: Column) => boolean) => {
    const c = byName.get(column);
    // A constraint naming a column that is not on this table cannot be attributed to anything,
    // and one whose column refuses the constraint is not checked by any field. Both are the
    // caller's problem rather than a fact to hide.
    if (!c || !guard(c)) {
      unenforced.push(text);
      return;
    }
    const list = perColumn.get(column) ?? [];
    list.push(text);
    perColumn.set(column, list);
  };

  for (const k of table.checks ?? []) {
    const parsed = parseCheck(k.expression, k.name);
    if (!parsed.ok) {
      unenforced.push(labelled(k.name, (k.expression ?? '').trim()));
      continue;
    }
    for (const c of parsed.checks) add(c.column, columnCheckText(c), takesScalarChecks);
    for (const s of parsed.sets ?? []) add(s.column, setText(s), takesScalarChecks);
    for (const l of parsed.lengths ?? []) add(l.column, lengthText(l), takesScalarChecks);
    for (const a of parsed.cardinalities ?? [])
      add(a.column, cardinalityText(a), (c) => !!c.arrayDimensions);
    for (const r of parsed.rows ?? []) {
      // A row check needs both columns present in the mode being rendered. That is decided by the
      // generator, which knows the mode; here it is a fact about the table.
      if (byName.has(r.left) && byName.has(r.right)) rows.push(rowText(r));
      else unenforced.push(rowText(r));
    }
  }
  return { perColumn, rows, unenforced };
}

/** The prose form of what a field enforces and cannot show, or nothing. */
function columnDescription(facts: ColumnMetaFacts): string | undefined {
  const parts: string[] = [];
  if (facts.maxLength !== undefined) parts.push(`at most ${facts.maxLength} characters`);
  if (facts.maxBytes !== undefined) parts.push(`at most ${facts.maxBytes} bytes`);
  for (const c of facts.checks ?? []) parts.push(`CHECK ${c}`);
  return parts.length ? parts.join('. ') : undefined;
}

function tableDescription(facts: TableMetaFacts): string | undefined {
  const parts: string[] = [];
  for (const c of facts.checks ?? []) parts.push(`CHECK ${c}`);
  if (facts.unenforcedChecks?.length) {
    parts.push(
      `not enforced by this schema, the database also checks: ${facts.unenforcedChecks.join('; ')}`
    );
  }
  return parts.length ? parts.join('. ') : undefined;
}

/**
 * The metadata for one column.
 *
 * `table` is needed because a CHECK is declared on the table and only then attributed to a column,
 * and because whether a constraint is enforced at all depends on the other columns it names.
 */
export function columnMetaFacts(
  column: Column,
  table: Table,
  opts: MetaFactOptions = {}
): ColumnMetaFacts {
  const checks = classifyChecks(table).perColumn.get(column.name);
  const facts: ColumnMetaFacts = {
    ...(column.sqlType ? { sqlType: column.sqlType } : {}),
    ...(column.maxLength !== undefined ? { maxLength: column.maxLength } : {}),
    ...(column.maxBytes !== undefined ? { maxBytes: column.maxBytes } : {}),
    ...(column.hasDefault ? { hasDefault: true as const } : {}),
    ...(column.isGenerated ? { generated: true as const } : {}),
    ...(checks?.length ? { checks } : {}),
  };
  if (!opts.description) return facts;
  const description = columnDescription(facts);
  return description ? { ...facts, description } : facts;
}

/** The metadata for one table's schema, in one mode. */
export function tableMetaFacts(table: Table, opts: TableMetaOptions): TableMetaFacts {
  const { rows, unenforced } = classifyChecks(table);
  const pk = table.primaryKey?.columns ?? [];
  const unique = (table.unique ?? []).map((k) => k.columns).filter((c) => c.length > 0);
  const facts: TableMetaFacts = {
    table: table.name,
    ...(opts.dialect ? { dialect: opts.dialect } : {}),
    mode: opts.mode,
    ...(pk.length ? { primaryKey: pk } : {}),
    ...(unique.length ? { unique } : {}),
    ...(table.readOnly ? { readOnly: true as const } : {}),
    ...(rows.length ? { checks: rows } : {}),
    ...(unenforced.length ? { unenforcedChecks: unenforced } : {}),
  };
  if (!opts.description) return facts;
  const description = tableDescription(facts);
  return description ? { ...facts, description } : facts;
}
