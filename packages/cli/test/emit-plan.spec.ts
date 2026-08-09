/**
 * The per-file verdict every one of items 68, 80 and 81 reads (see `emit-plan.ts`).
 *
 * The two properties worth pinning here are the ones a run cannot recover from if they are wrong:
 * a plan-mode sink must not touch the filesystem at all, not even to create the directory a
 * generator asks for, and a `before` must be the content that was on disk when the run started
 * rather than whatever the run itself put there a moment ago.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  describeCounts,
  displayPath,
  driftStatusOf,
  EmitPlan,
  pendingChanges,
  verifyNothingWasWritten,
} from '../src/emit-plan';

async function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'drzl-plan-'));
}

/** Every path under `dir`, files and directories alike, so "untouched" means both. */
async function tree(dir: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(current: string) {
    for (const e of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, e.name);
      found.push(path.relative(dir, full) + (e.isDirectory() ? '/' : ''));
      if (e.isDirectory()) await walk(full);
    }
  }
  await walk(dir);
  return found.sort();
}

describe('EmitPlan in plan mode', () => {
  it('writes nothing and creates no directory', async () => {
    const root = await tmp();
    const plan = new EmitPlan({ write: false });

    await plan.mkdir(path.join(root, 'out', 'nested'));
    await plan.writeFile(path.join(root, 'out', 'nested', 'a.ts'), 'A');
    await plan.writeFile(path.join(root, 'out', 'b.ts'), 'B');

    // The assertion item 68 is really about: an empty directory stays empty, byte for byte.
    expect(await tree(root)).toEqual([]);
    expect(plan.files.map((f) => f.after)).toEqual(['A', 'B']);
  });

  it('still reports the directories a generator asked for', async () => {
    const root = await tmp();
    const plan = new EmitPlan({ write: false });
    await plan.mkdir(path.join(root, 'zod'));
    expect(plan.directories).toEqual([path.join(root, 'zod')]);
  });

  it('calls a file that is not there created', async () => {
    const root = await tmp();
    const plan = new EmitPlan({ write: false });
    await plan.writeFile(path.join(root, 'new.ts'), 'X');
    expect(plan.files[0].verdict).toBe('created');
    expect(plan.files[0].before).toBeNull();
  });

  it('calls a file with different content changed, and keeps what was there', async () => {
    const root = await tmp();
    const file = path.join(root, 'a.ts');
    await fs.writeFile(file, 'OLD', 'utf8');
    const plan = new EmitPlan({ write: false });
    await plan.writeFile(file, 'NEW');
    expect(plan.files[0].verdict).toBe('changed');
    expect(plan.files[0].before).toBe('OLD');
    expect(plan.files[0].after).toBe('NEW');
  });

  it('calls a byte-identical file unchanged', async () => {
    const root = await tmp();
    const file = path.join(root, 'a.ts');
    await fs.writeFile(file, 'SAME', 'utf8');
    const plan = new EmitPlan({ write: false });
    await plan.writeFile(file, 'SAME');
    expect(plan.files[0].verdict).toBe('unchanged');
  });

  it('takes `before` from a snapshot when one is given, without reading the disk', async () => {
    // The snapshot is authoritative on purpose: `--check` reads the output directories once and
    // hands the map over, so a file the run writes twice cannot see its own first write.
    const existing = new Map([['/abs/a.ts', 'FROM SNAPSHOT']]);
    const plan = new EmitPlan({ write: false, existing });
    await plan.writeFile('/abs/a.ts', 'FROM SNAPSHOT');
    await plan.writeFile('/abs/b.ts', 'NEW');
    expect(plan.files[0].verdict).toBe('unchanged');
    expect(plan.files[1].verdict).toBe('created');
  });
});

describe('EmitPlan in write mode', () => {
  it('writes the file and creates the directory', async () => {
    const root = await tmp();
    const plan = new EmitPlan({ write: true });
    await plan.mkdir(path.join(root, 'out'));
    await plan.writeFile(path.join(root, 'out', 'a.ts'), 'A');
    expect(await fs.readFile(path.join(root, 'out', 'a.ts'), 'utf8')).toBe('A');
  });

  it('reports the verdict against what was on disk before this run, not after its own write', async () => {
    // A generator writing the same path twice, or two generators pointed at one directory. The
    // second write would otherwise compare itself against the first and report `unchanged` for a
    // file that changed.
    const root = await tmp();
    const file = path.join(root, 'a.ts');
    await fs.writeFile(file, 'ORIGINAL', 'utf8');
    const plan = new EmitPlan({ write: true });
    await plan.writeFile(file, 'FIRST');
    await plan.writeFile(file, 'SECOND');
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0].before).toBe('ORIGINAL');
    expect(plan.files[0].after).toBe('SECOND');
    expect(plan.files[0].verdict).toBe('changed');
    expect(await fs.readFile(file, 'utf8')).toBe('SECOND');
  });
});

