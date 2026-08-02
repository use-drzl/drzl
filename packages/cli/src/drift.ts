/**
 * Drift detection for generated output.
 *
 * No runtime validator can offer this. `drizzle-orm/zod` and friends derive schemas in memory at
 * import time, so there is nothing on disk to have drifted and nothing for CI to compare. It is
 * only available to a code generator, which makes it one of the few things DRZL can do that the
 * first-party modules structurally cannot.
 *
 * The check is: regenerate, and require the result to equal what is committed. That catches the
 * two failures that actually happen, someone editing generated files by hand and someone
 * changing the schema without regenerating, and it catches them in CI rather than in review.
 *
 * Content-neutral by construction. Redirecting output to a temporary directory would not work:
 * generated files contain paths computed relative to their own location, so a different output
 * directory produces legitimately different bytes and every file would report as drifted. So the
 * real directories are snapshotted first, regeneration is allowed to overwrite them, and the
 * snapshot is put back if anything changed. Either way the tree ends as it began.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface DriftEntry {
  file: string;
  status: 'changed' | 'added' | 'removed';
}

/** Every file under `dir`, keyed by its path relative to `dir`. Missing directory means empty. */
export async function snapshotDir(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(current: string) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return; // Nothing generated there yet, which a first run should report as additions.
    }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) await walk(full);
      else out.set(path.relative(dir, full), await fs.readFile(full, 'utf8'));
    }
  }
  await walk(dir);
  return out;
}

/** Snapshot several directories at once, keys prefixed by directory so they cannot collide. */
export async function snapshotAll(dirs: string[]): Promise<Map<string, string>> {
  const all = new Map<string, string>();
  for (const dir of dirs) {
    for (const [rel, content] of await snapshotDir(dir)) {
      all.set(path.join(dir, rel), content);
    }
  }
  return all;
}

/** What changed between two snapshots. */
export function diffSnapshots(
  before: Map<string, string>,
  after: Map<string, string>
): DriftEntry[] {
  const out: DriftEntry[] = [];
  for (const [file, content] of after) {
    if (!before.has(file)) out.push({ file, status: 'added' });
    else if (before.get(file) !== content) out.push({ file, status: 'changed' });
  }
  for (const file of before.keys()) {
    if (!after.has(file)) out.push({ file, status: 'removed' });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Put a snapshot back, so a failed check leaves the tree exactly as it found it.
 *
 * A file that regeneration created and the snapshot does not know about is deleted, since it was
 * not there before the check ran.
 */
export async function restoreSnapshot(
  before: Map<string, string>,
  after: Map<string, string>
): Promise<void> {
  for (const [file, content] of before) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, 'utf8');
  }
  for (const file of after.keys()) {
    if (!before.has(file)) await fs.rm(file, { force: true });
  }
}
