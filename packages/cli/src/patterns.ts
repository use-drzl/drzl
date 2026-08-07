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