describe('counts and reporting', () => {
  it('counts each verdict, over all files or over one generator’s', async () => {
    const root = await tmp();
    await fs.writeFile(path.join(root, 'same.ts'), 'S', 'utf8');
    await fs.writeFile(path.join(root, 'diff.ts'), 'OLD', 'utf8');
    const plan = new EmitPlan({ write: false });
    await plan.writeFile(path.join(root, 'same.ts'), 'S');
    await plan.writeFile(path.join(root, 'diff.ts'), 'NEW');
    await plan.writeFile(path.join(root, 'new.ts'), 'N');

    expect(plan.counts()).toEqual({ total: 3, created: 1, changed: 1, unchanged: 1 });
    expect(plan.counts([path.join(root, 'new.ts')])).toEqual({
      total: 1,
      created: 1,
      changed: 0,
      unchanged: 0,
    });
  });

  it('leaves the zeroes out of the sentence', () => {
    expect(describeCounts({ total: 3, created: 3, changed: 0, unchanged: 0 })).toBe('3 created');
    expect(describeCounts({ total: 2, created: 0, changed: 1, unchanged: 1 })).toBe(
      '1 changed, 1 unchanged'
    );
    expect(describeCounts({ total: 0, created: 0, changed: 0, unchanged: 0 })).toBe(
      'nothing to write'
    );
  });

  it('lists only what would change, sorted, so a report reads the same every run', async () => {
    const root = await tmp();
    await fs.writeFile(path.join(root, 'z.ts'), 'OLD', 'utf8');
    await fs.writeFile(path.join(root, 'keep.ts'), 'K', 'utf8');
    const plan = new EmitPlan({ write: false });
    await plan.writeFile(path.join(root, 'z.ts'), 'NEW');
    await plan.writeFile(path.join(root, 'keep.ts'), 'K');
    await plan.writeFile(path.join(root, 'a.ts'), 'A');
    expect(pendingChanges(plan).map((f) => path.basename(f.file))).toEqual(['a.ts', 'z.ts']);
  });

  it('keeps the published drift vocabulary', () => {
    // `added` rather than `created`, because that is the word the --json contract and the docs
    // have used since --check shipped.
    expect(driftStatusOf('created')).toBe('added');
    expect(driftStatusOf('changed')).toBe('changed');
  });

  it('names a path relative to where the command was run, and leaves an outside path alone', () => {
    expect(displayPath('/a/b/c.ts', '/a')).toBe(path.join('b', 'c.ts'));
    expect(displayPath('/elsewhere/c.ts', '/a')).toBe('/elsewhere/c.ts');
  });

  it('reports a path the generator claims but never routed through the sink', async () => {
    const plan = new EmitPlan({ write: false });
    await plan.writeFile('/abs/known.ts', 'K');
    expect(plan.unrecorded(['/abs/known.ts', '/abs/hidden.ts'])).toEqual(['/abs/hidden.ts']);
  });
});

describe('verifyNothingWasWritten', () => {
  it('says nothing when the tree is untouched', async () => {
    const root = await tmp();
    await fs.writeFile(path.join(root, 'a.ts'), 'A', 'utf8');
    const before = new Map([[path.join(root, 'a.ts'), 'A']]);
    expect(await verifyNothingWasWritten([root], before)).toEqual([]);
  });

  it('names what was written and puts it back', async () => {
    // The version-skew case: a generator that predates `fileSink` accepts it, ignores it, and
    // writes. The guard is what stops a dry run silently rewriting somebody's tree.
    const root = await tmp();
    const kept = path.join(root, 'a.ts');
    await fs.writeFile(kept, 'ORIGINAL', 'utf8');
    const before = new Map([[kept, 'ORIGINAL']]);

    await fs.writeFile(kept, 'OVERWRITTEN', 'utf8');
    const rogue = path.join(root, 'rogue.ts');
    await fs.writeFile(rogue, 'NEW', 'utf8');

    const written = await verifyNothingWasWritten([root], before);
    expect(written).toEqual([kept, rogue].sort());
    expect(await fs.readFile(kept, 'utf8')).toBe('ORIGINAL');
    await expect(fs.access(rogue)).rejects.toThrow();
  });
});
