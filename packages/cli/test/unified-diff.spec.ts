/**
 * The diff `generate --check` prints (plan item 81).
 *
 * The assertion that matters here is not that the output looks like a diff. A diff that looks
 * right and is wrong is worse than no diff, because a reviewer acts on it: the whole point of
 * printing one is that somebody decides whether the change is theirs or the generator's. So every
 * case below is checked by *applying* the emitted patch to the "before" text and requiring the
 * result to equal the "after" text exactly. `applyUnified` is deliberately a naive reader of the
 * hunk headers rather than a second copy of the algorithm, so a bug in the diff cannot be
 * cancelled out by the same bug in the check.
 */
import { describe, it, expect } from 'vitest';
import { unifiedDiff, diffLines, DEFAULT_DIFF_LIMITS } from '../src/unified-diff';

/**
 * Apply a unified diff, reading the hunk headers and nothing else.
 *
 * Everything before the first hunk's start line is copied across, then each hunk is replayed:
 * a space or `-` line consumes one line of the original, a space or `+` line emits one. If the
 * headers are wrong, this desynchronises and the comparison fails, which is the point.
 */
function applyUnified(before: string, diff: string): string {
  const src = before === '' ? [] : before.replace(/\n$/, '').split('\n');
  const out: string[] = [];
  let cursor = 0;
  /** Whether the last line written to `out` was followed by the no-newline marker. */
  let lastLineHadNoNewline = false;

  const lines = diff.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].startsWith('@@')) i++;

  while (i < lines.length) {
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(lines[i]);
    if (!header) {
      i++;
      continue;
    }
    const aFrom = Number(header[1]);
    const aCount = Number(header[2]);
    const start = aCount === 0 ? aFrom : aFrom - 1;
    while (cursor < start) {
      out.push(src[cursor++]);
      lastLineHadNoNewline = false;
    }
    i++;
    for (; i < lines.length && !lines[i].startsWith('@@'); i++) {
      const line = lines[i];
      if (line === '') continue;
      if (line.startsWith('\\')) {
        // The marker describes the line just emitted, whichever side it came from. A `-` line
        // carrying it is describing the original, so it says nothing about the result.
        continue;
      }
      const nextIsMarker = lines[i + 1]?.startsWith('\\') ?? false;
      if (line.startsWith(' ')) {
        out.push(src[cursor++]);
        lastLineHadNoNewline = nextIsMarker;
      } else if (line.startsWith('-')) {
        cursor++;
      } else if (line.startsWith('+')) {
        out.push(line.slice(1));
        lastLineHadNoNewline = nextIsMarker;
      }
    }
  }
  while (cursor < src.length) {
    out.push(src[cursor++]);
    lastLineHadNoNewline = false;
  }
  if (!out.length) return '';
  return out.join('\n') + (lastLineHadNoNewline ? '' : '\n');
}

const label = { fromLabel: 'a/x.ts', toLabel: 'b/x.ts' };

