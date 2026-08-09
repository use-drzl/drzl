/**
 * End-to-end coverage for `init`, `generate:orpc` and `watch`, spawned as real processes.
 *
 * All three shipped with no automated test of any kind. `init` in particular is the first
 * command a new user runs, and nothing checked that the config it writes can actually be run,
 * let alone that its output compiles.
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

describe('drzl init', () => {
  it('writes a config, and that config actually runs', async () => {
    const dir = await project('init');
    await run(process.execPath, [CLI, 'init'], { cwd: dir });

    const config = await fs.readFile(path.join(dir, 'drzl.config.ts'), 'utf8');
    expect(config).toContain('schema:');
    expect(config).toContain('generators:');

    // The scaffold is the first config most users see, and it had no type annotation at all, so
    // it got no completion in an editor. The annotation has to stay type-only: this fixture has
    // no `@drzl/cli` to resolve, exactly like a project that ran the CLI through `npx`, and the
    // `generate` below is what proves the import is erased rather than resolved.
    expect(config).toContain("import type { DrzlConfigInput } from '@drzl/cli/config'");
    expect(config).toContain('satisfies DrzlConfigInput');

    // The config `init` writes has to be one `generate` accepts. Scaffolding something that
    // then fails is worse than scaffolding nothing.
    await run(process.execPath, [CLI, 'generate'], { cwd: dir, maxBuffer: 20 * 1024 * 1024 });
    expect(existsSync(path.join(dir, 'src', 'api', 'users.ts'))).toBe(true);
  }, 120_000);

  it('points at the schema path it scaffolds for, not an invented one', async () => {
    const dir = await project('init-path');
    await run(process.execPath, [CLI, 'init'], { cwd: dir });
    const schemaPath = (await fs.readFile(path.join(dir, 'drzl.config.ts'), 'utf8')).match(
      /schema:\s*['"]([^'"]+)['"]/
    )?.[1];
    expect(schemaPath).toBeTruthy();
    expect(existsSync(path.join(dir, schemaPath!)), `config names ${schemaPath}`).toBe(true);
  }, 60_000);
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
