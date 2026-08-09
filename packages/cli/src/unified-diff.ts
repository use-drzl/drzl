/**
 * A unified diff of two texts, written here rather than installed (plan item 81).
 *
 * `generate --check` named the files that had drifted and stopped there, which tells a reviewer
 * that something is stale and nothing about what. The diff is the part that turns a red CI job
 * into a decision: a regenerated header, a column that gained a length cap, and a hand-edit
 * somebody made to a generated file all read identically as "changed".
 *
 * ## Why not a dependency
 *
 * `diff` (jsdiff) is the obvious choice and is already resolvable in this workspace, but only as a
 * transitive dependency of `ts-node`, which is a devDependency of the CLI package. Relying on that
 * would be relying on a hoist. Adding it as a real dependency of `@drzl/cli` costs a package on
 * every install of a CLI whose whole job is to write files, in exchange for about a hundred lines
 * of a published algorithm, and this repository publishes through npm's trusted-publisher OIDC
 * flow where every new dependency is another thing to keep resolvable. So it is here, with the
 * property test that matters: applying the emitted diff to the "before" text has to reproduce the
 * "after" text exactly, which is the only check that can tell a plausible-looking diff from a
 * correct one.
 *
 * ## Format
 *
 * Unified, because it is the format `git`, `patch`, review tools and every developer already read,
 * and because it greps: a line beginning `+` or `-` is a change, and the `@@` header names where.
 * The alternative worth considering was a side-by-side or a word-level diff, which reads better
 * for prose and worse for generated code, where the interesting change is usually one whole line.
 *
 * ## Caps
 *
 * Myers is O((N+M)D): fast when the two texts are close, which is the case that matters, and
 * quadratic when they are not. Both bounds below are stated in the output when they bite, because
 * a diff that silently stops is worse than no diff: a reviewer who cannot see the truncation reads
 * the visible hunks as the whole story.
 */

/** The two bounds, and the context width. */
export interface DiffLimits {
  /** Longest file, in lines, this will diff line by line. */
  maxLines: number;
  /** Largest edit script, in inserted plus deleted lines, before it gives up. */
  maxEdits: number;
  /** Unchanged lines kept around each hunk. Three is what `diff -u` and `git` use. */
  context: number;
}

export const DEFAULT_DIFF_LIMITS: DiffLimits = {
  maxLines: 4000,
  maxEdits: 1500,
  context: 3,
};

type Op = { kind: 'equal' | 'insert' | 'delete'; a: number; b: number };

/**
 * Split into lines, keeping the fact of a trailing newline separate.
 *
 * `'a\nb\n'.split('\n')` is `['a', 'b', '']`, and that empty string is not a line; carrying it
 * would put a spurious empty line at the end of every hunk that reaches the end of a file. So it
 * is dropped and remembered, which is also what produces the `\ No newline at end of file` marker
 * when only one side has it.
 */
function toLines(text: string): { lines: string[]; newlineAtEnd: boolean } {
  if (text === '') return { lines: [], newlineAtEnd: true };
  const newlineAtEnd = text.endsWith('\n');
  const lines = text.split('\n');
  if (newlineAtEnd) lines.pop();
  return { lines, newlineAtEnd };
}

/**
 * Myers' shortest edit script, capped.
 *
 * The published greedy algorithm: for each edit distance `d`, walk the diagonals reachable with
 * `d` edits and take the furthest point on each. `trace` keeps the frontier per `d` so the path
 * can be walked back afterwards, which is what turns "the distance is 4" into "these four lines".
 *
 * Returns `null` when the distance exceeds `maxEdits`, which the caller reports rather than hides.
 */
function shortestEdit(a: string[], b: string[], maxEdits: number): Int32Array[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];
  const limit = Math.min(max, maxEdits);

  for (let d = 0; d <= limit; d++) {
    trace.push(Int32Array.prototype.slice.call(v));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) x = v[k + 1 + offset];
      else x = v[k - 1 + offset] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) return trace;
    }
  }
  return null;
}

/** Walk the frontier back from the end, producing the operations in order. */
function backtrack(trace: Int32Array[], a: string[], b: string[]): Op[] {
  const max = a.length + b.length;
  const offset = max;
  let x = a.length;
  let y = b.length;
  const ops: Op[] = [];

  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = v[prevK + offset];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ kind: 'equal', a: x, b: y });
    }
    if (d > 0) {
      if (x === prevX) {
        y--;
        ops.push({ kind: 'insert', a: x, b: y });
      } else {
        x--;
        ops.push({ kind: 'delete', a: x, b: y });
      }
    }
  }
  ops.reverse();
  return ops;
}

/**
 * The operations turning `a` into `b`, or `null` when a cap was hit.
 *
 * Common leading and trailing lines are stripped before Myers runs and put back as `equal`
 * afterwards. That is not an optimisation for its own sake: the pair this is asked about is
 * almost always a generated file against the same file with one table changed, where the shared
 * head and tail are the whole file bar a few lines, and stripping them takes the edit distance
 * that Myers has to search from thousands to single figures.
 */
export function diffLines(a: string[], b: string[], maxEdits: number): Op[] | null {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  // Nothing left to compare once the shared head and tail are gone. Myers is skipped rather than
  // handed two empty arrays, where its `v` array is a single element and every neighbour lookup
  // reads past the end.
  let mid: Op[] = [];
  if (midA.length || midB.length) {
    const trace = shortestEdit(midA, midB, maxEdits);
    if (!trace) return null;
    mid = backtrack(trace, midA, midB);
  }

  const ops: Op[] = [];
  for (let i = 0; i < head; i++) ops.push({ kind: 'equal', a: i, b: i });
  for (const op of mid) ops.push({ kind: op.kind, a: op.a + head, b: op.b + head });
  for (let i = 0; i < tail; i++) {
    ops.push({ kind: 'equal', a: a.length - tail + i, b: b.length - tail + i });
  }
  return ops;
}

