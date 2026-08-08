/**
 * A failed parse, turned into a message under the right input.
 *
 * A zod issue says a value is wrong and never says **which constraint** said so. Zod's wording for
 * a broken `author_adult` never mentions `author_adult`, so without the ledger this file could
 * only render the library's sentence, could not tell that failure apart from the column's own
 * `int4` bound, and would have nothing at all to say about uniqueness.
 *
 * `constraintForIssue` closes that: it hands back the constraint an issue came from, and
 * `constraint.id` is the stable key this app writes its own wording against.
 */
import type { z } from 'zod';
import { constraintForIssue, constraintsByTable } from '../validators/zod';
import type { FieldErrors } from './form-state';

/**
 * This application's phrasing, keyed by constraint id.
 *
 * The id is the SQL constraint name where the declaration has one, and a derived name
 * (`authors_handle_maxlength`) where SQL leaves it anonymous. Anything not listed falls back to
 * the constraint's own `rule`, which is at least about the right rule.
 */
export const MESSAGES: Record<string, string> = {
  author_adult: 'Authors have to be 18 or older.',
  handle_len: 'A handle needs at least 3 characters.',
  authors_handle_maxlength: 'A handle is at most 20 characters.',
  authors_handle_key: 'That handle is taken.',
  status_valid: 'A post is either a draft or live.',
  posts_title_maxlength: 'A title is at most 80 characters.',
};

/** The wording for a constraint nothing has failed yet, which is how uniqueness is reported. */
export function messageForConstraint(table: string, id: string): string {
  const constraint = constraintsByTable[table]?.constraints.find((c) => c.id === id);
  return MESSAGES[id] ?? constraint?.rule ?? id;
}

interface Route {
  /** Which table's ledger to ask. */
  table: string;
  /** What the child's inputs are named, or `''` for a field on the parent. */
  prefix: string;
  /** The path with the relation key and index removed. */
  rest: readonly PropertyKey[];
}

/**
 * Which table an issue is about, and the input to hang the message on.
 *
 * `constraintForIssue` is told which table to look in by its caller and cannot work it out: an
 * issue from a nested relation schema belongs to the child, and asking the parent would answer
 * with whatever the parent happens to have under that column name. A nested payload puts children
 * under the relation key, which is the child table's Drizzle export name, so the head of the path
 * names the table whenever it is one of them.
 *
 * The prefix is this application's own naming for its own inputs, not something DRZL emits.
 */
function route(rootTable: string, path: readonly PropertyKey[]): Route {
  const [head, index, ...rest] = path;
  if (typeof head === 'string' && head !== rootTable && head in constraintsByTable) {
    return { table: head, prefix: `${head}[${String(index)}].`, rest };
  }
  return { table: rootTable, prefix: '', rest: path };
}

/**
 * Every issue in a failed parse, as messages keyed by form field.
 *
 * The column comes from `hit.column` in preference to the path's own last key, because the two
 * differ where it matters: a row-level CHECK is reported by valibot with an empty path, and the
 * column comes out of the ledger instead. Zod names a column for every case this example raises,
 * so the two agree here, and taking the ledger's answer is what keeps that true if one moves.
 */
export function fieldErrorsFor(
  rootTable: string,
  issues: readonly z.core.$ZodIssue[]
): FieldErrors {
  const errors: FieldErrors = {};

  for (const issue of issues) {
    const { table, prefix, rest } = route(rootTable, issue.path);
    const hit = constraintForIssue(table, issue);

    // No constraint caused it: the value failed to be the right type at all, or it broke the
    // column's own bound rather than a CHECK. Blaming the nearest constraint would be worse than
    // saying nothing, so the library's own sentence is used.
    const message = hit ? (MESSAGES[hit.constraint.id] ?? hit.constraint.rule) : issue.message;
    const column = hit?.column ?? String(rest.at(-1) ?? '');

    (errors[prefix + (column || 'form')] ??= []).push(message);
  }

  return errors;
}
