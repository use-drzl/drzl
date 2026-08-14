/**
 * The manifest, and the stale files it makes it safe to delete.
 *
 * Every test that involves deleting is here because the failure mode is unrecoverable. A generator
 * that removes a file a person wrote has destroyed work, and no amount of "it looked generated"
 * makes that acceptable, so the rule is narrow on purpose: delete only what a previous run recorded
 * writing, and nothing else, ever.
 */
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  MANIFEST_PATH,
  nextManifestFiles,
  MANIFEST_VERSION,
  manifestEntries,
  pruneStale,
  readManifest,
  staleFiles,
  staleWarning,
  writeManifest,
} from '../src/manifest.js';

let root: string;
const roots: string[] = [];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-manifest-'));
  roots.push(root);
});

afterAll(async () => {
  for (const r of roots) await fs.rm(r, { recursive: true, force: true });
});

/** Create a file under the root and return its absolute path, as a generator would spell it. */
async function touch(rel: string): Promise<string> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, '// generated\n', 'utf8');
  return abs;
}

describe('what the manifest records', () => {
  it('stores paths relative to the root, sorted, with forward slashes', async () => {
    const files = [
      path.join(root, 'src/generated/zod/users.ts'),
      path.join(root, 'src/generated/zod/index.ts'),
    ];
    expect(manifestEntries(files, root)).toEqual([
      'src/generated/zod/index.ts',
      'src/generated/zod/users.ts',
    ]);
  });

  it('deduplicates, so a file written by two passes is recorded once', () => {
    const one = path.join(root, 'a.ts');
    expect(manifestEntries([one, one], root)).toEqual(['a.ts']);
  });

  /**
   * No timestamp and no checksum, deliberately.
   *
   * A timestamp would rewrite the file on every run and put noise in every commit. A checksum would
   * answer a question `--check` already answers better, by comparing the content it just produced
   * against what is on disk.
   */
  it('writes a file whose bytes do not change when the run does not', async () => {
    await writeManifest(root, [await touch('a.ts')]);
    const first = await fs.readFile(path.join(root, MANIFEST_PATH), 'utf8');
    await writeManifest(root, [path.join(root, 'a.ts')]);
    const second = await fs.readFile(path.join(root, MANIFEST_PATH), 'utf8');
    expect(second).toBe(first);
    expect(JSON.parse(first)).toEqual({ version: MANIFEST_VERSION, files: ['a.ts'] });
  });

  it('ends with a newline, because it lands in a repository', async () => {
    await writeManifest(root, []);
    expect(await fs.readFile(path.join(root, MANIFEST_PATH), 'utf8')).toMatch(/\n$/);
  });
});

describe('reading one that cannot be trusted', () => {
  /**
   * Every failure reads as "there is no manifest", never as an error.
   *
   * Missing, truncated by a crash, hand-edited into nonsense and written by a future version all
   * mean the same thing to a caller: there is no trustworthy record of the last run, so claim
   * nothing. A generator that refused to run because its own bookkeeping file was malformed would
   * be a worse tool than one that quietly rebuilds it.
   */
  it('returns nothing when there is no manifest', async () => {
    expect(await readManifest(root)).toBeUndefined();
  });

  it('returns nothing for a truncated file', async () => {
    await fs.mkdir(path.join(root, '.drzl'), { recursive: true });
    await fs.writeFile(path.join(root, MANIFEST_PATH), '{"version":1,"files":[', 'utf8');
    expect(await readManifest(root)).toBeUndefined();
  });

  it('returns nothing for a version it does not know', async () => {
    await fs.mkdir(path.join(root, '.drzl'), { recursive: true });
    await fs.writeFile(
      path.join(root, MANIFEST_PATH),
      JSON.stringify({ version: MANIFEST_VERSION + 1, files: ['a.ts'] }),
      'utf8'
    );
    expect(await readManifest(root)).toBeUndefined();
  });

  it('returns nothing when files is not a list of strings', async () => {
    await fs.mkdir(path.join(root, '.drzl'), { recursive: true });
    await fs.writeFile(
      path.join(root, MANIFEST_PATH),
      JSON.stringify({ version: MANIFEST_VERSION, files: [1, 2] }),
      'utf8'
    );
    expect(await readManifest(root)).toBeUndefined();
  });
});

describe('what counts as stale', () => {
  it('is a file the last run wrote and this one did not', async () => {
    await touch('out/users.ts');
    await touch('out/posts.ts');
    await writeManifest(root, [path.join(root, 'out/users.ts'), path.join(root, 'out/posts.ts')]);

    const previous = await readManifest(root);
    const stale = await staleFiles(previous, [path.join(root, 'out/users.ts')], root);
    expect(stale).toEqual([{ file: 'out/posts.ts', present: true }]);
  });

  /**
   * A file this run left unchanged is still owned.
   *
   * `EmitPlan` records an unchanged file as written, and that is the behaviour this depends on:
   * skipping the write is an optimisation, not a statement that DRZL stopped owning the file. If
   * the difference were taken against changed files only, every steady-state run would call every
   * unchanged file stale and offer to delete the entire output.
   */
  it('does not call an unchanged file stale', async () => {
    await touch('out/users.ts');
    await writeManifest(root, [path.join(root, 'out/users.ts')]);
    const stale = await staleFiles(await readManifest(root), [path.join(root, 'out/users.ts')], root);
    expect(stale).toEqual([]);
  });

  it('claims nothing at all on the first run', async () => {
    expect(await staleFiles(undefined, [path.join(root, 'out/users.ts')], root)).toEqual([]);
  });

  it('marks an entry that is already gone from disk', async () => {
    await writeManifest(root, [path.join(root, 'out/deleted.ts')]);
    const stale = await staleFiles(await readManifest(root), [], root);
    expect(stale).toEqual([{ file: 'out/deleted.ts', present: false }]);
  });
});