export interface UnifiedDiffOptions {
  /** What the left side is called in the `---` header. */
  fromLabel: string;
  /** What the right side is called in the `+++` header. */
  toLabel: string;
  limits?: Partial<DiffLimits>;
}

/**
 * A unified diff, or a single line saying why there is not one.
 *
 * Returns the empty string when the two texts are identical, so a caller can treat "no diff" and
 * "nothing to say" the same way.
 */
export function unifiedDiff(before: string, after: string, opts: UnifiedDiffOptions): string {
  if (before === after) return '';
  const limits: DiffLimits = { ...DEFAULT_DIFF_LIMITS, ...(opts.limits ?? {}) };

  const from = toLines(before);
  const to = toLines(after);
  // A file that lost or gained only its final newline still differs, and every line of it still
  // compares equal, so without this the diff would be empty for a file the check has just called
  // out of date. Marking the last line of a side that has no trailing newline makes it a real
  // difference to Myers, and the marker is what `diff` itself prints for the same case.
  const beforeLines = withNoNewlineMark(from);
  const afterLines = withNoNewlineMark(to);

  if (from.lines.length > limits.maxLines || to.lines.length > limits.maxLines) {
    return (
      `--- ${opts.fromLabel}\n+++ ${opts.toLabel}\n` +
      `@@ no line diff @@\n` +
      `  ${from.lines.length} lines on disk, ${to.lines.length} lines regenerated. ` +
      `Not diffed: the file is longer than the ${limits.maxLines}-line cap.\n`
    );
  }

  const ops = diffLines(beforeLines, afterLines, limits.maxEdits);
  if (!ops) {
    return (
      `--- ${opts.fromLabel}\n+++ ${opts.toLabel}\n` +
      `@@ no line diff @@\n` +
      `  ${from.lines.length} lines on disk, ${to.lines.length} lines regenerated. ` +
      `Not diffed: the two differ by more than the ${limits.maxEdits}-edit cap, ` +
      `so the whole file is effectively new.\n`
    );
  }

  const hunks = buildHunks(ops, beforeLines, afterLines, limits.context);
  if (!hunks.length) return '';
  return `--- ${opts.fromLabel}\n+++ ${opts.toLabel}\n${hunks.join('')}`;
}

const NO_NEWLINE = '\\ No newline at end of file';

/**
 * The sentinel a line with no newline after it carries while it is being compared.
 *
 * Two NUL characters and a word, because it has to be something a line of generated TypeScript
 * cannot be. It never reaches the output: `renderLine` strips it and prints the marker instead.
 */
const NO_NEWLINE_MARK = '\u0000\u0000drzl:no-newline';

function withNoNewlineMark(side: { lines: string[]; newlineAtEnd: boolean }): string[] {
  if (side.newlineAtEnd || !side.lines.length) return side.lines;
  const marked = side.lines.slice();
  marked[marked.length - 1] += NO_NEWLINE_MARK;
  return marked;
}

/** One diff line: its prefix, its text, and the marker underneath it when it had no newline. */
function renderLine(prefix: string, line: string, into: string[]): void {
  if (line.endsWith(NO_NEWLINE_MARK)) {
    into.push(prefix + line.slice(0, -NO_NEWLINE_MARK.length));
    into.push(NO_NEWLINE);
    return;
  }
  into.push(prefix + line);
}

/** Group the operations into hunks with `context` unchanged lines around each run of changes. */
function buildHunks(
  ops: Op[],
  beforeLines: string[],
  afterLines: string[],
  context: number
): string[] {
  const changed: number[] = [];
  ops.forEach((op, i) => {
    if (op.kind !== 'equal') changed.push(i);
  });
  if (!changed.length) return [];

  /** Ranges of operation indices to print, merged where their context windows touch. */
  const ranges: Array<[number, number]> = [];
  for (const i of changed) {
    const start = Math.max(0, i - context);
    const end = Math.min(ops.length - 1, i + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }

  const hunks: string[] = [];
  for (const [start, end] of ranges) {
    let aStart = -1;
    let bStart = -1;
    let aCount = 0;
    let bCount = 0;
    const body: string[] = [];

    for (let i = start; i <= end; i++) {
      const op = ops[i];
      if (op.kind === 'equal' || op.kind === 'delete') {
        if (aStart < 0) aStart = op.a;
        aCount++;
      }
      if (op.kind === 'equal' || op.kind === 'insert') {
        if (bStart < 0) bStart = op.b;
        bCount++;
      }
      if (op.kind === 'equal') renderLine(' ', beforeLines[op.a], body);
      else if (op.kind === 'delete') renderLine('-', beforeLines[op.a], body);
      else renderLine('+', afterLines[op.b], body);
    }

    // A hunk covering nothing on one side is numbered from 0, which is what `diff -u` emits for a
    // pure insertion into an empty file.
    const aFrom = aCount === 0 ? 0 : aStart + 1;
    const bFrom = bCount === 0 ? 0 : bStart + 1;
    hunks.push(`@@ -${aFrom},${aCount} +${bFrom},${bCount} @@\n${body.join('\n')}\n`);
  }
  return hunks;
}
