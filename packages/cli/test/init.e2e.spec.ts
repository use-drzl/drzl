/**
 * End-to-end coverage for `drzl init`, spawned as a real process (items 65, 66, 67).
 *
 * `init` is the first command a new user runs, and three things about it were wrong at once:
 *
 *   - it advertised `-y, --yes` and then ignored the flag entirely, so the promise of an
 *     interactive command was made in `--help` and never kept (65);
 *   - it scaffolded a single `orpc` generator, which is not what the packages, the READMEs, the
 *     quickstarts or the one example app steer anyone toward (66);
 *   - it hardcoded `schema: 'src/db/schema.ts'` whether or not that file existed. A config
 *     naming a file that is not there is not an inert mistake: `drzl generate` analyzed nothing,
 *     wrote `placeholder.orpc.ts` and exited 0, so the first run of the product reported success
 *     having read no schema at all (67).
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
const ROOT = path.join(__dirname, '.tmp-init-e2e');

const SCHEMA = `
import { pgTable, serial, text } from 'drizzle-orm/pg-core';
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
});
`;

/** A project directory with nothing in it. Lives under this package so drizzle-orm resolves. */
async function bare(name: string) {
  const dir = path.join(ROOT, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** A project with a schema at a given path, relative to its root. */
async function project(name: string, schemaAt = 'src/db/schema.ts', body = SCHEMA) {
  const dir = await bare(name);
  const full = path.join(dir, schemaAt);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body, 'utf8');
  return dir;
}

/** The `schema` value the scaffolded config states, or undefined when it states none. */
function scaffoldedSchema(config: string): string | undefined {
  // Anchored at the start of a line so a commented-out `// schema:` example is not read as one.
  return config.match(/^\s{2}schema:\s*['"]([^'"]+)['"]/m)?.[1];
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

describe('drzl init: the config it writes', () => {
  it('writes a config, and that config actually runs', async () => {
    const dir = await project('runs');
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

    // The config `init` writes has to be one `generate` accepts, and it has to reach the tables.
    // Scaffolding something that then fails is worse than scaffolding nothing, and scaffolding
    // something that succeeds over an empty analysis is worse than either.
    await run(process.execPath, [CLI, 'generate'], { cwd: dir, maxBuffer: 20 * 1024 * 1024 });
    expect(existsSync(path.join(dir, 'src', 'validators', 'zod', 'users.zod.ts'))).toBe(true);
    expect(existsSync(path.join(dir, 'src', 'validators', 'zod', 'index.ts'))).toBe(true);
  }, 120_000);

  it('defaults to a validator generator, not a router (66)', async () => {
    const dir = await project('default-generator');
    await run(process.execPath, [CLI, 'init'], { cwd: dir });
    const config = await fs.readFile(path.join(dir, 'drzl.config.ts'), 'utf8');

    // Not a style preference. `@drzl/generator-zod` is a hard dependency of `@drzl/cli`, so it
    // is installed by definition next to the CLI that scaffolded this; six of the seven route
    // generators are `optionalDependencies`, and five of those are still at 0.1.0. Both READMEs
    // lead their minimal config with zod, all three quickstarts put a validator first, and the
    // only example app in the repository configures zod and nothing else.
    expect(config).toContain("kind: 'zod'");
  }, 60_000);

  it('generates real output from the default scaffold, not a no-tables placeholder', async () => {
    const dir = await project('real-output');
    await run(process.execPath, [CLI, 'init'], { cwd: dir });
    await run(process.execPath, [CLI, 'generate'], { cwd: dir, maxBuffer: 20 * 1024 * 1024 });

    // The whole point of 67. A config pointing at a file that is not there analyzed zero tables
    // and every generator emitted its "no tables detected" placeholder, which `generate` then
    // reported as success.
    const written: string[] = [];
    async function walk(d: string) {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else written.push(path.relative(dir, full));
      }
    }
    await walk(dir);
    expect(written.some((f) => f.includes('placeholder'))).toBe(false);
    expect(written.some((f) => f.includes('users'))).toBe(true);
  }, 120_000);
});

describe('drzl init: finding the schema (67)', () => {
  it('finds a conventional schema path and names it', async () => {
    const dir = await project('conventional');
    await run(process.execPath, [CLI, 'init'], { cwd: dir });
    const config = await fs.readFile(path.join(dir, 'drzl.config.ts'), 'utf8');
    const schema = scaffoldedSchema(config);
    expect(schema).toBe('src/db/schema.ts');
    expect(existsSync(path.join(dir, schema!))).toBe(true);
  }, 60_000);

  it('finds a conventional schema that is not the hardcoded one', async () => {
    const dir = await project('conventional-alt', 'src/lib/db/schema.ts');
    await run(process.execPath, [CLI, 'init'], { cwd: dir });
    const config = await fs.readFile(path.join(dir, 'drzl.config.ts'), 'utf8');
    const schema = scaffoldedSchema(config);
    expect(schema).toBe('src/lib/db/schema.ts');
    expect(existsSync(path.join(dir, schema!))).toBe(true);
  }, 60_000);

  it('reads the schema from a drizzle-kit config, wherever that puts it', async () => {
    // Deliberately a path no convention would guess, so only reading `drizzle.config.ts` can
    // find it. This is the reuse item 59 built and item 67 asks for.
    const dir = await project('kit', 'db/tables/all.ts');
    await fs.writeFile(
      path.join(dir, 'drizzle.config.ts'),
      `export default { dialect: 'postgresql', schema: './db/tables/*.ts', out: './drizzle' };\n`,
      'utf8'
    );
    await run(process.execPath, [CLI, 'init'], { cwd: dir });

    // Whatever it writes, `generate` has to reach the tables. That is the only claim that
    // matters, and it fails outright on a config naming a file that is not there.
    const { stdout } = await run(process.execPath, [CLI, 'generate'], {
      cwd: dir,
      maxBuffer: 20 * 1024 * 1024,
    });
    expect(stdout).not.toContain('placeholder');
    const config = await fs.readFile(path.join(dir, 'drzl.config.ts'), 'utf8');
    const schema = scaffoldedSchema(config);
    // Either it states a path that exists, or it states none and lets the drizzle-kit fallback
    // answer. What it must not do is state one that is not there.
    if (schema) expect(existsSync(path.join(dir, schema))).toBe(true);
  }, 120_000);

  it('never writes a config naming a schema file that does not exist', async () => {
    const dir = await bare('no-schema');
    await run(process.execPath, [CLI, 'init'], { cwd: dir });
    const config = await fs.readFile(path.join(dir, 'drzl.config.ts'), 'utf8');
    const schema = scaffoldedSchema(config);
    if (schema !== undefined) {
      expect(existsSync(path.join(dir, schema)), `config names ${schema}, which is not there`).toBe(
        true
      );
    }
  }, 60_000);

  it('does not adopt a schema file that exports no drizzle tables', async () => {
    // Existence is not the test. A `src/db/schema.ts` that exports a connection string, or that
    // a user created empty five minutes ago, produces a config that analyzes nothing and a
    // `generate` that reports success over an empty analysis.
    const dir = await project('empty-schema', 'src/db/schema.ts', 'export const DATABASE = 1;\n');
    await run(process.execPath, [CLI, 'init'], { cwd: dir });
    const config = await fs.readFile(path.join(dir, 'drzl.config.ts'), 'utf8');
    expect(scaffoldedSchema(config)).toBeUndefined();
  }, 60_000);
});

describe('drzl init: non-interactive is first-class (65)', () => {
  it('writes without asking anything when stdin is not a TTY', async () => {
    const dir = await project('non-tty');
    // execFile gives the child a pipe for stdin and closes nothing: if `init` ever waits for
    // input here, this rejects on the vitest timeout rather than passing.
    await run(process.execPath, [CLI, 'init'], { cwd: dir, timeout: 20_000 });
    expect(existsSync(path.join(dir, 'drzl.config.ts'))).toBe(true);
  }, 40_000);

  it('does not hang when stdin is a pipe that stays open', async () => {
    const dir = await project('open-pipe');
    const child = spawn(process.execPath, [CLI, 'init'], {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Nothing is ever written to the pipe and it is never ended. A prompt reading this stdin
    // waits for ever, which is the CI hang this command must not have.
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('drzl init hung on an open stdin pipe'));
      }, 20_000);
      child.on('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    expect(code).toBe(0);
    expect(existsSync(path.join(dir, 'drzl.config.ts'))).toBe(true);
  }, 40_000);

  it('answers both prompts from flags, and the result generates', async () => {
    // The flags are the non-interactive half of the prompts, and they are the only way a CI job
    // or an agent can choose anything other than the default. Both are exercised through
    // commander here rather than through the functions the unit tests call.
    const dir = await project('flags', 'src/database/tables.ts');
    await run(
      process.execPath,
      [CLI, 'init', '--schema', 'src/database/tables.ts', '--generators', 'zod,orpc'],
      { cwd: dir }
    );
    const config = await fs.readFile(path.join(dir, 'drzl.config.ts'), 'utf8');
    expect(scaffoldedSchema(config)).toBe('src/database/tables.ts');
    expect(config).toContain("kind: 'zod'");
    expect(config).toContain("kind: 'orpc'");

    await run(process.execPath, [CLI, 'generate'], { cwd: dir, maxBuffer: 20 * 1024 * 1024 });
    expect(existsSync(path.join(dir, 'src', 'validators', 'zod', 'users.zod.ts'))).toBe(true);
    expect(existsSync(path.join(dir, 'src', 'api', 'users.ts'))).toBe(true);
  }, 120_000);

  it('refuses a generator it cannot scaffold, and writes nothing', async () => {
    const dir = await project('flags-bad');
    const failed = await run(process.execPath, [CLI, 'init', '--generators', 'hono'], {
      cwd: dir,
    }).catch((e) => e);
    expect(failed.code).toBe(1);
    expect(existsSync(path.join(dir, 'drzl.config.ts'))).toBe(false);
    expect(`${failed.stdout ?? ''}${failed.stderr ?? ''}`).toContain('hono');
  }, 60_000);

  it('accepts --yes and writes the same config the bare command does', async () => {
    const plain = await project('yes-plain');
    const flagged = await project('yes-flagged');
    await run(process.execPath, [CLI, 'init'], { cwd: plain });
    await run(process.execPath, [CLI, 'init', '--yes'], { cwd: flagged });
    const a = await fs.readFile(path.join(plain, 'drzl.config.ts'), 'utf8');
    const b = await fs.readFile(path.join(flagged, 'drzl.config.ts'), 'utf8');
    expect(b).toBe(a);
  }, 60_000);
});

describe('drzl init: an existing config', () => {
  it('refuses to overwrite one, and says so in words', async () => {
    const dir = await project('existing');
    const target = path.join(dir, 'drzl.config.ts');
    await fs.writeFile(target, '// mine\n', 'utf8');

    const failed = await run(process.execPath, [CLI, 'init'], { cwd: dir }).catch((e) => e);
    expect(failed.code).toBe(1);
    // The file is untouched. That part has always held; the message was a raw Node errno string
    // ("EEXIST: file already exists, open ..."), which names no command and suggests nothing.
    expect(await fs.readFile(target, 'utf8')).toBe('// mine\n');
    const said = `${failed.stdout ?? ''}${failed.stderr ?? ''}`;
    expect(said).toContain('drzl.config.ts');
    expect(said).not.toContain('EEXIST');
  }, 60_000);

  it('will not write a .ts scaffold that shadows a config in another format', async () => {
    // Not overwriting is only half of "never clobber". `loadConfig` tries the five config names
    // in a fixed order with `.ts` first, so a `drzl.config.ts` written beside a
    // `drzl.config.json` leaves that file byte-identical and makes the next `drzl generate` run
    // the scaffold instead of it. Measured on 4.22.0: `init` wrote the file and exited 0.
    const dir = await project('shadowing');
    await fs.writeFile(
      path.join(dir, 'drzl.config.json'),
      `{ "schema": "src/db/schema.ts", "generators": [{ "kind": "valibot" }] }\n`,
      'utf8'
    );

    const failed = await run(process.execPath, [CLI, 'init'], { cwd: dir }).catch((e) => e);
    expect(failed.code).toBe(1);
    expect(existsSync(path.join(dir, 'drzl.config.ts'))).toBe(false);
    expect(`${failed.stdout ?? ''}${failed.stderr ?? ''}`).toContain('drzl.config.json');
  }, 60_000);
});
