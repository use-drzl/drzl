/**
 * What the CLI says when a generator does not work, spawned as a real process.
 *
 * Ten branches answered every failure with "X generator missing. Install with: npm install
 * @drzl/generator-x", so a user whose generator was installed, resolvable and merely throwing was
 * sent to reinstall a package they already had. Both halves are proved here by execution: a
 * generator that is present and throws, and a generator that is genuinely not installed.
 *
 * Requires a build. CI builds before testing; locally, run `pnpm build` first.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs, existsSync } from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const PKG = path.resolve(__dirname, '..');
const CLI = path.join(PKG, 'dist', 'cli.js');
const ROOT = path.join(__dirname, '.genfail-tmp');

const SCHEMA = `
import { pgTable, serial, text } from 'drizzle-orm/pg-core';
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
});
`;

/** Run the CLI and hand back its streams and exit code, whether it succeeded or not. */
async function cli(argv: string[], cwd: string, exe = CLI) {
  try {
    const { stdout, stderr } = await run(process.execPath, [exe, ...argv], {
      cwd,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (e: any) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

async function project(name: string, config: string) {
  const dir = path.join(ROOT, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'src', 'db'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'db', 'schema.ts'), SCHEMA, 'utf8');
  await fs.writeFile(path.join(dir, 'drzl.config.ts'), config, 'utf8');
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

/**
 * A copy of the built CLI outside this repository, with a node_modules holding every direct
 * dependency of `@drzl/cli` except `omit`.
 *
 * A physical copy rather than a symlink because Node resolves from a file's real path, and outside
 * the repository because the resolver walks upwards: run from anywhere under `packages/`, the
 * omitted package is found again one directory up and stops being absent. Everything else is
 * symlinked straight at what pnpm already installed, so the CLI that runs here is the same build,
 * loading the same generators, with one package genuinely not there.
 */
async function cliWithout(omit: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-nogen-'));
  const dist = path.join(dir, 'dist');
  await fs.cp(path.join(PKG, 'dist'), dist, { recursive: true });
  // The CLI reads its version from the manifest beside its build and refuses to start without it.
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

describe('a generator that is installed and throws', () => {
  it('reports its own error rather than sending the user to reinstall it', async () => {
    // `out` is a file, so the generator's `mkdir(out/zod)` fails with ENOTDIR. A real failure
    // from inside a generator that imported perfectly well, which is the case the old catch
    // could not distinguish.
    const dir = await project(
      'zod-throws',
      `export default {
         schema: './src/db/schema.ts',
         outDir: './api',
         generators: [{ kind: 'zod', path: './out/zod' }],
       };`
    );
    await fs.writeFile(path.join(dir, 'out'), 'not a directory', 'utf8');

    const { code, stderr } = await cli(['generate'], dir);
    expect(code).not.toBe(0);
    expect(stderr).toContain('ENOTDIR');
    expect(stderr).not.toContain('npm install @drzl/generator-zod');
    expect(stderr).not.toMatch(/generator missing|is not installed/i);
  }, 120_000);

  it('names the generator that failed, so a multi-generator config says which one', async () => {
    const dir = await project(
      'typebox-throws',
      `export default {
         schema: './src/db/schema.ts',
         outDir: './api',
         generators: [{ kind: 'typebox', path: './out/typebox' }],
       };`
    );
    await fs.writeFile(path.join(dir, 'out'), 'not a directory', 'utf8');

    const { code, stderr } = await cli(['generate'], dir);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/typebox/i);
    expect(stderr).toContain('ENOTDIR');
    expect(stderr).not.toContain('npm install @drzl/generator-typebox');
  }, 120_000);
});

describe('a generator that is genuinely not installed', () => {
  it('still says which package to install', async () => {
    const { dir: home, cli: exe } = await cliWithout('@drzl/generator-typebox');
    try {
      const dir = await project(
        'typebox-absent',
        `export default {
           schema: './src/db/schema.ts',
           outDir: './api',
           generators: [{ kind: 'typebox', path: './out/typebox' }],
         };`
      );
      const { code, stderr } = await cli(['generate'], dir, exe);
      expect(code).not.toBe(0);
      expect(stderr).toContain('npm install @drzl/generator-typebox');
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  }, 120_000);

  it('is a real absence: the same copy runs a generator it does have', async () => {
    // Without this the test above proves nothing about the copy being usable at all, and would
    // pass just as happily against a CLI that failed at startup for an unrelated reason.
    const { dir: home, cli: exe } = await cliWithout('@drzl/generator-typebox');
    try {
      const dir = await project(
        'zod-present',
        `export default {
           schema: './src/db/schema.ts',
           outDir: './api',
           generators: [{ kind: 'zod', path: './out/zod' }],
         };`
      );
      const { code } = await cli(['generate'], dir, exe);
      expect(code).toBe(0);
      expect(existsSync(path.join(dir, 'out', 'zod', 'users.zod.ts'))).toBe(true);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  }, 120_000);
});
