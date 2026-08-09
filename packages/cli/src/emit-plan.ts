/**
 * What a generate run is about to put on disk, and how that differs from what is there (plan items
 * 68, 80, 81).
 *
 * The three items read as three features and are one mechanism. `--dry-run` is "compute this and
 * stop", `generate` reporting what changed is "compute this and write it", and `--check` is
 * "compute this, do not write it, and show the difference". All three need exactly one fact per
 * file: the content about to be written, beside the content already there. So that fact is
 * produced once, here, and the three commands differ only in what they do with it.
 *
 * ## The plan is the sink
 *
 * Generators hand their writes to a `FileSink` (see `emit.ts` in `@drzl/validation-core`). This
 * class is that sink. In `write` mode it records and then writes; in `plan` mode it records and
 * stops. Nothing else about a run changes between the two, which is what makes a dry run an honest
 * preview rather than a second implementation that can drift from the real one.
 *
 * ## Why `--check` no longer writes
 *
 * `--check` used to snapshot the output directories, let the generators overwrite them for real,
 * compare, and put the snapshot back. That works and was tested, but it means the one command
 * documented as never touching your tree is the command that rewrites every generated file on
 * every CI run, and a process killed between the write and the restore leaves the tree modified
 * with no record of it. On the plan it compares without writing at all, so there is no window.
 *
 * The snapshot is still taken, for a different job: see `verifyNothingWasWritten`.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FileSink } from '@drzl/validation-core';
import { diffSnapshots, restoreSnapshot, snapshotAll } from './drift.js';

/** What happened, or would happen, to one file. */
export type FileVerdict = 'created' | 'changed' | 'unchanged';

export interface EmittedFile {
  /** Absolute path, exactly as the generator spelled it. */
  file: string;
  verdict: FileVerdict;
  /** What is on disk now, or `null` when nothing is. */
  before: string | null;
  /** What the run produced for it. */
  after: string;
}

export interface EmitCounts {
  total: number;
  created: number;
  changed: number;
  unchanged: number;
}

export interface EmitPlanOptions {
  /**
   * Whether the recorded writes also reach the filesystem.
   *
   * `false` is `--dry-run` and `--check`. Nothing is written and no directory is created, which is
   * the whole claim those two flags make.
   */
  write: boolean;
  /**
   * Content already on disk, keyed by absolute path, when the caller has it.
   *
   * `--check` and `--dry-run` snapshot the output directories before the run anyway, so handing
   * that map over here saves reading every file a second time. A path missing from the map is
   * taken to be absent from disk, which is why this must only ever be a snapshot of directories
   * that cover everything the run can write. Omitted, each file is read as it is emitted, which is
   * what an ordinary `generate` does.
   */
  existing?: Map<string, string>;
}

export class EmitPlan implements FileSink {
  readonly writes: boolean;
  private readonly existing?: Map<string, string>;
  private readonly byFile = new Map<string, EmittedFile>();
  private readonly dirs = new Set<string>();

  constructor(options: EmitPlanOptions) {
    this.writes = options.write;
    this.existing = options.existing;
  }

  async mkdir(dir: string): Promise<void> {
    this.dirs.add(dir);
    if (this.writes) await fs.mkdir(dir, { recursive: true });
  }

  async writeFile(file: string, contents: string): Promise<void> {
    // The first recording of a path owns its `before`. Two generators pointed at one directory,
    // or one generator writing a file twice, would otherwise have the second write compare itself
    // against the first write's output and report `unchanged` for a file that really did change.
    const prior = this.byFile.get(file);
    const before = prior ? prior.before : await this.read(file);
    this.byFile.set(file, {
      file,
      before,
      after: contents,
      verdict: before === null ? 'created' : before === contents ? 'unchanged' : 'changed',
    });
    if (this.writes) await fs.writeFile(file, contents, 'utf8');
  }

  private async read(file: string): Promise<string | null> {
    if (this.existing) return this.existing.get(file) ?? null;
    try {
      return await fs.readFile(file, 'utf8');
    } catch {
      return null;
    }
  }

