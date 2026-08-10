/**
 * One vocabulary for "run this generator": `--only`, on both commands that can run one.
 *
 * The CLI grew two per-kind commands and a `--pipeline` flag, and none of the three could name
 * every generator. `generate:orpc` shipped when oRPC was the only generator; `generate:trpc`
 * arrived with the tRPC generator; the twelve generators added afterwards added no command at all.
 * `--pipeline` listed seven of the fourteen kinds and matched nothing for the other seven, in
 * silence, which is the defect the first block below fires on.
 *
 * Spawned as real processes, because every one of these is about what a command line does: an
 * in-process call cannot see an exit code, a stream, or a flag commander rejected.
 *
 * Requires a build. CI builds before testing; locally, run `pnpm build` first.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const PKG = path.resolve(__dirname, '..');
const CLI = path.join(PKG, 'dist', 'cli.js');
const ROOT = path.join(__dirname, '.tmp-generate-only');

const SCHEMA = `
import { pgTable, integer, serial, text } from 'drizzle-orm/pg-core';
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
});
export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id').references(() => users.id),
  title: text('title').notNull(),
});
`;

/** Two generators, so a selection has something to leave out. */
const CONFIG = `export default {
  schema: './src/db/schema.ts',
  outDir: './out/orpc',
  generators: [
    { kind: 'zod', path: './out/zod' },
    { kind: 'typebox', path: './out/typebox' },
  ],
};
`;

/** Run the CLI and hand back its streams and exit code, whether it succeeded or not. */
async function cli(argv: string[], cwd: string, exe = CLI) {
  try {
    const { stdout, stderr } = await run(process.execPath, [exe, ...argv], {
      cwd,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, DRZL_HIDE_SPONSOR: '1' },
    });
    return { code: 0, stdout, stderr };
  } catch (e: any) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

async function project(name: string, config: string | null = CONFIG) {
  const dir = path.join(ROOT, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'src', 'db'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'db', 'schema.ts'), SCHEMA, 'utf8');
  if (config) await fs.writeFile(path.join(dir, 'drzl.config.ts'), config, 'utf8');
  return dir;
}

/**
 * Start a watcher, wait for the file one rebuild produces, then stop it.
 *
 * Bounded by a file rather than by a sleep where there is one to wait for, and by a short wait
 * where the point is that no file appears. `--poll` because inotify does not reach chokidar
 * reliably on WSL or in Docker.
 */
async function watchOnce(args: string[], cwd: string, expected?: string) {
  const child = spawn(process.execPath, [CLI, 'watch', '--poll', '--debounce', '20', ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DRZL_HIDE_SPONSOR: '1' },
  });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (c) => (stderr += String(c)));
  child.stdout.on('data', (c) => (stdout += String(c)));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (expected && existsSync(path.join(cwd, expected))) break;
      if (!expected && stderr.length) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    // A settle, so a file half-written when the probe file appeared is complete before it is read,
    // and so a watcher that was going to fail has had time to say so.
    await new Promise((r) => setTimeout(r, 800));
  } finally {
    child.kill('SIGTERM');
  }
  const code = await exited;
  return { stderr, stdout, code };
}

/**
 * A copy of the built CLI outside this repository, with a node_modules holding every direct
 * dependency of `@drzl/cli` except `omit`. Lifted from `generator-failures.e2e.spec.ts`, for the
 * same reason it exists there: "not installed" is a state a user really reaches, and the resolver
 * walks upwards, so the package has to be absent from a tree that is not inside this repository.
 */
