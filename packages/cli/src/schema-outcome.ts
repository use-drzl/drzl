/**
 * Whether a run has anything to generate from, and which of the three reasons it has not.
 *
 * Items 70 and 71 are one moment for the user ("I ran generate and got nothing useful") and three
 * different causes, and the fixes have nothing in common: fix your import, export your tables,
 * loosen your filter. Measured on the built 4.22.0 CLI, every one of them printed a green tick and
 * exited 0, having written a barrel with no exports in it:
 *
 * | input                                            | exit | wrote          |
 * | ------------------------------------------------ | ---- | -------------- |
 * | a schema module that throws on import            | 0    | `out/index.ts` |
 * | a schema importing a package that is not there   | 0    | `out/index.ts` |
 * | a schema with a syntax error                     | 0    | `out/index.ts` |
 * | `schema:` naming a file that does not exist      | 0    | `out/index.ts` |
 * | a module that exports no tables                  | 0    | `out/index.ts` |
 * | a module that exports things that are not tables | 0    | `out/index.ts` |
 * | every table removed by `include`/`exclude`       | 0    | `out/index.ts` |
 *
 * The distinction is not guessed at here. The analyzer already separates the three answers, which
 * is what `init` was built on in item 67 and what this reuses:
 *
 *   - a module it could not run  -> `DRZL_ANL_NOFILE` or `DRZL_ANL_IMPORT`, an error-level issue
 *   - a module that is not one   -> no issues, and `tables` empty
 *   - a real schema              -> `tables` non-empty
 *
 * Surfacing that rather than re-deriving it is what keeps the two messages honest: the first says
 * DRZL never read your file and repeats the reason, the second says DRZL read it and it declares
 * nothing.
 */

/** DRZL could not read the schema at all: the file is missing, or importing it threw. */
export const SCHEMA_UNREADABLE_CODE = 'DRZL_SCHEMA_001';
/** DRZL read the schema, and it declares no Drizzle tables. */
export const SCHEMA_EMPTY_CODE = 'DRZL_SCHEMA_002';
/** The schema declares tables and the config's own filters removed all of them. */
export const SCHEMA_FILTERED_CODE = 'DRZL_SCHEMA_003';

export interface SchemaProblem {
  /** The stable identifier, which is also what the `--json` failure document carries. */
  code: string;
  /** The failure itself. Printed in red, never suppressed, and named in the document. */
  message: string;
  /** How to fix it. Printed dim under the message, and dropped by `--quiet` like every hint. */
  hint: string;
}

/**
 * The clause that closes a hint by saying what did not happen because of this.
 *
 * A parameter rather than a constant, because these three problems are not `generate`'s alone any
 * more: `drzl explain` reaches every one of them and has never written a file in its life, so
 * "Nothing was generated." there is a sentence about a thing the command does not do. The default
 * keeps every existing caller's text byte for byte.
 */
export const NOTHING_GENERATED = 'Nothing was generated.';

/** The least this file needs to know about an analyzer issue. */
export interface AnalyzerIssue {
  code?: string;
  level?: string;
  message?: string;
}

/** The two analyzer codes that mean "there is nothing to work with", as opposed to a description. */
const UNREADABLE_CODES = new Set(['DRZL_ANL_NOFILE', 'DRZL_ANL_IMPORT']);

/** The first line of a message. A module resolution failure carries its whole require stack. */
function firstLine(message: string): string {
  return String(message).split('\n')[0].trim();
}

/** What to call the schema in a sentence: the path as the config spells it, or the file count. */
export function describeSchemaTarget(schema: string | readonly string[]): string {
  if (typeof schema === 'string') return schema;
  if (schema.length === 1) return schema[0];
  return `${schema.length} schema files`;
}

/**
 * Item 70: the module never loaded, so nothing downstream means anything.
 *
 * The single-path message is built here rather than taken from the analyzer, because the
 * analyzer's is `Failed to import schema: <error>` and deliberately keeps those historical bytes,
 * which do not name the file. Naming the file is the point of the item: a user with four schema
 * modules and one bad import needs to be told which one, and the message that stops saying so is
 * the regression worth a test.
 */