  /** Every directory a generator asked for, whether or not it was created. */
  get directories(): string[] {
    return [...this.dirs];
  }

  /** Every recorded file, in the order it was first written. */
  get files(): EmittedFile[] {
    return [...this.byFile.values()];
  }

  /**
   * The verdicts for a list of paths, in the order given.
   *
   * A path with no verdict is a path the generator reported writing without routing it through
   * the sink, which is the one shape a version mismatch takes: a `@drzl/cli` that knows about
   * `fileSink` beside a generator package that predates it. It is returned rather than thrown on
   * so the caller can name the generator; see `unrecorded`.
   */
  verdictsFor(paths: string[]): Array<EmittedFile | undefined> {
    return paths.map((p) => this.byFile.get(p));
  }

  /** The paths a generator claims to have written that never reached this sink. */
  unrecorded(paths: string[]): string[] {
    return paths.filter((p) => !this.byFile.has(p));
  }

  counts(paths?: string[]): EmitCounts {
    const entries = paths ? (this.verdictsFor(paths).filter(Boolean) as EmittedFile[]) : this.files;
    const counts: EmitCounts = { total: entries.length, created: 0, changed: 0, unchanged: 0 };
    for (const e of entries) counts[e.verdict]++;
    return counts;
  }
}

/** `3 created, 1 changed, 8 unchanged`, with the zeroes left out. */
export function describeCounts(counts: EmitCounts): string {
  const parts: string[] = [];
  if (counts.created) parts.push(`${counts.created} created`);
  if (counts.changed) parts.push(`${counts.changed} changed`);
  if (counts.unchanged) parts.push(`${counts.unchanged} unchanged`);
  return parts.join(', ') || 'nothing to write';
}

/** The files a plan would not leave alone. `--check` calls this drift; a dry run calls it the news. */
export function pendingChanges(plan: EmitPlan): EmittedFile[] {
  return plan.files
    .filter((f) => f.verdict !== 'unchanged')
    .sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * The `--check` drift statuses, kept exactly as they were published.
 *
 * `created` is reported as `added`, because that is the word the `--json` contract, the docs and
 * every CI job reading them have used since `--check` shipped. `removed` is still a value of the
 * published union and is still produced by `drift.ts`; the plan cannot produce one, since a plan
 * is a list of writes and a write never deletes. Reporting every file in an output directory that
 * the run did not emit would produce them, and was deliberately not done: `outDir` is whatever the
 * config says, a project that points it at `src` would have every hand-written module in the tree
 * reported as drift, and turning that into a failing CI job is not a change anyone asked for.
 */
export function driftStatusOf(verdict: FileVerdict): 'added' | 'changed' {
  return verdict === 'created' ? 'added' : 'changed';
}

/**
 * Prove that a plan-mode run really wrote nothing, and put the tree back if it did.
 *
 * This is a guard against one specific failure, and it is worth its cost because that failure is
 * silent and destructive. `fileSink` is an option, so a generator package that predates it accepts
 * it, ignores it, and writes to disk. Inside this repository that cannot happen, since everything
 * is built together; on a user's machine `@drzl/cli` and the generators are separate packages on
 * separate versions, and npm is free to install a new CLI beside an old generator.
 *
 * The comparison is the snapshot the run already took for its `before` content, against the same
 * directories afterwards. Anything that differs is restored, and the caller is told, because a
 * `--dry-run` that quietly rewrote the tree is the worst outcome this feature has.
 *
 * Returns the paths that were written, empty when the run behaved.
 */
export async function verifyNothingWasWritten(
  dirs: string[],
  before: Map<string, string>
): Promise<string[]> {
  const after = await snapshotAll(dirs);
  const drift = diffSnapshots(before, after);
  if (!drift.length) return [];
  await restoreSnapshot(before, after);
  return drift.map((d) => d.file).sort();
}

/** A path as a reader of the terminal wants to see it: relative to where they ran the command. */
export function displayPath(file: string, cwd = process.cwd()): string {
  const rel = path.relative(cwd, file);
  return rel && !rel.startsWith('..') ? rel : file;
}
