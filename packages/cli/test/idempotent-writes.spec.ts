/**
 * A second `generate` over an up-to-date tree touches nothing.
 *
 * The command already knew which files were unchanged: it prints the count. It wrote them anyway,
 * and a byte-identical write is a no-op with a side effect, because it moves the file's mtime and
 * an mtime is what every watcher downstream keys on. So regenerating a tree that had not changed
 * restarted dev servers, re-ran type checkers and invalidated bundler caches.
 *
 * mtime is what is asserted here rather than content, because content was never the thing that
 * moved. The resolution of a filesystem mtime is coarse enough that a fast second run could land in
 * the same millisecond, so the first run's mtime is pushed into the past before the second, which
 * makes any write at all visible.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EmitPlan } from '../src/emit-plan';

async function tmpdir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-idempotent-'));
}

/** An mtime far enough in the past that any write at all shows up. */
async function backdate(file: string): Promise<number> {
  const when = new Date(Date.now() - 60_000);
  await fs.utimes(file, when, when);
  return (await fs.stat(file)).mtimeMs;
}

describe('writing the same bytes again', () => {
  it('does not touch the file', async () => {
    const dir = await tmpdir();
    const file = path.join(dir, 'users.ts');

    const first = new EmitPlan({ write: true });
    await first.writeFile(file, 'export const a = 1;\n');
    const was = await backdate(file);

    const second = new EmitPlan({ write: true });
    await second.writeFile(file, 'export const a = 1;\n');
    const now = (await fs.stat(file)).mtimeMs;

    expect(second.files[0]?.verdict).toBe('unchanged');
    expect(now, 'the file was rewritten with identical bytes').toBe(was);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('still writes when the bytes differ', async () => {
    const dir = await tmpdir();
    const file = path.join(dir, 'users.ts');

    const first = new EmitPlan({ write: true });
    await first.writeFile(file, 'export const a = 1;\n');
    const was = await backdate(file);

    const second = new EmitPlan({ write: true });
    await second.writeFile(file, 'export const a = 2;\n');
    const now = (await fs.stat(file)).mtimeMs;

    expect(second.files[0]?.verdict).toBe('changed');
    expect(now).toBeGreaterThan(was);
    expect(await fs.readFile(file, 'utf8')).toBe('export const a = 2;\n');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates a file that is not there', async () => {
    const dir = await tmpdir();
    const file = path.join(dir, 'new.ts');
    const plan = new EmitPlan({ write: true });
    await plan.writeFile(file, 'export const a = 1;\n');
    expect(plan.files[0]?.verdict).toBe('created');
    expect(await fs.readFile(file, 'utf8')).toBe('export const a = 1;\n');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('keeps the last bytes when one run writes a path twice', async () => {
    // Two generators sharing an output directory. The second write is identical to what was on
    // disk when the run started, and skipping it on that basis would leave the first write's bytes
    // in place: "unchanged since the run started" is not "unchanged since a moment ago".
    const dir = await tmpdir();
    const file = path.join(dir, 'shared.ts');
    await fs.writeFile(file, 'original\n', 'utf8');

    const plan = new EmitPlan({ write: true });
    await plan.writeFile(file, 'from the first generator\n');
    await plan.writeFile(file, 'original\n');

    expect(await fs.readFile(file, 'utf8')).toBe('original\n');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes nothing at all when the plan is not writing', async () => {
    const dir = await tmpdir();
    const file = path.join(dir, 'dry.ts');
    const plan = new EmitPlan({ write: false });
    await plan.writeFile(file, 'export const a = 1;\n');
    expect(plan.files[0]?.verdict).toBe('created');
    await expect(fs.stat(file)).rejects.toThrow();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