describe('pruning, which is the part that deletes', () => {
  it('removes a stale file that is still on disk', async () => {
    const abs = await touch('out/gone.ts');
    const deleted = await pruneStale(root, [{ file: 'out/gone.ts', present: true }]);
    expect(deleted).toEqual(['out/gone.ts']);
    await expect(fs.access(abs)).rejects.toThrow();
  });

  it('leaves alone an entry already gone', async () => {
    expect(await pruneStale(root, [{ file: 'out/never.ts', present: false }])).toEqual([]);
  });

  /**
   * The one that matters.
   *
   * A manifest is an ordinary file a person can edit, and a path in it that climbs out of the
   * project must never become a delete. Resolving it and refusing anything outside the root is the
   * guard; this asserts the guard rather than the intention.
   */
  it('refuses a path that escapes the project root', async () => {
    const outside = path.join(path.dirname(root), 'do-not-touch.txt');
    await fs.writeFile(outside, 'a file nobody asked DRZL about\n', 'utf8');
    const escape = path.relative(root, outside);
    expect(escape.startsWith('..'), 'the fixture is not actually outside the root').toBe(true);

    const deleted = await pruneStale(root, [{ file: escape, present: true }]);
    expect(deleted).toEqual([]);
    await expect(fs.access(outside)).resolves.toBeUndefined();
    await fs.rm(outside, { force: true });
  });

  it('deletes nothing when there is nothing stale', async () => {
    const kept = await touch('out/kept.ts');
    expect(await pruneStale(root, [])).toEqual([]);
    await expect(fs.access(kept)).resolves.toBeUndefined();
  });
});

describe('what the user is told', () => {
  it('says nothing when every stale entry is already gone', () => {
    expect(staleWarning([{ file: 'a.ts', present: false }])).toBeUndefined();
  });

  it('names the files and the command that removes them', () => {
    const msg = staleWarning([
      { file: 'out/a.ts', present: true },
      { file: 'out/b.ts', present: false },
    ]);
    expect(msg).toContain('out/a.ts');
    // The one already gone is not offered for deletion, because there is nothing to delete.
    expect(msg).not.toContain('out/b.ts');
    expect(msg).toContain('--prune');
    // And it says what `--prune` is limited to, so the reader knows it is not a blanket clean.
    expect(msg).toContain('recorded');
  });
});

describe('what the next run is told this one owned', () => {
  /**
   * A stale file still on disk stays in the record, and this is the defect that made it necessary.
   *
   * Recording only what the run wrote loses the file after exactly one run: run one writes
   * `posts.zod.ts`, run two drops the table and records only what it wrote, and by run three there
   * is nothing left saying DRZL ever created it. The warning fires once and then never again, and
   * `--prune` deletes nothing, because by the time anyone runs it the record is gone.
   *
   * Found by running three generates in a row rather than by reading the code: run two warned
   * exactly as intended and run three pruned nothing at all.
   */
  it('keeps a stale file that is still on disk', () => {
    const written = [path.join(root, 'out/users.ts')];
    const stale = [{ file: 'out/posts.ts', present: true }];
    expect(nextManifestFiles(written, stale, root)).toEqual(['out/posts.ts', 'out/users.ts']);
  });

  /** One already gone drops out, which is what stops the record growing forever. */
  it('drops a stale entry that is no longer on disk', () => {
    const written = [path.join(root, 'out/users.ts')];
    const stale = [{ file: 'out/deleted.ts', present: false }];
    expect(nextManifestFiles(written, stale, root)).toEqual(['out/users.ts']);
  });

  it('records exactly what was written when nothing is stale', () => {
    const written = [path.join(root, 'out/users.ts'), path.join(root, 'out/index.ts')];
    expect(nextManifestFiles(written, [], root)).toEqual(['out/index.ts', 'out/users.ts']);
  });

  /**
   * And the sequence the defect was found in, as a test.
   *
   * Three runs: write two files, drop one table, then prune. The middle run is the one that used to
   * forget, so its manifest is what this asserts.
   */
  it('survives write, drop, prune in that order', async () => {
    await touch('out/users.ts');
    await touch('out/posts.ts');
    await writeManifest(root, [path.join(root, 'out/users.ts'), path.join(root, 'out/posts.ts')]);

    // Run two: only users is written.
    const afterDrop = await staleFiles(await readManifest(root), [path.join(root, 'out/users.ts')], root);
    expect(afterDrop).toEqual([{ file: 'out/posts.ts', present: true }]);
    await writeManifest(
      root,
      nextManifestFiles([path.join(root, 'out/users.ts')], afterDrop, root).map((f) =>
        path.join(root, f)
      )
    );
    expect((await readManifest(root))?.files).toContain('out/posts.ts');

    // Run three: still stale, and now prunable.
    const stillStale = await staleFiles(await readManifest(root), [path.join(root, 'out/users.ts')], root);
    expect(await pruneStale(root, stillStale)).toEqual(['out/posts.ts']);
  });
});
