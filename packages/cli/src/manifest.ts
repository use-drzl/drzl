import path from 'node:path';
import { promises as fs } from 'node:fs';

/**
 * A record of what the last run wrote, so the next one can tell what it no longer owns.
 *
 * Without this there is no way to answer the question that matters after a table is deleted or
 * renamed: the generator writes the tables it finds and leaves everything else alone, so
 * `users.zod.ts` for a table that no longer exists sits there indefinitely. It compiles, it
 * exports a schema, and it describes a table the database does not have. Nothing reports it,
 * because nothing knows DRZL wrote it.
 *
 * The manifest is what makes deleting it safe, and that is the whole reason it exists rather than
 * globbing the output directory. An output directory is a place a consumer also keeps
 * hand-written files, barrels they edited, and the output of other tools; a generator that deleted
 * "everything that looks generated" would eventually delete something a person wrote. Deleting only
 * what a previous run recorded writing cannot.
 */

/** The current manifest format. Bumped only when a reader of an older one would be wrong. */
export const MANIFEST_VERSION = 1;

/** Where the manifest lives, relative to the project root. */
export const MANIFEST_PATH = path.join('.drzl', 'manifest.json');

export interface Manifest {
  version: number;
  /**
   * Every file the run wrote, relative to the project root, with `/` separators, sorted.
   *
   * Relative and sorted so the file is stable across machines and diffs cleanly when a table is
   * added. Deliberately no timestamp and no checksum: a timestamp would rewrite the file on every
   * run and put noise in every commit, and a checksum would answer a question `--check` already
   * answers better by comparing the content it just produced.
   */
  files: string[];
}

/** `a\\b` becomes `a/b`, so a manifest written on Windows reads the same everywhere. */
function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Absolute paths as the manifest stores them: relative to the root, posix, sorted, deduplicated. */
export function manifestEntries(files: readonly string[], root: string): string[] {
  const rel = files.map((f) => toPosix(path.relative(root, f)));
  return [...new Set(rel)].sort();
}

/**
 * Read the manifest, or `undefined` when there is not one to read.
 *
 * Every failure is `undefined` rather than a throw. A manifest that is missing, unreadable,
 * truncated by a crash, or written by a version that did not exist yet all mean the same thing to
 * a caller: there is no trustworthy record of the last run, so claim nothing. A generator that
 * refused to run because its own bookkeeping file was malformed would be a worse tool than one that
 * quietly rebuilds it.
 */
export async function readManifest(root: string): Promise<Manifest | undefined> {
  try {
    const raw = await fs.readFile(path.join(root, MANIFEST_PATH), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as Manifest).version !== MANIFEST_VERSION ||
      !Array.isArray((parsed as Manifest).files) ||
      !(parsed as Manifest).files.every((f) => typeof f === 'string')
    ) {
      return undefined;
    }
    return { version: MANIFEST_VERSION, files: (parsed as Manifest).files };
  } catch {
    return undefined;
  }
}

/** Write the manifest for the files this run produced. */
export async function writeManifest(root: string, files: readonly string[]): Promise<void> {
  const manifest: Manifest = { version: MANIFEST_VERSION, files: manifestEntries(files, root) };
  const target = path.join(root, MANIFEST_PATH);
  await fs.mkdir(path.dirname(target), { recursive: true });
  // A trailing newline, because this file lands in a repository and a missing one is the kind of
  // diff noise that shows up on somebody else's machine.
  await fs.writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export interface StaleFile {
  /** Relative to the project root, as the manifest records it. */
  file: string;
  /** Whether it is still on disk. One that is already gone is not worth reporting. */
  present: boolean;
}

/**
 * Files a previous run wrote that this one did not.
 *
 * The difference is taken against the *written* set rather than against what is on disk, so a file
 * this run deliberately left unchanged still counts as owned. `EmitPlan` records unchanged files
 * as written for exactly this reason: skipping the write is an optimisation, not a statement that
 * DRZL no longer owns the file.
 */
export async function staleFiles(
  previous: Manifest | undefined,
  writtenNow: readonly string[],
  root: string
): Promise<StaleFile[]> {
  if (!previous) return [];
  const current = new Set(manifestEntries(writtenNow, root));
  const gone = previous.files.filter((f) => !current.has(f));

  const out: StaleFile[] = [];
  for (const file of gone) {
    let present = true;
    try {
      await fs.access(path.join(root, file));
    } catch {
      present = false;
    }
    out.push({ file, present });
  }
  // Only the ones still on disk are worth a caller's attention; the rest are recorded so a caller
  // that wants the full difference can have it.
  return out;
}

/**
 * Delete the stale files, and nothing else.
 *
 * Only files the previous manifest recorded, and only those still on disk. A path that escapes the
 * project root is refused outright rather than resolved: a manifest is an ordinary file a person
 * can edit, and `../../etc/something` in it must not become a delete.
 */
export async function pruneStale(root: string, stale: readonly StaleFile[]): Promise<string[]> {
  const deleted: string[] = [];
  for (const entry of stale) {
    if (!entry.present) continue;
    const target = path.resolve(root, entry.file);
    const inside = target === root || target.startsWith(root + path.sep);
    if (!inside) continue;
    try {
      await fs.rm(target);
      deleted.push(entry.file);
    } catch {
      // A file that vanished between the check and the delete is the outcome asked for.
    }
  }
  return deleted;
}

/** What to tell the user about files the last run wrote and this one did not. */
export function staleWarning(stale: readonly StaleFile[]): string | undefined {
  const present = stale.filter((s) => s.present);
  if (!present.length) return undefined;
  const list = present.map((s) => s.file).join(', ');
  return (
    `drzl generate: ${present.length} file(s) written by a previous run were not written by this ` +
    `one, and are still on disk: ${list}. That usually means a table was renamed or removed. ` +
    `Delete them with \`drzl generate --prune\`, which removes only files a previous run recorded ` +
    `writing.`
  );
}

/**
 * What the next run should be told this one owns.
 *
 * Not simply the files this run wrote. A stale file that is still on disk has to stay in the record,
 * or DRZL forgets it owns it after exactly one run and it is orphaned for good: run one writes
 * `posts.zod.ts`, run two drops the table and records only what it wrote, and by run three there is
 * nothing left saying DRZL ever created that file. `--prune` could never remove it, and no warning
 * would mention it again.
 *
 * Found by running it rather than by reading it: the warning appeared on run two exactly as
 * intended, and `--prune` on run three deleted nothing at all.
 *
 * An entry already gone from disk drops out, which is what keeps the record from growing forever.
 */
export function nextManifestFiles(
  writtenNow: readonly string[],
  stale: readonly StaleFile[],
  root: string
): string[] {
  const kept = stale.filter((s) => s.present).map((s) => path.resolve(root, s.file));
  return manifestEntries([...writtenNow, ...kept], root);
}