async function cliWithout(omit: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-only-'));
  const dist = path.join(dir, 'dist');
  await fs.cp(path.join(PKG, 'dist'), dist, { recursive: true });
  await fs.cp(path.join(PKG, 'package.json'), path.join(dir, 'package.json'));

  const deps = path.join(dir, 'node_modules');
  await fs.mkdir(path.join(deps, '@drzl'), { recursive: true });
  const installed = path.join(PKG, 'node_modules');
  for (const entry of await fs.readdir(installed)) {
    if (entry.startsWith('.')) continue;
    if (entry !== '@drzl') {
      await fs.symlink(path.join(installed, entry), path.join(deps, entry), 'dir');
      continue;
    }
    for (const scoped of await fs.readdir(path.join(installed, '@drzl'))) {
      if (`@drzl/${scoped}` === omit) continue;
      await fs.symlink(
        path.join(installed, '@drzl', scoped),
        path.join(deps, '@drzl', scoped),
        'dir'
      );
    }
  }
  return { dir, cli: path.join(dist, 'cli.js') };
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

describe('watch --pipeline, over the seven kinds it could not name', () => {
  it('regenerates for a kind that used to match no branch at all', async () => {
    // The red-first case. Against the previous release this watcher started, printed its watch
    // list, wrote nothing, and reported nothing wrong, because `generate-zod` was not one of the
    // seven names its dispatch compared against. Measured before the fix: zero files.
    const dir = await project('pipeline-zod');
    await watchOnce(['--pipeline', 'generate-zod'], dir, 'out/zod/index.ts');
    expect(existsSync(path.join(dir, 'out', 'zod', 'index.ts'))).toBe(true);
    // The selection is a filter, so the other generator in the config stayed out of it.
    expect(existsSync(path.join(dir, 'out', 'typebox'))).toBe(false);
  }, 120_000);

  it('refuses a pipeline name that is not one, rather than watching and doing nothing', async () => {
    const dir = await project('pipeline-typo');
    const { stderr, code } = await watchOnce(['--pipeline', 'generate-nonsense'], dir);
    expect(code).toBe(1);
    expect(stderr).toContain('generate-nonsense');
    expect(existsSync(path.join(dir, 'out'))).toBe(false);
  }, 120_000);
});

describe('watch --only', () => {
  it('runs the kinds it names and leaves the rest of the config alone', async () => {
    const dir = await project('watch-only');
    await watchOnce(['--only', 'typebox'], dir, 'out/typebox/index.ts');
    expect(existsSync(path.join(dir, 'out', 'typebox', 'index.ts'))).toBe(true);
    expect(existsSync(path.join(dir, 'out', 'zod'))).toBe(false);
  }, 120_000);

  it('refuses a kind that does not exist, naming it', async () => {
    const dir = await project('watch-only-typo');
    const { stderr, code } = await watchOnce(['--only', 'zodd'], dir);
    expect(code).toBe(1);
    expect(stderr).toContain('zodd');
  }, 120_000);

  it('reports a real kind this config lacks, and keeps watching', async () => {
    // The distinction the watcher draws: a flag value that is not a kind can never become one, so
    // it stops; a kind this config does not name is one save away from being configured, so it is
    // reported on each rebuild and the watcher stays up, like every other thing it declines to do.
    const dir = await project('watch-only-absent');
    const { stderr, code } = await watchOnce(['--only', 'trpc'], dir);
    expect(stderr).toContain('trpc');
    // Killed by the harness rather than exiting on its own, which is what "keeps watching" means.
    expect(code).not.toBe(1);
    expect(existsSync(path.join(dir, 'out'))).toBe(false);
  }, 120_000);
});

describe('generate --only', () => {
  it('runs only the kinds it names', async () => {
    const dir = await project('gen-only');
    const { code } = await cli(['generate', '--only', 'zod'], dir);
    expect(code).toBe(0);
    expect(existsSync(path.join(dir, 'out', 'zod', 'index.ts'))).toBe(true);
    expect(existsSync(path.join(dir, 'out', 'typebox'))).toBe(false);
  }, 120_000);

  it('takes a list', async () => {
    const dir = await project('gen-only-list');
    const { code } = await cli(['generate', '--only', 'zod,typebox'], dir);
    expect(code).toBe(0);
    expect(existsSync(path.join(dir, 'out', 'zod', 'index.ts'))).toBe(true);
    expect(existsSync(path.join(dir, 'out', 'typebox', 'index.ts'))).toBe(true);
  }, 120_000);

  it('fails, naming both halves, when the kind is real and this config has none', async () => {
    // The other shape of silent no-op: a valid kind that filters everything out. Exit 1, because
    // the run could not do what it was asked, rather than 2, which is reserved for a run that did
    // the work and found something.
    const dir = await project('gen-only-absent');
    const { code, stderr } = await cli(['generate', '--only', 'trpc'], dir);
    expect(code).toBe(1);
    expect(stderr).toContain('trpc');
    expect(stderr).toContain('zod');
  }, 120_000);

  it('refuses an unknown kind before it reads anything', async () => {
    const dir = await project('gen-only-typo');
    const { code, stderr } = await cli(['generate', '--only', 'zodd'], dir);
    expect(code).toBe(1);
    expect(stderr).toContain('zodd');
    expect(stderr).toContain('valibot');
  }, 120_000);

  it('reports an unknown kind as one JSON document under --json', async () => {
    const dir = await project('gen-only-json');
    const { code, stdout } = await cli(['generate', '--only', 'zodd', '--json'], dir);
    expect(code).toBe(1);
    const document = JSON.parse(stdout);
    expect(document).toMatchObject({ ok: false, command: 'generate', code: 'DRZL_CLI_ONLY' });
  }, 120_000);

  it('keeps the exit codes --check publishes', async () => {
    const dir = await project('gen-only-check');
    expect((await cli(['generate', '--only', 'zod'], dir)).code).toBe(0);
    // Up to date: 0. Stale: 2, which is the code that says the run worked and found something.
    expect((await cli(['generate', '--only', 'zod', '--check'], dir)).code).toBe(0);
    await fs.writeFile(path.join(dir, 'out', 'zod', 'index.ts'), '// edited by hand\n', 'utf8');
    expect((await cli(['generate', '--only', 'zod', '--check'], dir)).code).toBe(2);
  }, 180_000);
});

describe('generate --schema, with no config at all', () => {
  it('emits what generate:orpc emitted, byte for byte', async () => {
    // The claim the deprecation line makes, checked on the bytes rather than asserted. Both runs
    // are in their own directory so neither can read the other's output.
    const dir = await project('schema-flag', null);
    await cli(['generate:orpc', 'src/db/schema.ts', '-o', 'legacy'], dir);
    const { code } = await cli(['generate', '--schema', 'src/db/schema.ts', '--only', 'orpc'], dir);
    expect(code).toBe(0);

    const read = async (root: string) => {
      const names = (await fs.readdir(path.join(dir, root))).sort();
      const out: Record<string, string> = {};
      for (const name of names) {
        out[name] = await fs.readFile(path.join(dir, root, name), 'utf8');
      }
      return out;
    };
    // `src/api` is the config default for `outDir`, which is also what `generate:orpc -o` defaults
    // to, so the two commands land in the same place for the same reason.
    expect(await read(path.join('src', 'api'))).toEqual(await read('legacy'));
  }, 180_000);

  it('reaches a kind that never had a command of its own', async () => {
    const dir = await project('schema-flag-effect', null);
    const { code } = await cli(
      ['generate', '--schema', 'src/db/schema.ts', '--only', 'effect'],
      dir
    );
    expect(code).toBe(0);
    expect(existsSync(path.join(dir, 'src', 'validators', 'effect', 'index.ts'))).toBe(true);
  }, 120_000);

  it('carries every config feature the per-kind commands could not reach', async () => {
    // `--check` is the one that matters most here: the two commands bypassed the write plan
    // entirely, so no drift verdict of any kind was available for a project generated by them.
    const dir = await project('schema-flag-check', null);
    const argv = ['generate', '--schema', 'src/db/schema.ts', '--only', 'zod'];
    expect((await cli(argv, dir)).code).toBe(0);
    expect((await cli([...argv, '--check'], dir)).code).toBe(0);
    await fs.writeFile(
      path.join(dir, 'src', 'validators', 'zod', 'index.ts'),
      '// edited by hand\n',
      'utf8'
    );
    const stale = await cli([...argv, '--check'], dir);
    expect(stale.code).toBe(2);
    expect(stale.stderr).toContain('out of date');
  }, 180_000);

  it('overrides the config schema when there is one', async () => {
    const dir = await project('schema-flag-override');
    await fs.mkdir(path.join(dir, 'other'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'other', 'schema.ts'),
      `import { pgTable, serial } from 'drizzle-orm/pg-core';
       export const widgets = pgTable('widgets', { id: serial('id').primaryKey() });`,
      'utf8'
    );
    const { code } = await cli(['generate', '--only', 'zod', '--schema', 'other/schema.ts'], dir);
    expect(code).toBe(0);
    // The config's own path names `users` and `posts`; the flag's names `widgets`.
    expect(existsSync(path.join(dir, 'out', 'zod', 'widgets.zod.ts'))).toBe(true);
    expect(existsSync(path.join(dir, 'out', 'zod', 'users.zod.ts'))).toBe(false);
  }, 120_000);

  it('still says there is no config when nothing narrowed the run', async () => {
    const dir = await project('schema-flag-no-only', null);
    const { code, stderr } = await cli(['generate'], dir);
    expect(code).toBe(1);
    expect(stderr).toContain('DRZL_CFG_001');
    // The way out is named where somebody finds out they need one.
    expect(stderr).toContain('--only');
  }, 120_000);
});

describe('the deprecated per-kind commands', () => {
  it('name the replacement command line, on stderr', async () => {
    // The directory is named without the word this test looks for, because stdout carries absolute
    // paths: a project called `deprecated-orpc` would satisfy the assertion below by accident.
    const dir = await project('legacy-orpc', null);
    const { code, stderr, stdout } = await cli(
      ['generate:orpc', 'src/db/schema.ts', '-o', 'api'],
      dir
    );
    expect(code).toBe(0);
    expect(stderr).toContain('drzl generate --schema src/db/schema.ts --only orpc');
    expect(stderr).toContain('5.0');
    // stdout is the answer, so the notice must not be on it: `drzl generate:orpc > files.txt` has
    // carried the file list since it shipped.
    expect(stdout).not.toContain('deprecated');
  }, 120_000);

  it('says which of its flags have no equivalent, and only when they were passed', async () => {
    const dir = await project('deprecated-trpc', null);
    const bare = await cli(['generate:trpc', 'src/db/schema.ts'], dir);
    expect(bare.stderr).toContain('drzl generate --schema src/db/schema.ts --only trpc');
    expect(bare.stderr).not.toContain('drzl.config.ts');

    await fs.rm(path.join(dir, 'src', 'api'), { recursive: true, force: true });
    const flagged = await cli(['generate:trpc', 'src/db/schema.ts', '--template', 'service'], dir);
    expect(flagged.stderr).toContain('template');
    expect(flagged.stderr).toContain('drzl.config.ts');
  }, 120_000);

  it('drops the notice under --quiet and under --json, like every other narration', async () => {
    const dir = await project('deprecated-quiet', null);
    const quiet = await cli(['generate:orpc', 'src/db/schema.ts', '-o', 'api', '--quiet'], dir);
    expect(quiet.code).toBe(0);
    expect(quiet.stderr).toBe('');

    await fs.rm(path.join(dir, 'api'), { recursive: true, force: true });
    const json = await cli(['generate:orpc', 'src/db/schema.ts', '-o', 'api', '--json'], dir);
    expect(json.code).toBe(0);
    expect(json.stderr).toBe('');
    // Still exactly one document on stdout, which is the whole contract `--json` makes.
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: true, command: 'generate:orpc' });
  }, 120_000);
});

