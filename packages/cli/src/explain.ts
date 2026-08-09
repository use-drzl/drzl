/**
 * `drzl explain <table>`: what DRZL understood about one table, and what it did not.
 *
 * The command exists for one moment: a generated schema is wrong, and the reader has no way to
 * tell whether the analyzer misread the column, dropped the CHECK, failed to follow the relation,
 * or read all three correctly and the generator is at fault. Today that question is answered by
 * reading `drzl analyze --json` output, which is the whole analysis of the whole schema with
 * nothing pointed out, or by reading the emitted validator and inferring backwards.
 *
 * Three sources are read, and none of them is re-derived here:
 *
 * - **The analyzer**, for the table itself: the resolved `tsType`, the declared `sqlType`,
 *   nullability, defaults, keys, foreign keys, enum members and every measured fact
 *   (`min`/`max`/`integer`/`allowsNaN`/`allowsInfinity`/`format`/`maxLength`/`maxBytes`).
 * - **`tableConstraints` from `@drzl/validation-core`**, for whether a generated schema actually
 *   checks each constraint. That function is what the emitted constraint ledger is built from, so
 *   `explain` and the generated modules cannot disagree about what is enforced. It is also where
 *   a CHECK's classification lives: a clause the shared parser declined comes back as an
 *   `unenforced` entry with the parser's own reason, which is the sentence this command exists to
 *   surface.
 * - **The analysis's own `issues`**, filtered to this table, for a column type nobody has modelled
 *   and a relation the analyzer could not follow.
 *
 * The two questions it deliberately answers together are "what is here" and "what is silently not
 * here". A column DRZL cannot type still emits a validator, a CHECK the parser declines is simply
 * absent from the output, and a `varchar(255)` on an enum column never reaches the schema as a
 * width. All three produce a file that looks finished, and all three are named here.
 *
 * It writes nothing. `--dry-run` has no meaning for a command that has never had a write path.
 */
import type { Analysis, Column, Issue, Relation, Table } from '@drzl/analyzer';
import { qualifiedForeignTable, qualifiedTableName } from '@drzl/analyzer';
import { tableConstraints, type ConstraintFacts } from '@drzl/validation-core';
import { Chalk, type ChalkInstance } from 'chalk';
import { nearestKey } from './config-errors.js';
import { addressableName, displayTableName, tableAliases } from './patterns.js';

/**
 * The styling used when a caller does not pass one.
 *
 * Level 0, so a caller who forgets gets plain text rather than escape sequences in a file. The
 * decision belongs to `output.ts`, which asks it per stream; see the same constant in `doctor.ts`.
 */
const PLAIN: ChalkInstance = new Chalk({ level: 0 });

/* ------------------------------------------------------------------------------------------ */
/* Finding the table                                                                           */
/* ------------------------------------------------------------------------------------------ */

/** Which of a table's three names the query matched. */
export type MatchedOn =
  /** The bare database name, `users`. */
  | 'name'
  /** The qualified database name, `reporting.users`, or `public.users` for the default schema. */
  | 'qualified'
  /** The TypeScript export name, which is not always the database name. */
  | 'tsName';

export interface TableHit {
  table: Table;
  matchedOn: MatchedOn;
}

export type TableMatch =
  | ({ kind: 'found'; exact: boolean } & TableHit)
  /** Two or more tables answer to that name. Never resolved silently; see `matchTable`. */
  | { kind: 'ambiguous'; exact: boolean; hits: TableHit[] }
  | { kind: 'none'; suggestion?: string };

/**
 * Every name one table answers to, most specific first.
 *
 * `tableAliases` supplies the two database spellings, so `explain` and the config's `include`
 * and `exclude` agree about what `public.users` means without either restating it. The export
 * name is the third, because a reader looking at their own schema file knows
 * `export const orgMembers` and may never have seen the string `organisation_members`.
 *
 * Order is the order a hit is reported in, and the qualified name is first: a table in a named
 * SQL schema is identified by that spelling and by no other, so a query that used it should be
 * reported as having used it.
 */
function namesOf(table: Table): Record<MatchedOn, string> {
  const [bare, qualified] = tableAliases(table);
  return { qualified, name: bare, tsName: table.tsName };
}

const MATCH_ORDER: MatchedOn[] = ['qualified', 'name', 'tsName'];

/** What each of the three names is called in a sentence. */
const MATCH_LABELS: Record<MatchedOn, string> = {
  qualified: 'the schema-qualified name',
  name: 'the database name',
  tsName: 'the export name',
};

/** Every table whose names contain `query`, under the given case folding, one hit per table. */
function hitsFor(tables: readonly Table[], query: string, fold: (s: string) => string): TableHit[] {
  const wanted = fold(query);
  const hits: TableHit[] = [];
  for (const table of tables) {
    const names = namesOf(table);
    const matchedOn = MATCH_ORDER.find((key) => fold(names[key]) === wanted);
    if (matchedOn) hits.push({ table, matchedOn });
  }
  return hits;
}