describe('unifiedDiff', () => {
  it('says nothing about two identical texts', () => {
    expect(unifiedDiff('same\n', 'same\n', label)).toBe('');
  });

  it('names both sides in the header, so the file is identifiable in a log', () => {
    const d = unifiedDiff('a\n', 'b\n', {
      fromLabel: 'a/zod/users.zod.ts',
      toLabel: 'b/zod/users.zod.ts',
    });
    expect(d).toContain('--- a/zod/users.zod.ts');
    expect(d).toContain('+++ b/zod/users.zod.ts');
  });

  it('shows the changed line, and only the changed line, as - then +', () => {
    const before = 'one\ntwo\nthree\n';
    const after = 'one\nTWO\nthree\n';
    const d = unifiedDiff(before, after, label);
    expect(d).toContain('-two');
    expect(d).toContain('+TWO');
    expect(d).not.toContain('-one');
    expect(d).not.toContain('+three');
    expect(applyUnified(before, d)).toBe(after);
  });

  const cases: Array<[string, string, string]> = [
    ['an inserted line', 'a\nb\n', 'a\nx\nb\n'],
    ['a deleted line', 'a\nx\nb\n', 'a\nb\n'],
    ['a replaced line', 'a\nx\nb\n', 'a\ny\nb\n'],
    ['a file created from nothing', '', 'a\nb\n'],
    ['a file emptied', 'a\nb\n', ''],
    ['a change at the very start', 'a\nb\nc\n', 'z\nb\nc\n'],
    ['a change at the very end', 'a\nb\nc\n', 'a\nb\nz\n'],
    [
      'two changes far apart, which must be two hunks',
      tenLines('x'),
      tenLines('x', { 0: 'first', 9: 'last' }),
    ],
    [
      'two changes close together, which must merge into one hunk',
      'a\nb\nc\nd\ne\n',
      'a\nB\nc\nD\ne\n',
    ],
    ['no trailing newline on the right', 'a\nb\n', 'a\nb'],
    ['no trailing newline on the left', 'a\nb', 'a\nb\n'],
    ['a wholly different file', 'a\nb\nc\n', 'x\ny\nz\n'],
    ['a repeated line, where a naive matcher picks the wrong one', 'x\nx\nx\n', 'x\nx\nx\nx\n'],
  ];

  for (const [name, before, after] of cases) {
    it(`round-trips ${name}`, () => {
      const d = unifiedDiff(before, after, label);
      expect(d).not.toBe('');
      expect(applyUnified(before, d)).toBe(after);
    });
  }

  it('round-trips a generated-file-sized change', () => {
    // The shape this is actually asked about: a long file with one field edited in the middle.
    const before =
      Array.from({ length: 800 }, (_, i) => `  field${i}: z.string(),`).join('\n') + '\n';
    const after = before.replace('  field400: z.string(),', '  field400: z.string().max(50),');
    const d = unifiedDiff(before, after, label);
    expect(applyUnified(before, d)).toBe(after);
    // Three lines of context each side, so a one-line change is a seven-line hunk and not 800.
    expect(d.split('\n').length).toBeLessThan(15);
  });

  it('produces two hunks rather than one enormous one', () => {
    const before = tenLines('x');
    const after = tenLines('x', { 0: 'first', 9: 'last' });
    const d = unifiedDiff(before, after, label);
    expect(d.split('@@ ').length - 1).toBe(2);
  });

  it('marks a missing final newline the way diff does', () => {
    const d = unifiedDiff('a\nb\n', 'a\nb', label);
    expect(d).toContain('\\ No newline at end of file');
  });
});

describe('the caps, which must be stated rather than silently applied', () => {
  it('refuses a file longer than the line cap, and says how long it was', () => {
    const big = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const bigger = big.replace('line 3', 'line THREE');
    const d = unifiedDiff(big, bigger, { ...label, limits: { maxLines: 5 } });
    expect(d).toContain('no line diff');
    expect(d).toContain('20 lines on disk');
    expect(d).toContain('5-line cap');
    // The header is still there, so the file is still identifiable.
    expect(d).toContain('--- a/x.ts');
  });

  it('refuses a pair that differ by more than the edit cap, and says so', () => {
    const before = Array.from({ length: 60 }, (_, i) => `a${i}`).join('\n') + '\n';
    const after = Array.from({ length: 60 }, (_, i) => `b${i}`).join('\n') + '\n';
    const d = unifiedDiff(before, after, { ...label, limits: { maxEdits: 4 } });
    expect(d).toContain('no line diff');
    expect(d).toContain('4-edit cap');
  });

  it('has caps at all by default', () => {
    expect(DEFAULT_DIFF_LIMITS.maxLines).toBeGreaterThan(0);
    expect(DEFAULT_DIFF_LIMITS.maxEdits).toBeGreaterThan(0);
    expect(DEFAULT_DIFF_LIMITS.context).toBe(3);
  });
});

describe('diffLines', () => {
  it('returns null rather than grinding when the edit distance exceeds the cap', () => {
    const a = Array.from({ length: 200 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 200 }, (_, i) => `b${i}`);
    expect(diffLines(a, b, 10)).toBeNull();
  });

  it('finds the minimal edit script, not merely a correct one', () => {
    // One insertion, so one non-equal operation. An implementation that rewrote the tail would
    // return four, apply cleanly, and print a diff nobody can read.
    const ops = diffLines(['a', 'b', 'c'], ['a', 'x', 'b', 'c'], 100);
    expect(ops).not.toBeNull();
    expect(ops!.filter((o) => o.kind !== 'equal')).toHaveLength(1);
  });

  it('costs a bounded number of edits for a one-line change in a long file', () => {
    const a = Array.from({ length: 5000 }, (_, i) => `l${i}`);
    const b = [...a];
    b[2500] = 'changed';
    // The prefix and suffix trim is what makes this finish: without it Myers would search a
    // 5000-line space. With it there are two lines to compare.
    const ops = diffLines(a, b, 4);
    expect(ops).not.toBeNull();
    expect(ops!.filter((o) => o.kind !== 'equal')).toHaveLength(2);
  });
});

/** Ten numbered lines, with the given indices replaced. */
function tenLines(prefix: string, overrides: Record<number, string> = {}): string {
  return Array.from({ length: 10 }, (_, i) => overrides[i] ?? `${prefix}${i}`).join('\n') + '\n';
}
