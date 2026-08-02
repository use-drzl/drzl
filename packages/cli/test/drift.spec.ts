/**
 * Drift detection, the check no runtime validator can offer.
 *
 * `drizzle-orm/zod` and its siblings derive schemas in memory at import time, so there is nothing
 * on disk to have drifted and nothing for CI to compare. Only a code generator can answer "is the
 * committed output still what this schema produces".
 *
 * The two failures it has to catch are someone editing a generated file by hand, and someone
 * changing the schema without regenerating. Both are review-time problems today and CI problems
 * with this.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { snapshotAll, snapshotDir, diffSnapshots, restoreSnapshot } from '../src/drift';

async function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'drzl-drift-'));
}
async function write(dir: string, rel: string, body: string) {
  const full = path.join(dir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body, 'utf8');
  return full;
}

describe('snapshotDir', () => {
  it('reads every file, including nested ones', async () => {
    const d = await tmp();
    await write(d, 'a.ts', 'A');
    await write(d, 'nested/b.ts', 'B');
    const snap = await snapshotDir(d);
    expect([...snap.keys()].sort()).toEqual(['a.ts', path.join('nested', 'b.ts')]);
    expect(snap.get('a.ts')).toBe('A');
  });

  it('treats a directory that does not exist as empty, not an error', async () => {
    // A first run has generated nothing yet, and that should report as additions rather than
    // crashing the check.
    const snap = await snapshotDir(path.join(await tmp(), 'never-created'));
    expect(snap.size).toBe(0);
  });
});

describe('diffSnapshots', () => {
  const snap = (o: Record<string, string>) => new Map(Object.entries(o));

  it('finds nothing when the trees match', () => {
    expect(diffSnapshots(snap({ 'a.ts': 'A' }), snap({ 'a.ts': 'A' }))).toEqual([]);
  });

  it('reports a changed file', () => {
    expect(diffSnapshots(snap({ 'a.ts': 'A' }), snap({ 'a.ts': 'B' }))).toEqual([
      { file: 'a.ts', status: 'changed' },
    ]);
  });

  it('reports a file the regeneration added', () => {
    expect(diffSnapshots(snap({}), snap({ 'a.ts': 'A' }))).toEqual([
      { file: 'a.ts', status: 'added' },
    ]);
  });

  it('reports a file the regeneration no longer produces', () => {
    // A dropped table leaves a stale file behind, which is drift even though nothing changed.
    expect(diffSnapshots(snap({ 'gone.ts': 'X' }), snap({}))).toEqual([
      { file: 'gone.ts', status: 'removed' },
    ]);
  });

  it('sorts, so the report reads the same every run', () => {
    const d = diffSnapshots(snap({}), snap({ 'z.ts': '1', 'a.ts': '1' }));
    expect(d.map((x) => x.file)).toEqual(['a.ts', 'z.ts']);
  });
});

describe('restoreSnapshot', () => {
  it('puts an overwritten file back exactly', async () => {
    const d = await tmp();
    const f = await write(d, 'a.ts', 'ORIGINAL');
    const before = await snapshotAll([d]);

    await fs.writeFile(f, 'REGENERATED', 'utf8');
    const after = await snapshotAll([d]);

    await restoreSnapshot(before, after);
    expect(await fs.readFile(f, 'utf8')).toBe('ORIGINAL');
  });

  it('deletes a file the regeneration created, since it was not there before', async () => {
    const d = await tmp();
    await write(d, 'a.ts', 'A');
    const before = await snapshotAll([d]);

    const added = await write(d, 'new.ts', 'NEW');
    const after = await snapshotAll([d]);

    await restoreSnapshot(before, after);
    await expect(fs.access(added)).rejects.toThrow();
  });

  it('recreates a file the regeneration deleted', async () => {
    const d = await tmp();
    const f = await write(d, 'a.ts', 'A');
    const before = await snapshotAll([d]);

    await fs.rm(f);
    const after = await snapshotAll([d]);

    await restoreSnapshot(before, after);
    expect(await fs.readFile(f, 'utf8')).toBe('A');
  });

  it('leaves the tree byte-identical across a full check cycle', async () => {
    // The property that matters: --check must never alter the working tree, whatever it finds.
    const d = await tmp();
    await write(d, 'a.ts', 'A');
    await write(d, 'sub/b.ts', 'B');
    const original = await snapshotAll([d]);

    await write(d, 'a.ts', 'CHANGED');
    await write(d, 'sub/c.ts', 'EXTRA');
    await fs.rm(path.join(d, 'sub/b.ts'));
    const after = await snapshotAll([d]);

    await restoreSnapshot(original, after);
    expect(await snapshotAll([d])).toEqual(original);
  });
});

describe('snapshotAll', () => {
  it('keys by full path so two directories cannot collide', async () => {
    const a = await tmp();
    const b = await tmp();
    await write(a, 'index.ts', 'FROM_A');
    await write(b, 'index.ts', 'FROM_B');
    const snap = await snapshotAll([a, b]);
    expect(snap.size).toBe(2);
    expect(snap.get(path.join(a, 'index.ts'))).toBe('FROM_A');
    expect(snap.get(path.join(b, 'index.ts'))).toBe('FROM_B');
  });
});