const same = (s: string) => s;
const folded = (s: string) => s.toLowerCase();

/**
 * The table a query names, or why it names none.
 *
 * Exact before case-insensitive, and both over all three names at once. The two rounds are
 * separate passes rather than one pass with a fallback comparison, because a schema holding both
 * `users` and `Users` has an exact answer for each, and a single case-insensitive pass would call
 * both of them ambiguous.
 *
 * Ambiguity is reported rather than resolved. It is reachable from an ordinary schema: two
 * `pgSchema` tables share one bare name, and a table's export name can be another table's
 * database name. Picking the first would answer a question about one table with facts about a
 * different one, which is the single worst thing a command whose whole job is diagnosis can do.
 *
 * An ambiguous exact round stops there rather than falling through to the case-insensitive one.
 * Loosening the comparison can only add hits, so the second round cannot resolve what the first
 * could not.
 */
export function matchTable(tables: readonly Table[], query: string): TableMatch {
  for (const [exact, fold] of [
    [true, same],
    [false, folded],
  ] as const) {
    const hits = hitsFor(tables, query, fold);
    if (hits.length === 1) return { kind: 'found', exact, ...hits[0] };
    if (hits.length > 1) return { kind: 'ambiguous', exact, hits };
  }
  // Only ever reached when nothing matched under either folding, so the suggestion is about a
  // misspelling rather than about a case difference, which the second round has already forgiven.
  const known = tables.flatMap((t) => {
    const names = namesOf(t);
    return t.tsName === names.name ? [names.name] : [names.name, names.tsName];
  });
  return { kind: 'none', suggestion: nearestKey(query, known) };
}

/* ------------------------------------------------------------------------------------------ */
/* The explanation                                                                             */
/* ------------------------------------------------------------------------------------------ */

/** How a column's default arrives, which decides whether any generated schema can state it. */
export type ExplainDefault =
  /** `.default('GB')`: a literal a schema can reproduce. */
  | { kind: 'literal'; value: unknown }
  /** A `sql` default the analyzer rendered back to text. */
  | { kind: 'expression'; text: string }
  /**
   * `defaultNow()`, `defaultRandom()`, `$defaultFn` and a `serial`'s sequence: the value exists
   * only at insert time, so the field is optional on insert and no schema states what it becomes.
   */
  | { kind: 'runtime' };

/**
 * One measured fact about a column, and whether any generated schema says it.
 *
 * `stated` is not decided here. A width, a byte cap and a set of members are each read by every
 * validation generator through the same guards `tableConstraints` applies, so the verdict comes
 * off that function's output rather than from a second copy of the rule; see `capStated`.
 */
export interface ExplainFact {
  text: string;
  stated: boolean;
  /** Why nothing states it, when nothing does. */
  reason?: string;
}

export interface ExplainColumn {
  name: string;
  tsType: string;
  /** The coarse family label, `TEXT` for every one of varchar, char and text. */
  dbType: string;
  /** The type as the database declares it, `varchar(255)`, absent where Drizzle would not say. */
  sqlType?: string;
  nullable: boolean;
  hasDefault: boolean;
  default: ExplainDefault | null;
  isGenerated: boolean;
  inPrimaryKey: boolean;
  /** Named by a single-column UNIQUE constraint. A composite one is in `unique` instead. */
  unique: boolean;
  references?: {
    table: string;
    schema?: string;
    column: string;
    onDelete?: string;
    onUpdate?: string;
  };
  enumValues?: string[];
  arrayDimensions?: number;
  shape?: Column['shape'];
  facts: ExplainFact[];
}

/** A relation with this table at one end, in the direction the analysis recorded it. */
export interface ExplainRelation extends Relation {
  /** Whether this table is the `from` end. */
  outgoing: boolean;
}

/**
 * Something in this table that DRZL read and could not use.
 *
 * The section the command exists for. Every entry here is a place where the generated output is
 * quietly narrower than the schema, and none of them is visible in the generated files.
 */
export interface ExplainGap {
  kind:
    /** A CHECK, or one clause of one, that no generated schema enforces. */
    | 'check'
    /** A column whose validator will accept any value. */
    | 'column'
    /** A relation the analyzer could not follow. */
    | 'relation'
    /** Anything else the analyzer said about this table. */
    | 'analyzer';
  /** The column or constraint it is about, where it is about one. */
  subject?: string;
  message: string;
  hint?: string;
}