export function schemaLoadFailure(
  issues: readonly AnalyzerIssue[],
  schema: string | readonly string[],
  consequence: string = NOTHING_GENERATED
): SchemaProblem | undefined {
  const blocking = issues.filter(
    (issue) => issue.level === 'error' && issue.code && UNREADABLE_CODES.has(issue.code)
  );
  if (!blocking.length) return undefined;

  const first = blocking[0];
  const more = blocking.length > 1 ? ` (and ${blocking.length - 1} more)` : '';
  const single = typeof schema === 'string' ? schema : schema.length === 1 ? schema[0] : undefined;

  if (first.code === 'DRZL_ANL_NOFILE') {
    const named = single ?? afterPrefix(first.message, 'Schema file not found:');
    return {
      code: SCHEMA_UNREADABLE_CODE,
      message: `Schema file not found (${SCHEMA_UNREADABLE_CODE}): ${named}${more}`,
      hint:
        'Check the "schema" path in your drzl config, or point --config at another one. ' +
        consequence,
    };
  }

  const reason = single
    ? firstLine(afterPrefix(first.message, 'Failed to import schema:'))
    : firstLine(String(first.message ?? ''));
  const message = single
    ? `Could not load the schema module ${single} (${SCHEMA_UNREADABLE_CODE}): ${reason}${more}`
    : `Could not load a schema module (${SCHEMA_UNREADABLE_CODE}): ${reason}${more}`;

  return {
    code: SCHEMA_UNREADABLE_CODE,
    message,
    hint: single
      ? `Fix that error and run again. \`drzl analyze ${single}\` prints it in full. ${consequence}`
      : `Fix that error and run again. ${consequence}`,
  };
}

/** A message with a known prefix taken off, or the message unchanged when it has none. */
function afterPrefix(message: string | undefined, prefix: string): string {
  const text = String(message ?? '');
  return text.startsWith(prefix) ? text.slice(prefix.length).trim() : text;
}

/**
 * Item 71: the module loaded and the run would emit nothing but a barrel.
 *
 * Two codes rather than one, because the schema declaring nothing and the config's filter removing
 * everything are different mistakes in different files. The filtered case names the tables that
 * were really there, which is the fact that turns "why is my output empty" into "my pattern is
 * wrong", and it is the only place the CLI can say it: the filter has already run by then.
 */
export function nothingToGenerate(opts: {
  schema: string | readonly string[];
  /** The tables the analyzer found, before `include`, `exclude` and `columns` were applied. */
  analyzed: readonly { name: string }[];
  /** The tables left for the generators. */
  remaining: readonly { name: string }[];
  /** What did not happen because of this. See `NOTHING_GENERATED`. */
  consequence?: string;
}): SchemaProblem | undefined {
  if (opts.remaining.length > 0) return undefined;
  const target = describeSchemaTarget(opts.schema);
  const consequence = opts.consequence ?? NOTHING_GENERATED;

  if (!opts.analyzed.length) {
    return {
      code: SCHEMA_EMPTY_CODE,
      message: `No Drizzle tables found in ${target} (${SCHEMA_EMPTY_CODE}).`,
      hint:
        'That module imported cleanly and exported no tables, so every generator would write an ' +
        'empty barrel. Export them from it, for example: export const users = pgTable(...). ' +
        consequence,
    };
  }

  const names = opts.analyzed.map((table) => table.name);
  const shown = names.slice(0, 6).join(', ');
  const rest = names.length > 6 ? `, and ${names.length - 6} more` : '';
  return {
    code: SCHEMA_FILTERED_CODE,
    message:
      `Every table was removed by this config's filters (${SCHEMA_FILTERED_CODE}). ` +
      `${target} declares ${names.length} table${names.length === 1 ? '' : 's'}: ${shown}${rest}.`,
    hint:
      'Check "include" and "exclude" in your drzl config. A pattern is matched against the whole ' +
      'database table name, with * as the only metacharacter. ' +
      consequence,
  };
}