describe('a generator package that is not installed', () => {
  it('names the package to install when it is reached through --only', async () => {
    // Seven of the fourteen are optional dependencies, so this is not a hypothetical: a package
    // that has never been published cannot publish through npm's trusted-publisher flow, and a
    // missing optional dependency is skipped by the installer rather than failing it.
    const { dir: home, cli: exe } = await cliWithout('@drzl/generator-typebox');
    try {
      const dir = await project('absent-only');
      const { code, stderr } = await cli(['generate', '--only', 'typebox'], dir, exe);
      expect(code).toBe(1);
      expect(stderr).toContain('npm install @drzl/generator-typebox');
      expect(stderr).not.toMatch(/at .*\.js:\d+/);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  }, 180_000);

  it('names it through the config route with no config file either', async () => {
    const { dir: home, cli: exe } = await cliWithout('@drzl/generator-typebox');
    try {
      const dir = await project('absent-schema-flag', null);
      const { code, stderr } = await cli(
        ['generate', '--schema', 'src/db/schema.ts', '--only', 'typebox'],
        dir,
        exe
      );
      expect(code).toBe(1);
      expect(stderr).toContain('npm install @drzl/generator-typebox');
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  }, 180_000);

  it('names it from the deprecated command too, which used to fail before it started', async () => {
    // oRPC rather than tRPC, and the reason is worth writing down: tsup externalises the packages
    // in `dependencies` and bundles everything else, and the eight optional generator packages are
    // not in `dependencies`, so their code travels inside `dist` and cannot be absent from a built
    // CLI at all. `@drzl/generator-orpc` is a real dependency, so removing it removes the module.
    //
    // This command reached `ORPCGenerator` through a static import until now, so an absent package
    // failed while the module was being evaluated: a stack trace before any action ran, with no
    // sentence naming the package.
    const { dir: home, cli: exe } = await cliWithout('@drzl/generator-orpc');
    try {
      const dir = await project('absent-legacy', null);
      const { code, stderr } = await cli(['generate:orpc', 'src/db/schema.ts'], dir, exe);
      expect(code).toBe(1);
      expect(stderr).toContain('npm install @drzl/generator-orpc');
      expect(stderr).not.toMatch(/at .*\.js:\d+/);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  }, 180_000);
});