export interface TableExplanation {
  /** The database table name, which is not always the export name. */
  name: string;
  /** The TypeScript export name. */
  tsName: string;
  /** The SQL schema, present only where the table declares one. */
  schema?: string;
  /** `reporting.users`, or the bare `users` for a table in the default schema. */
  qualified: string;
  /** `public.users`: the one spelling that addresses this table and no other. */
  addressable: string;
  /** Set for a materialized view, which takes no writes, so no insert or update schema is emitted. */
  readOnly: boolean;
  /** Which name the query matched, and whether it matched without case folding. */
  matchedOn: MatchedOn;
  matchedExactly: boolean;
  /** True when this config's `include`/`exclude` removes the table, so no generator sees it. */
  excludedByConfig?: boolean;
  /** Columns this config's `columns` filter removes, in declaration order. */
  columnsRemovedByConfig?: string[];
  columns: ExplainColumn[];
  primaryKey: { name?: string; columns: string[]; generated: boolean } | null;
  unique: { name?: string; columns: string[] }[];
  indexes: { name?: string; columns: string[] }[];
  foreignKeys: {
    name?: string;
    columns: string[];
    references: { table: string; columns: string[] };
    onDelete?: string;
    onUpdate?: string;
  }[];
  relations: ExplainRelation[];
  /**
   * Every constraint on the table with the verdict a generated schema gives it, verbatim from
   * `tableConstraints`. The primary key, every UNIQUE, every foreign key, every CHECK and the
   * declared widths, each with `enforced` and, where it is false, the reason per clause.
   */
  constraints: ConstraintFacts[];
  /** What DRZL read and could not use. Empty when the whole table was understood. */
  gaps: ExplainGap[];
}

/** One line of the index a bare `drzl explain` prints. */
export interface TableSummary {
  name: string;
  tsName: string;
  schema?: string;
  qualified: string;
  columns: number;
  checks: number;
  /** How many entries `drzl explain <this table>` would list under "Not understood". */
  gaps: number;
}

