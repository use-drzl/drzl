/**
 * End-to-end coverage for `generate:orpc` and `watch`, spawned as real processes.
 *
 * Both shipped with no automated test of any kind. `init` was covered here too until it grew
 * prompts and schema detection; it now has `init.e2e.spec.ts` to itself, with its own temp root,
 * so the two files cannot race each other's fixtures.
 *
 * Requires a build. CI builds before testing; locally, run `pnpm build` first.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';

const run = promisify(execFile);
const CLI = path.resolve(__dirname, '..', 'dist', 'cli.js');
const ROOT = path.join(__dirname, '.cmd-tmp');

const SCHEMA = `
import { pgTable, integer, serial, text } from 'drizzle-orm/pg-core';
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
});
`;

/** A fresh project directory. Lives under this package so drizzle-orm resolves normally. */
async function project(name: string) {
  const dir = path.join(ROOT, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'src', 'db'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'db', 'schema.ts'), SCHEMA, 'utf8');
  return dir;
}

beforeAll(async () => {
  if (!existsSync(CLI)) {
    throw new Error(`Built CLI not found at ${CLI}. Run \`pnpm build\` before \`pnpm test\`.`);
  }
  await fs.mkdir(ROOT, { recursive: true });
}, 60_000);

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('drzl generate:orpc', () => {
  it('generates from a schema path with no config file present', async () => {
    const dir = await project('gen-orpc');
    await run(process.execPath, [CLI, 'generate:orpc', 'src/db/schema.ts', '--outDir', 'out'], {
      cwd: dir,
      maxBuffer: 20 * 1024 * 1024,
    });
    expect(existsSync(path.join(dir, 'out', 'users.ts'))).toBe(true);
    expect(existsSync(path.join(dir, 'out', 'index.ts'))).toBe(true);
  }, 120_000);

  it('rejects an unknown flag rather than silently ignoring it', async () => {
    const dir = await project('gen-orpc-bad');
    await expect(
      run(process.execPath, [CLI, 'generate:orpc', 'src/db/schema.ts', '--out', 'out'], {
        cwd: dir,
      })
    ).rejects.toThrow();
  }, 60_000);
});

describe('drzl watch', () => {
  it('regenerates when the schema changes', async () => {
    const dir = await project('watch');
    await fs.writeFile(
      path.join(dir, 'drzl.config.ts'),
      `export default {
         schema: './src/db/schema.ts',
         outDir: './out',
         generators: [{ kind: 'zod', path: './zod' }],
       };`,
      'utf8'
    );

    // `--poll` on purpose. Filesystem events do not reach chokidar reliably on WSL, Docker or a
    // network mount, which is exactly why the flag exists, and a test that depends on inotify
    // reports the environment rather than the product. Polling behaves the same everywhere.
    const child = spawn(process.execPath, [CLI, 'watch', '--debounce', '50', '--poll'], {
      cwd: dir,
      stdio: 'ignore',
    });

    try {
      // `watch` does build once on start, so the presence of output proves nothing on its own.
      // What has to be proved is that a change made *after* the watcher attached is picked up,
      // which is precisely what was broken: chokidar was handed a glob it could not expand, so
      // the startup build was the only thing that ever ran.
      //
      // Give chokidar a moment to attach before touching the file it is meant to be watching.
      await new Promise((r) => setTimeout(r, 1500));
      await fs.appendFile(
        path.join(dir, 'src', 'db', 'schema.ts'),
        `\nexport const posts = pgTable('posts', { id: serial('id').primaryKey() });\n`,
        'utf8'
      );

      // Both tables have to appear: the new one proves the change was picked up, the existing
      // one proves a full regeneration rather than a partial write.
      await waitFor(
        () =>
          existsSync(path.join(dir, 'zod', 'posts.zod.ts')) &&
          existsSync(path.join(dir, 'zod', 'users.zod.ts')),
        60_000,
        'regeneration after the schema changed'
      );
      expect(await fs.readFile(path.join(dir, 'zod', 'posts.zod.ts'), 'utf8')).toContain(
        'Insertposts'
      );
    } finally {
      child.kill('SIGTERM');
    }
  }, 180_000);
});

/** Poll until `check` passes, or fail naming what was being waited for. */
async function waitFor(check: () => boolean, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}
