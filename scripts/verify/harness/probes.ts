/**
 * The probe pools, in one place, because more than one stage asks the database about them.
 *
 * The zod ground-truth and CHECK stages owned these inline until the JSON Schema stage arrived
 * asking the same questions of the same columns, and a second copy of a pool is a pool that
 * drifts. The emoji probes are the example that matters: they exist because a code-point count and
 * a UTF-16 `.length` disagree, and a copy that quietly lost them would stay green having stopped
 * measuring the one thing the pool was built for.
 */

/**
 * Values pushed at every column of the `matrix` table.
 *
 * Astral-plane characters are load-bearing: Postgres counts *characters* for `varchar(n)`, so a
 * 3-emoji string fits in a `varchar(5)` that every library's `.max(5)` refuses. Without these in
 * the pool no stage can see that.
 */
export const MATRIX_POOL: [string, unknown][] = [
  ['0', 0], ['1.5', 1.5], ['-1', -1], ['40000', 40000], ['2147483648', 2147483648],
  ['1e9', 1e9], ['1e300', 1e300], ['9007199254740993', 9007199254740993],
  // A `real` at full magnitude, as the text protocol returns it. Postgres accepts it and stores
  // the largest float32; a schema bounded at that float32 refuses it, which is a schema refusing
  // its own column's rows. Nothing else here is within 30 orders of magnitude of that edge, so
  // this stage asked 1400 questions and none of them was about it.
  ['3.4028235e38', 3.4028235e38],
  ['NaN', NaN], ['Infinity', Infinity],
  ["''", ''], ["'hello'", 'hello'], ['300-char', 'x'.repeat(300)],
  ['3 emoji', '\u{1F44D}\u{1F44D}\u{1F44D}'],
  ['5 emoji', '\u{1F44D}\u{1F44D}\u{1F44D}\u{1F44D}\u{1F44D}'],
  ["'0101'", '0101'], ["'010'", '010'], ["'12.5'", '12.5'], ["'1_000'", '1_000'], ["'0x1f'", '0x1f'],
  ['uuid', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'], ["'not-a-uuid'", 'not-a-uuid'],
  ["'happy'", 'happy'], ["'zzz'", 'zzz'],
  ['true', true], ['Date', new Date('2020-01-01T00:00:00Z')],
  ["'2020-01-01'", '2020-01-01'], ["'12:00:00'", '12:00:00'],
  ["['a']", ['a']], ['[1,2]', [1, 2]], ['[1,2,3]', [1, 2, 3]],
  ['{a:1}', { a: 1 }], ['Uint8Array', new Uint8Array([1, 2])],
  ["'10.0.0.1'", '10.0.0.1'], ["'999.999.999.999'", '999.999.999.999'],
];

/**
 * Values chosen to sit on both sides of every bound in the `checked` table, since a probe pool
 * that never lands on a boundary cannot tell `>` from `>=`. That distinction is most of what a
 * CHECK says.
 */
export const CHECK_PROBES: Record<string, unknown[]> = {
  k_min: [17, 18, 19, 0, -1],
  k_max: [99, 100, 101, 0],
  k_lo: [0, 1, 2, -1],
  k_hi: [8, 9, 10, 11],
  k_between: [4, 5, 10, 15, 16],
  k_eq: [6, 7, 8],
  k_in_s: ['a', 'c', 'd', '', 'A'],
  k_in_n: [1, 3, 4, 0],
  k_len: ['ab', 'abc', 'abcd', '', '\u{1F44D}\u{1F44D}\u{1F44D}'],
  k_len_max: ['abcde', 'abcdef', '', '\u{1F44D}\u{1F44D}\u{1F44D}\u{1F44D}\u{1F44D}'],
  k_card: [[], ['a'], ['a', 'b'], ['a', 'b', 'c']],
  // The inequality form, which nothing here probed until two generators were caught dropping it
  // silently. `<>` is the one comparison whose absence looks exactly like a column with no CHECK,
  // so a fixture without it cannot tell an enforcing generator from an ignoring one.
  k_ne_s: ['ok', 'banned', ''],
  k_ne_n: [6, 7, 8],
  // One side of a row-level comparison, with the other NULL. SQL leaves the CHECK satisfied, so
  // an emitted schema that rejects here would turn away rows the database takes.
  k_pair_a: [1, 100, -1],
  k_pair_b: [1, 100, -1],
};

/**
 * Both sides of the row-level check at once, which is the only way to reach it.
 *
 * Every probe above sets one column, and `CHECK (k_pair_a < k_pair_b)` is satisfied whenever
 * either side is NULL, so nothing above can tell a generator that enforces the comparison from one
 * that ignores it.
 *
 * The zod generator's own unit tests do catch a deleted row refinement, by reading the emitted
 * source. No packed or database-backed stage could: deleting all three row refinements and running
 * the pre-existing checks-truth stage against the result exits 0. So what these probes add is the
 * behavioural half, measured against Postgres rather than against a string.
 */
export const ROW_PAIR_PROBES: { row: Record<string, unknown>; satisfied: boolean }[] = [
  { row: { k_pair_a: 1, k_pair_b: 5 }, satisfied: true },
  { row: { k_pair_a: 5, k_pair_b: 1 }, satisfied: false },
  // Equal, because `<` and `<=` are one character apart and only this pair separates them.
  { row: { k_pair_a: 1, k_pair_b: 1 }, satisfied: false },
];