/** The literal a `.default()` stored, as it would read in a schema file. */
function renderLiteral(value: unknown): string {
  if (typeof value === 'string') return `'${value.replace(/'/g, "\\'")}'`;
  if (value === null) return 'null';
  if (typeof value === 'bigint') return `${value}n`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** How a column's default arrives, or nothing where it has none. */
function defaultOf(column: Column): ExplainDefault | null {
  if (column.defaultValue !== undefined) return { kind: 'literal', value: column.defaultValue };
  if (column.defaultExpression) return { kind: 'expression', text: column.defaultExpression };
  return column.hasDefault ? { kind: 'runtime' } : null;
}

/** A default in one cell of the column table. */
function describeDefault(value: ExplainDefault | null): string {
  if (!value) return '';
  if (value.kind === 'literal') return `default ${renderLiteral(value.value)}`;
  if (value.kind === 'expression') return `default ${value.text}`;
  return 'has default';
}

/** What a `ColumnShape` is, in a sentence. Every kind has an arm, so a new one cannot go unnamed. */
function describeShape(shape: NonNullable<Column['shape']>): string {
  switch (shape.kind) {
    case 'buffer':
      return 'binary payload, carried as a Uint8Array';
    case 'json':
      return 'any JSON value, checked recursively';
    case 'tuple':
      return `tuple of ${shape.length} numbers`;
    case 'numberObject':
      return `object of numbers: ${shape.fields.join(', ')}`;
    case 'numberVector':
      return shape.length ? `numeric vector of ${shape.length}` : 'numeric vector';
    case 'custom':
      return shape.sqlType
        ? `customType, declared ${shape.sqlType}, with no runtime shape to read`
        : 'customType, with no runtime shape to read';
    case 'bitstring':
      if (shape.length === undefined) return 'string of 0 and 1';
      return shape.exact
        ? `string of ${shape.length} digits, each 0 or 1`
        : `string of at most ${shape.length} digits, each 0 or 1`;
    case 'byteString':
      return shape.length ? `bytes, declared width ${shape.length}` : 'bytes';
  }
}

/**
 * Why a declared width never reaches the emitted schema.
 *
 * The branches of `statesCap` in `@drzl/validation-core`, in its order, so the sentence names the
 * same reason the guard acted on. Whether it is stated is not decided here; that comes off
 * `tableConstraints`, which calls the real guard. This only puts the reason into words, and the
 * last arm is a generic sentence rather than a guess, so a branch added there is worded vaguely
 * instead of wrongly.
 */
function capReason(column: Column, narrowedBySet: boolean): string {
  if (column.shape)
    return `"${column.name}" is a structured column, whose value space is not stated as a width`;
  if (narrowedBySet)
    return `a CHECK narrows "${column.name}" to a set of literals, which states its value space instead`;
  if (column.enumValues?.length)
    return `"${column.name}" is an enum, and its members state its value space instead`;
  if (column.tsType !== 'string')
    return `"${column.name}" does not arrive as a string, so there is nothing to measure`;
  if (column.format)
    return `the ${column.format} format replaces the width on "${column.name}" rather than adding to it`;
  return `the generated schemas state "${column.name}" some other way`;
}

/**
 * Everything measured about a column that a validator can act on, with the verdict beside it.
 *
 * The order is the order it reads: what the value is, then how wide, then what it may hold.
 */
function factsFor(
  column: Column,
  opts: { capStated: boolean; narrowedBySet: boolean }
): ExplainFact[] {
  const facts: ExplainFact[] = [];
  const state = (text: string) => facts.push({ text, stated: true });

  if (column.arrayDimensions) {
    state(
      column.arrayDimensions === 1
        ? 'an array of the type above'
        : `an array of ${column.arrayDimensions} dimensions`
    );
  }
  if (column.shape) state(describeShape(column.shape));
  if (column.enumValues?.length) {
    state(`one of ${column.enumValues.map((v) => `'${v}'`).join(', ')}`);
  }
  if (column.format) state(`text in the ${column.format} format the database parses`);

  if (column.min !== undefined && column.max !== undefined) {
    state(`${column.min} to ${column.max}`);
  } else if (column.min !== undefined) state(`at least ${column.min}`);
  else if (column.max !== undefined) state(`at most ${column.max}`);
  if (column.integer === true) state('whole numbers only');
  if (column.integer === false) state('fractions allowed');

  // A range cannot say either of these: `>=`/`<=` refuses an infinity whatever the two numbers
  // are, and NaN compares false against both ends, so a bounded float column described by its
  // range alone refuses values the database stores and hands back. The generators render them
  // beside the range rather than as a wider one, which is why both are worth printing.
  if (column.allowsNaN !== undefined) {
    state(column.allowsNaN ? 'NaN is stored and returned' : 'NaN is refused');
  }
  if (column.allowsInfinity !== undefined) {
    state(column.allowsInfinity ? 'Infinity is stored and returned' : 'Infinity is refused');
  }

  for (const [value, text] of [
    [column.maxLength, `at most ${column.maxLength} characters`],
    [column.maxBytes, `at most ${column.maxBytes} bytes`],
  ] as const) {
    if (value === undefined) continue;
    facts.push(
      opts.capStated
        ? { text, stated: true }
        : { text, stated: false, reason: capReason(column, opts.narrowedBySet) }
    );
  }

  const value = defaultOf(column);
  if (value?.kind === 'literal') state(`defaults to ${renderLiteral(value.value)}`);
  else if (value?.kind === 'expression') state(`defaults to ${value.text}, evaluated by the database`);
  else if (value?.kind === 'runtime') {
    facts.push({
      text: 'has a default',
      stated: false,
      reason:
        'the value is produced at insert time, by the database or by a Drizzle function, so the ' +
        'field is optional on insert and no schema states what it becomes',
    });
  }
  if (column.isGenerated) {
    state('generated by the database, so it is left out of insert and update schemas');
  }
  return facts;
}

/**
 * Whether an analyzer issue is about this table.
 *
 * Matched against all three names, because the analyzer does not use one consistently and could
 * not: a column warning is keyed on the export name, a relation warning on the qualified database
 * name, and the extra-config warning on the table name. An issue about the schema as a whole
 * carries no `path` at all and is not about any table, so it never lands here.
 */
function issueTouches(issue: Issue, table: Table): boolean {
  if (!issue.path) return false;
  const names = namesOf(table);
  const own = [names.qualified, names.name, names.tsName, table.name];
  if (own.includes(issue.path)) return true;
  const dot = issue.path.lastIndexOf('.');
  return dot > 0 && own.includes(issue.path.slice(0, dot));
}

/** The column half of a `table.column` issue path, when it has one. */
function issueColumn(issue: Issue, table: Table): string | undefined {
  const path = issue.path ?? '';
  const names = namesOf(table);
  for (const prefix of [names.qualified, names.tsName, names.name, table.name]) {
    if (path.startsWith(`${prefix}.`)) {
      const rest = path.slice(prefix.length + 1);
      if (table.columns.some((c) => c.name === rest)) return rest;
    }
  }
  return undefined;
}

/** Which analyzer codes are about a relation rather than about the table's own shape. */
const RELATION_CODES = new Set(['DRZL_ANL_RELATIONS', 'DRZL_ANL_REL_V2']);

/**
 * Everything DRZL read and could not use, in the order it costs a reader most to not know.
 *
 * Constraints first, because a declined CHECK is the case where the generated file exists,
 * compiles, validates, and enforces less than the database does with nothing anywhere saying so.
 */
function gapsFor(table: Table, constraints: ConstraintFacts[], issues: readonly Issue[]) {
  const gaps: ExplainGap[] = [];

  for (const constraint of constraints) {
    for (const part of constraint.unenforced ?? []) {
      gaps.push({
        kind: 'check',
        subject: constraint.name ?? constraint.id,
        // `part.part` already carries the constraint name where the declaration had one, because
        // that is the text an emitted schema would have attached. The renderer prefixes `subject`
        // only when it is not already there, so a named CHECK is not announced twice.
        message: `${part.part} is not enforced: ${part.reason}.`,
        hint: 'Your database still enforces it. Nothing DRZL generates does.',
      });
    }
  }

  for (const issue of issues) {
    if (issue.level === 'info') continue;
    if (!issueTouches(issue, table)) continue;
    const subject = issueColumn(issue, table);
    gaps.push({
      kind: RELATION_CODES.has(issue.code) ? 'relation' : subject ? 'column' : 'analyzer',
      ...(subject ? { subject } : {}),
      message: issue.message,
      ...(issue.hint ? { hint: issue.hint } : {}),
    });
  }
  return gaps;
}

export interface ExplainOptions {
  /** Table names this config's `include`/`exclude` leaves in place, when a config was read. */
  keptTables?: readonly string[];
  /** Column names this config's `columns` filter leaves on this table, when one was read. */
  keptColumns?: readonly string[];
}

/**
 * Everything worth saying about one table.
 *
 * A pure function of the analysis and the match, so the renderer, the `--json` document and the
 * tests all read one answer rather than three.
 */
export function explainTable(
  analysis: Analysis,
  match: Extract<TableMatch, { kind: 'found' }>,
  options: ExplainOptions = {}
): TableExplanation {
  const table = match.table;
  const qualified = qualifiedTableName(table);
  const constraints = tableConstraints(table).constraints;

  // Which columns a generated schema really caps, taken off the shared guard rather than from a
  // second copy of it here: `tableConstraints` emits a `maxLength`/`maxBytes` constraint for a
  // column exactly when the emitted schemas state one.
  const capped = new Set(
    constraints
      .filter((c) => c.kind === 'maxLength' || c.kind === 'maxBytes')
      .flatMap((c) => c.columns)
  );
  const narrowedBySet = new Set(
    constraints.filter((c) => c.values).map((c) => c.values!.column)
  );

  const primaryKeyColumns = new Set(table.primaryKey?.columns ?? []);
  const singleColumnUnique = new Set(
    (table.unique ?? []).filter((u) => u.columns.length === 1).map((u) => u.columns[0])
  );

  const columns: ExplainColumn[] = table.columns.map((column) => ({
    name: column.name,
    tsType: column.tsType,
    dbType: column.dbType,
    ...(column.sqlType ? { sqlType: column.sqlType } : {}),
    nullable: column.nullable,
    hasDefault: column.hasDefault,
    default: defaultOf(column),
    isGenerated: column.isGenerated,
    inPrimaryKey: primaryKeyColumns.has(column.name),
    unique: singleColumnUnique.has(column.name),
    ...(column.references ? { references: column.references } : {}),
    ...(column.enumValues ? { enumValues: column.enumValues } : {}),
    ...(column.arrayDimensions ? { arrayDimensions: column.arrayDimensions } : {}),
    ...(column.shape ? { shape: column.shape } : {}),
    facts: factsFor(column, {
      capStated: capped.has(column.name),
      narrowedBySet: narrowedBySet.has(column.name),
    }),
  }));

  const relations: ExplainRelation[] = analysis.relations
    .filter((r) => r.from === qualified || r.to === qualified || r.via === qualified)
    .map((r) => ({ ...r, outgoing: r.from === qualified }));

  // A key is "generated" when the database fills it in without being told, which is the question
  // a reader has about an insert schema. `isGenerated` alone answers it for an identity column and
  // not for a `serial`, whose sequence arrives as an ordinary default with nothing else naming it.
  const keyColumns = table.columns.filter((c) => primaryKeyColumns.has(c.name));
  const primaryKey = table.primaryKey?.columns.length
    ? {
        ...(table.primaryKey.name ? { name: table.primaryKey.name } : {}),
        columns: [...table.primaryKey.columns],
        generated: keyColumns.length > 0 && keyColumns.every((c) => c.isGenerated || c.hasDefault),
      }
    : null;

  const removed = options.keptColumns
    ? table.columns.map((c) => c.name).filter((name) => !options.keptColumns!.includes(name))
    : [];

  return {
    name: table.name,
    tsName: table.tsName,
    ...(table.schema ? { schema: table.schema } : {}),
    qualified,
    addressable: addressableName(table),
    readOnly: !!table.readOnly,
    matchedOn: match.matchedOn,
    matchedExactly: match.exact,
    ...(options.keptTables && !options.keptTables.includes(qualified)
      ? { excludedByConfig: true }
      : {}),
    ...(removed.length ? { columnsRemovedByConfig: removed } : {}),
    columns,
    primaryKey,
    unique: (table.unique ?? []).map((u) => ({
      ...(u.name ? { name: u.name } : {}),
      columns: [...u.columns],
    })),
    indexes: (table.indexes ?? []).map((i) => ({
      ...(i.name ? { name: i.name } : {}),
      columns: [...i.columns],
    })),
    foreignKeys: (table.foreignKeys ?? []).map((fk) => ({
      ...(fk.name ? { name: fk.name } : {}),
      columns: [...fk.columns],
      references: { table: qualifiedForeignTable(fk), columns: [...fk.foreignColumns] },
      ...(fk.onDelete ? { onDelete: fk.onDelete } : {}),
      ...(fk.onUpdate ? { onUpdate: fk.onUpdate } : {}),
    })),
    relations,
    constraints,
    gaps: gapsFor(table, constraints, analysis.issues),
  };
}

/**
 * One line per table, with the number of things DRZL did not understand about each.
 *
 * The last number is why this exists rather than being left to `analyze`, which prints the whole
 * analysis as JSON and points at nothing in it. A reader with forty tables and one wrong file gets
 * told which table to run `explain` on instead of reading forty.
 */
export function summarize(analysis: Analysis): TableSummary[] {
  return analysis.tables.map((table) => ({
    name: table.name,
    tsName: table.tsName,
    ...(table.schema ? { schema: table.schema } : {}),
    qualified: qualifiedTableName(table),
    columns: table.columns.length,
    checks: table.checks?.length ?? 0,
    gaps: gapsFor(table, tableConstraints(table).constraints, analysis.issues).length,
  }));
}

/* ------------------------------------------------------------------------------------------ */
/* Rendering                                                                                   */
/* ------------------------------------------------------------------------------------------ */

/**
 * How wide the report lays itself out.
 *
 * 80 rather than the 96 `doctor` wraps its prose at, because this one prints aligned rows and a
 * row that wraps is worse than a paragraph that does: the eye loses the column. Everything with a
 * computed width is fitted inside this, and the only cells allowed past it are the last one on a
 * line, where an overflow costs a soft wrap and nothing else.
 */
const WIDTH = 80;

const pad = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - text.length));

