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
import { classifyTableChecks } from './constraints.js';

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
  /**
   * The SQL schema the table lives in, present only when it names one.
   *
   * Beside `table` rather than folded into it. `table` is the bare name in every emitted file
   * that exists, and two tables in two schemas publish the same one, so without this a consumer
   * reading the metadata of `reporting.users` cannot tell it from `public.users`. Absent for a
   * table in the default schema, which is what `pgTable` declares and the only thing it can
   * declare: Drizzle refuses `pgSchema('public')`.
   */
  schema?: string;
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

/**
 * Every CHECK on the table, split by where it lands.
 *
 * A reading of `classifyTableChecks`, which is shared with the constraint ledger rather than
 * repeated here. The two used to be one copy each of the same guards, and the failure that
 * matters is not that they would drift on a spelling: it is that "the database also checks this
 * and no schema does" would become two answers, and a caller reading one of them would have no
 * way to know which.
 */
function classifyChecks(table: Table) {
  const perColumn = new Map<string, string[]>();
  const rows: string[] = [];
  const unenforced: string[] = [];

  for (const check of classifyTableChecks(table)) {
    for (const part of check.parts) {
      if (part.place === 'none') {
        unenforced.push(part.text);
        continue;
      }
      if (part.place === 'row') {
        rows.push(part.text);
        continue;
      }
      const column = part.columns[0]!;
      const list = perColumn.get(column) ?? [];
      list.push(part.text);
      perColumn.set(column, list);
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
    ...(table.schema ? { schema: table.schema } : {}),
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
