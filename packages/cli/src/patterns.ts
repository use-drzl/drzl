/**
 * The one name-matching language every filter in a DRZL config speaks.
 *
 * Anchored, with `*` as the only metacharacter. Anchored is the whole point: `user` must not also
 * match `users`, and a substring match would, which for the table filter means silently dropping
 * the application's main entity while trying to drop an auth table.
 *
 * Shared rather than reimplemented. `include`/`exclude` and the per-table `columns` filter both
 * take patterns, and a reader who has learned one has learned the other only while there is one
 * implementation of "learned". Two copies of an anchored glob agree on the easy cases and drift on
 * exactly the corners that made this explicit in the first place.
 */
export function patternToRegExp(pattern: string): RegExp {
  return new RegExp(
    '^' +
      pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$'
  );
}

/** Whether any of `patterns` matches `name` outright. */
export function matchesAny(patterns: string[], name: string): boolean {
  return patterns.some((p) => patternToRegExp(p).test(name));
}

/** The least a filter needs to know about a table. */
export interface NamedTable {
  name: string;
  schema?: string;
}

/** How the default SQL schema is spelled in a config, since a table in it carries no name for it. */
export const DEFAULT_SCHEMA_ALIAS = 'public';

/**
 * Every name a table answers to in a config pattern.
 *
 * A table states one name and lives in one schema, and Postgres lets two schemas hold the same
 * name, so `users` alone stopped identifying a table the moment `pgSchema` entered the picture.
 * Each table therefore answers to two:
 *
 *  - its bare database name, unchanged and listed first, so every pattern that matched before
 *    matches now. That is not a compatibility gesture: `exclude: ['users']` written before a
 *    `reporting` schema existed means "the users tables", and quietly narrowing it to one of them
 *    would start generating an endpoint the config had already turned off.
 *  - its qualified name, `reporting.users`, which is what addresses exactly one of them.
 *
 * A table with no schema answers to `public.users` rather than to a bare-schema form, because
 * Drizzle refuses `pgSchema('public')` outright: there is no other way to write a table in the
 * default schema, so there is no other name for it to have. That makes `public.` an alias this
 * file defines rather than something read back off the analysis, which is why it is only ever
 * offered to a table that names no schema.
 *
 * Order is the order they are tried, and the bare name being first is what keeps a table whose own
 * name contains a dot reachable by a pattern that spells it.
 */
export function tableAliases(table: NamedTable): string[] {
  return [table.name, `${table.schema ?? DEFAULT_SCHEMA_ALIAS}.${table.name}`];
}

/** Whether any of `patterns` matches the table under any of the names it answers to. */
export function matchesTable(patterns: string[], table: NamedTable): boolean {
  return tableAliases(table).some((alias) => matchesAny(patterns, alias));
}

/**
 * How a message names one table.
 *
 * Qualified only where the table names a schema, so every message in a project that uses none is
 * word for word what it was, and a project that uses several never has two of them reading alike.
 */
export function displayTableName(table: NamedTable): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

/**
 * The spelling that addresses exactly this table and no other, `public.users` included.
 *
 * For a message whose job is to hand the reader something to paste into a config. Elsewhere
 * `displayTableName` is the one to use: spelling `public.` at someone who has only ever had one
 * schema names a concept their schema file does not contain.
 */
export function addressableName(table: NamedTable): string {
  return `${table.schema ?? DEFAULT_SCHEMA_ALIAS}.${table.name}`;
}

/** Whether an analysis has any table outside the default schema at all. */
export function hasNamedSchemas(tables: readonly NamedTable[]): boolean {
  return tables.some((t) => t.schema);
}

/**
 * Patterns that reach more than one SQL schema, which is nearly always a pattern written before
 * the second schema existed.
 *
 * Reported rather than refused. Matching every schema is what an unqualified pattern has always
 * done and is the reading that keeps an existing `exclude` doing its job, so it cannot be an
 * error. It is still worth a sentence, because the two tables are different tables: `columns: {
 * users: { pick: ['id', 'email'] } }` narrows both, and the table that has no `email` silently
 * loses every column that is not `id`, while the typo check stays quiet because the pattern did
 * match a column somewhere.
 *
 * Silent on a schema that uses no `pgSchema`, which is the shape of nearly every one: with one
 * schema in play no pattern can span two.
 */
export function ambiguousPatternWarnings(
  patterns: string[],
  tables: readonly NamedTable[],
  option: string
): string[] {
  const out: string[] = [];
  for (const pattern of patterns) {
    // A pattern that already names a schema said which one it meant.
    if (pattern.includes('.')) continue;
    const matched = tables.filter((t) => matchesTable([pattern], t));
    const schemas = new Set(matched.map((t) => t.schema ?? DEFAULT_SCHEMA_ALIAS));
    if (schemas.size < 2) continue;
    out.push(
      `drzl config: ${option} pattern ${JSON.stringify(pattern)} matches tables in more than one ` +
        `schema, and every one of them is affected: ` +
        `${matched.map(addressableName).sort().join(', ')}. ` +
        `Write the schema to mean one of them, for example ${JSON.stringify(addressableName(matched[0]))}.`
    );
  }
  return out;
}