/** The widest of a set of strings, which is the column width every row is padded to. */
const widest = (values: string[]) => values.reduce((n, v) => Math.max(n, v.length), 0);

/** Wrap a sentence under a fixed indent. Same shape as `doctor`'s, at this file's width. */
function wrap(text: string, indent: string, first = indent): string {
  const lines: string[] = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    if (line && `${line} ${word}`.length + indent.length > WIDTH) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i === 0 ? first : indent) + l).join('\n');
}

/**
 * The TypeScript type as a reader of the generated schema would write it.
 *
 * `tsType` is the *element* type on an array column, because Drizzle gives an array no class of
 * its own and the analyzer records the depth separately. Printing it bare said `string` for a
 * `text[]`, which is the exact misreading that produced the array defect `arrayDimensions` was
 * added to fix, so the suffix is put back here.
 */
function renderTsType(column: ExplainColumn): string {
  return column.tsType + '[]'.repeat(column.arrayDimensions ?? 0);
}

/** The short markers beside a column: what it is to the table, rather than what it holds. */
function columnNotes(column: ExplainColumn): string {
  const notes: string[] = [];
  if (column.inPrimaryKey) notes.push('pk');
  if (column.unique) notes.push('unique');
  if (column.references) {
    notes.push(`fk -> ${column.references.table}.${column.references.column}`);
  }
  if (column.isGenerated) notes.push('generated');
  const value = describeDefault(column.default);
  if (value && !column.isGenerated) notes.push(value);
  return notes.join(', ');
}

/** The rule and the verdict for one constraint, as the reader needs to read them: side by side. */
function constraintLines(
  constraint: ConstraintFacts,
  style: ChalkInstance,
  labelWidth: number
): string[] {
  const label = constraint.name ?? '';
  const verdict = constraint.enforced
    ? style.green('enforced')
    : style.yellow('not enforced by any generated schema');
  const out = [`  ${pad(label, labelWidth)}  ${constraint.rule}`];
  out.push(`  ${' '.repeat(labelWidth)}  ${verdict}`);
  for (const part of constraint.unenforced ?? []) {
    out.push(style.dim(wrap(part.reason, ' '.repeat(labelWidth + 4))));
  }
  return out;
}

/**
 * The human report.
 *
 * Grouped rather than one flat list, because the questions are different: "did DRZL read my column
 * right" is answered by the first two sections and "is my constraint enforced" by the next three,
 * and a reader arrives holding exactly one of them.
 */
export function renderExplanation(
  explanation: TableExplanation,
  context: { schema: string; dialect: string },
  style: ChalkInstance = PLAIN
): string {
  const out: string[] = [];
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

  out.push(style.bold(explanation.qualified) + style.dim(`  ${context.schema}`));
  const identity = [
    context.dialect,
    `table "${explanation.name}"`,
    `export "${explanation.tsName}"`,
    plural(explanation.columns.length, 'column'),
  ];
  if (explanation.readOnly) identity.push('read-only, so no insert or update schema is emitted');
  out.push(style.dim('  ' + identity.join(', ')));
  if (!explanation.matchedExactly) {
    // Said out loud, because a case-folded match is the one way this report can be about a table
    // the reader did not think they were asking for.
    out.push(style.dim(`  matched on ${MATCH_LABELS[explanation.matchedOn]}, ignoring case`));
  }
  if (explanation.excludedByConfig) {
    out.push('');
    out.push(style.yellow('  This config\'s include/exclude removes this table.'));
    out.push(style.dim('  No generator sees it, so nothing below reaches any emitted file.'));
  }
  if (explanation.columnsRemovedByConfig?.length) {
    out.push('');
    out.push(
      style.yellow(
        `  This config's columns filter removes ${explanation.columnsRemovedByConfig.length} of ` +
          `these columns: ${explanation.columnsRemovedByConfig.join(', ')}.`
      )
    );
  }
  out.push('');

  // ---- columns -------------------------------------------------------------------------------
  out.push(style.bold('Columns'));
  const tsTypes = explanation.columns.map(renderTsType);
  const nameWidth = widest(['COLUMN', ...explanation.columns.map((c) => c.name)]);
  const tsWidth = widest(['TS TYPE', ...tsTypes]);
  const sqlWidth = widest(['SQL TYPE', ...explanation.columns.map((c) => c.sqlType ?? c.dbType)]);
  out.push(
    style.dim(
      `  ${pad('COLUMN', nameWidth)}  ${pad('TS TYPE', tsWidth)}  ` +
        `${pad('SQL TYPE', sqlWidth)}  NULL`
    )
  );
  explanation.columns.forEach((column, i) => {
    // `sqlType` is what the database declares and is the answer a reader came for; `dbType` is a
    // coarse family label and stands in only where Drizzle's builder would not answer at all.
    const sql = column.sqlType ?? column.dbType;
    const notes = columnNotes(column);
    const nullable = column.nullable ? 'yes' : 'no';
    out.push(
      `  ${pad(column.name, nameWidth)}  ${pad(tsTypes[i], tsWidth)}  ` +
        `${pad(sql, sqlWidth)}  ` +
        // Padded only when something follows it: a trailing run of spaces on every second row is
        // invisible in a terminal and is the first thing a test diff shows.
        (notes ? `${pad(nullable, 4)}  ${style.dim(notes)}` : nullable)
    );
  });

  // ---- the measured facts --------------------------------------------------------------------
  const withFacts = explanation.columns.filter((c) => c.facts.length);
  if (withFacts.length) {
    out.push('');
    out.push(style.bold('What the generators read off each column'));
    const factWidth = widest(withFacts.map((c) => c.name));
    for (const column of withFacts) {
      let first = true;
      for (const fact of column.facts) {
        const label = first ? pad(column.name, factWidth) : ' '.repeat(factWidth);
        first = false;
        out.push(`  ${label}  ${fact.stated ? fact.text : style.yellow(fact.text)}`);
        if (fact.stated) continue;
        out.push(
          style.dim(
            wrap(
              `not stated by any generated schema: ${fact.reason}`,
              ' '.repeat(factWidth + 4)
            )
          )
        );
      }
    }
  }

  // ---- keys, foreign keys, relations ---------------------------------------------------------
  out.push('');
  out.push(style.bold('Keys'));
  if (explanation.primaryKey) {
    const pk = explanation.primaryKey;
    out.push(
      `  PRIMARY KEY (${pk.columns.join(', ')})` +
        (pk.generated ? style.dim('  filled in by the database') : '')
    );
    if (pk.columns.length > 1) {
      out.push(
        style.dim(
          wrap(
            'The service and router generators key getById, update and delete on ' +
              `"${pk.columns[0]}" alone, so those operations match on part of this key.`,
            '    '
          )
        )
      );
    }
  } else {
    out.push(style.yellow('  No primary key.'));
    out.push(
      style.dim(
        wrap(
          'The service and router generators fall back to a column named "id".',
          '    '
        )
      )
    );
  }
  for (const unique of explanation.unique) {
    out.push(`  UNIQUE (${unique.columns.join(', ')})` + (unique.name ? style.dim(`  ${unique.name}`) : ''));
  }
  for (const index of explanation.indexes) {
    out.push(style.dim(`  INDEX (${index.columns.join(', ')})${index.name ? `  ${index.name}` : ''}`));
  }

  if (explanation.foreignKeys.length) {
    out.push('');
    out.push(style.bold('Foreign keys'));
    for (const fk of explanation.foreignKeys) {
      const actions = [
        fk.onDelete ? `ON DELETE ${fk.onDelete}` : '',
        fk.onUpdate ? `ON UPDATE ${fk.onUpdate}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      out.push(
        `  (${fk.columns.join(', ')}) -> ${fk.references.table} ` +
          `(${fk.references.columns.join(', ')})` +
          (actions ? style.dim(`  ${actions}`) : '')
      );
    }
  }

  if (explanation.relations.length) {
    out.push('');
    out.push(style.bold('Relations'));
    for (const relation of explanation.relations) {
      const via = relation.via ? ` through ${relation.via}` : '';
      out.push(
        `  ${relation.from} -> ${relation.to}${via}` + style.dim(`  ${relation.kind}`)
      );
    }
  }

  // ---- constraints ---------------------------------------------------------------------------
  const checks = explanation.constraints.filter((c) => c.kind === 'check');
  if (checks.length) {
    out.push('');
    out.push(style.bold('CHECK constraints, as DRZL parsed them'));
    const labelWidth = widest(checks.map((c) => c.name ?? ''));
    for (const check of checks) out.push(...constraintLines(check, style, labelWidth));
  }

  // ---- what was not understood ---------------------------------------------------------------
  out.push('');
  if (!explanation.gaps.length) {
    out.push(style.green('Nothing about this table was dropped or left unrecognised.'));
    return out.join('\n');
  }
  out.push(style.yellow(`Not understood  (${explanation.gaps.length})`));
  out.push(style.dim('  These are in your schema and are not in anything DRZL generates.'));
  out.push('');
  // One hint under the findings that share it, so the same sentence is not repeated under twenty
  // columns. Same grouping as `doctor`, for the same reason.
  const groups = new Map<string, ExplainGap[]>();
  for (const gap of explanation.gaps) {
    const key = gap.hint ?? '';
    groups.set(key, [...(groups.get(key) ?? []), gap]);
  }
  for (const [hint, items] of groups) {
    for (const gap of items) {
      const named = gap.subject && !gap.message.startsWith(gap.subject);
      out.push(wrap((named ? `${gap.subject}: ` : '') + gap.message, '    ', `  ${style.dim('-')} `));
    }
    if (hint) out.push(style.dim(wrap(hint, '    ')));
    out.push('');
  }
  return out.join('\n').replace(/\n+$/, '');
}

/** The index a bare `drzl explain` prints. */
export function renderIndex(
  tables: TableSummary[],
  context: { schema: string; dialect: string },
  style: ChalkInstance = PLAIN
): string {
  const out: string[] = [];
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

  out.push(style.bold(context.schema) + style.dim(`  ${context.dialect}`));
  out.push(style.dim(`  ${plural(tables.length, 'table')}`));
  out.push('');

  const nameWidth = widest(['TABLE', ...tables.map((t) => t.qualified)]);
  const tsWidth = widest(['EXPORT', ...tables.map((t) => t.tsName)]);
  out.push(style.dim(`  ${pad('TABLE', nameWidth)}  ${pad('EXPORT', tsWidth)}  COLUMNS`));
  for (const table of tables) {
    const columns = String(table.columns);
    out.push(
      `  ${pad(table.qualified, nameWidth)}  ${pad(table.tsName, tsWidth)}  ` +
        (table.gaps
          ? `${pad(columns, 7)}  ` +
            style.yellow(`${plural(table.gaps, 'thing')} not understood`)
          : columns)
    );
  }
  out.push('');
  out.push(style.dim('  drzl explain <table>  for one of them in full'));
  return out.join('\n');
}

/* ------------------------------------------------------------------------------------------ */
/* The two ways a name fails                                                                   */
/* ------------------------------------------------------------------------------------------ */

/** No such table (DRZL_EXPLAIN_001), or the name reaches more than one (DRZL_EXPLAIN_002). */
export const NO_SUCH_TABLE_CODE = 'DRZL_EXPLAIN_001';
export const AMBIGUOUS_TABLE_CODE = 'DRZL_EXPLAIN_002';

/** How many table names a failure message lists before it stops. */
const NAME_CAP = 12;

/**
 * "There is no such table", with the tables there are.
 *
 * The list is the point. A reader who mistypes a name, or who is looking at the wrong schema file
 * entirely, learns which from the same line, and the two are not otherwise distinguishable: an
 * empty output and a wrong output look the same from outside.
 */
export function noSuchTableProblem(
  query: string,
  tables: readonly Table[],
  suggestion: string | undefined
): { code: string; message: string; hint: string } {
  const names = tables.map((t) => displayTableName(t));
  const shown = names.slice(0, NAME_CAP).join(', ');
  const rest = names.length > NAME_CAP ? `, and ${names.length - NAME_CAP} more` : '';
  return {
    code: NO_SUCH_TABLE_CODE,
    message:
      `No table called "${query}" (${NO_SUCH_TABLE_CODE}). ` +
      (names.length
        ? `This schema declares ${names.length} table${names.length === 1 ? '' : 's'}: ${shown}${rest}.`
        : 'This schema declares no tables.'),
    hint: suggestion
      ? `Did you mean "${suggestion}"?`
      : 'A table is matched by its database name, by its schema-qualified name, or by the name it ' +
        'is exported under, ignoring case where nothing matches exactly.',
  };
}

/**
 * "That name reaches more than one table", with both of them and the spelling that separates them.
 *
 * Reachable from an ordinary schema, and silently picking one would answer a question about one
 * table with facts about another.
 */
export function ambiguousTableProblem(
  query: string,
  hits: readonly TableHit[]
): { code: string; message: string; hint: string } {
  const named = hits
    .map((hit) => `${addressableName(hit.table)} (exported as ${hit.table.tsName})`)
    .join(', ');
  return {
    code: AMBIGUOUS_TABLE_CODE,
    message: `"${query}" names ${hits.length} tables (${AMBIGUOUS_TABLE_CODE}): ${named}.`,
    hint: `Name one of them exactly, for example "${addressableName(hits[0].table)}".`,
  };
}
