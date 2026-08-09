/**
 * What the CLI says when the input is broken (plan items 70, 71, 78, 79).
 *
 * All four are defects, and all four were measured on the built CLI before a line was changed:
 *
 * | input                                   | exit | stdout                  | stderr        |
 * | --------------------------------------- | ---- | ----------------------- | ------------- |
 * | schema module throws on import          | 0    | the barrel path         | green tick    |
 * | schema imports a package not installed  | 0    | the barrel path         | green tick    |
 * | schema has a syntax error               | 0    | the barrel path         | green tick    |
 * | `schema` names a file that is not there | 0    | the barrel path         | green tick    |
 * | schema exports no tables                | 0    | the barrel path         | green tick    |
 * | config key of the wrong type            | 1    | (empty)                 | a JSON array  |
 * | misspelled key at the root              | 0    | generated               | (silence)     |
 * | misspelled key in a generator entry     | 0    | generated               | (silence)     |
 * | misspelled key in a nested object       | 0    | generated               | (silence)     |
 *
 * The barrel in every row above is an `index.ts` holding three comment lines and no exports,
 * which is the file item 70 was filed about.
 *
 * Every assertion here is on the exact stream and the exact exit code, per `docs/cli/output.md`,
 * and on the sentences themselves. Pinning the sentence is the point: a message that stops naming
 * the schema file, or stops naming the offending config key, is the regression that matters, and
 * an assertion on the exit code alone would not see it.
 *
 * Requires a build. CI builds before testing; locally, run `pnpm build` first.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';

const CLI = path.resolve(__dirname, '..', 'dist', 'cli.js');
const ROOT = path.join(__dirname, '.tmp-errors');

interface Run {
  code: number;
  out: string;
  err: string;
}

/**
 * Run the built CLI with the two streams on separate pipes.
 *
 * `FORCE_COLOR` and `NO_COLOR` are stripped from the inherited environment rather than trusted:
 * the shell this was developed in exports `FORCE_COLOR=3`, which puts escape sequences around
 * every message here and makes a `toContain` on a plain sentence fail for a reason that has
 * nothing to do with the sentence.
 */
function run(args: string[], cwd: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of ['CI', 'NO_COLOR', 'FORCE_COLOR']) delete env[key];
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += String(c)));
    child.stderr.on('data', (c) => (err += String(c)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, out, err }));
  });
}

const GOOD_SCHEMA = `
import { pgTable, serial, text } from 'drizzle-orm/pg-core';
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
});
`;

/**
 * A project directory holding one schema and one config.
 *
 * Under this package, so the schema's `drizzle-orm` import resolves by the ordinary node_modules
 * walk. A directory in the system temp resolves nothing.
 */
async function project(name: string, schema: string, config: string) {
  const dir = path.join(ROOT, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'schema.ts'), schema, 'utf8');
  await fs.writeFile(path.join(dir, 'drzl.config.ts'), config, 'utf8');
  return dir;
}

const ZOD_CONFIG = `export default {
  schema: './schema.ts',
  generators: [{ kind: 'zod', path: './out' }],
};`;

beforeAll(async () => {
  if (!existsSync(CLI)) {
    throw new Error(`Built CLI not found at ${CLI}. Run \`pnpm build\` before \`pnpm test\`.`);
  }
  await fs.mkdir(ROOT, { recursive: true });
}, 60_000);

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

// -------------------------------------------------------------------------------------------
// Item 70: the schema module failed to load
// -------------------------------------------------------------------------------------------

describe('generate: the schema module fails to load (item 70)', () => {
  it('refuses a module that throws on import, names it, and writes nothing', async () => {
    const dir = await project(
      'throws',
      `throw new Error('boom from schema module');\nexport const x = 1;\n`,
      ZOD_CONFIG
    );
    const r = await run(['generate'], dir);

    expect(r.code).toBe(1);
    // The whole of item 70: this run used to write `out/index.ts`, a barrel with no exports,
    // and exit 0.
    expect(existsSync(path.join(dir, 'out'))).toBe(false);
    expect(r.out).toBe('');
    expect(r.err).toContain('Could not load the schema module ./schema.ts (DRZL_SCHEMA_001):');
    expect(r.err).toContain('boom from schema module');
    // Not the "loaded fine and had nothing in it" sentence. The two causes have different fixes.
    expect(r.err).not.toContain('DRZL_SCHEMA_002');
  }, 120_000);

  it('names the module a schema could not import', async () => {
    const dir = await project(
      'missing-package',
      `import { thing } from 'no-such-package-xyz';\nexport const x = thing;\n`,
      ZOD_CONFIG
    );
    const r = await run(['generate'], dir);

    expect(r.code).toBe(1);
    expect(r.err).toContain('Could not load the schema module ./schema.ts (DRZL_SCHEMA_001):');
    expect(r.err).toContain('no-such-package-xyz');
    expect(existsSync(path.join(dir, 'out'))).toBe(false);
  }, 120_000);

  it('refuses a schema that does not parse', async () => {
    const dir = await project(
      'syntax',
      `import { pgTable, text } from 'drizzle-orm/pg-core';\nexport const users = pgTable('users', { id: text('id') \n`,
      ZOD_CONFIG
    );
    const r = await run(['generate'], dir);

    expect(r.code).toBe(1);
    expect(r.err).toContain('Could not load the schema module ./schema.ts (DRZL_SCHEMA_001):');
    expect(existsSync(path.join(dir, 'out'))).toBe(false);
  }, 120_000);

  it('refuses a config whose schema path does not exist', async () => {
    const dir = await project(
      'no-file',
      GOOD_SCHEMA,
      ZOD_CONFIG.replace('./schema.ts', './nope.ts')
    );
    const r = await run(['generate'], dir);

    expect(r.code).toBe(1);
    expect(r.err).toContain('./nope.ts');
    expect(r.err).toContain('DRZL_SCHEMA_001');
    expect(existsSync(path.join(dir, 'out'))).toBe(false);
  }, 120_000);

  it('reports the failure as the one JSON document under --json', async () => {
    const dir = await project(
      'throws-json',
      `throw new Error('boom from schema module');\nexport const x = 1;\n`,
      ZOD_CONFIG
    );
    const r = await run(['generate', '--json'], dir);

    expect(r.code).toBe(1);
    expect(r.err).toBe('');
    const doc = JSON.parse(r.out);
    expect(doc).toMatchObject({
      ok: false,
      command: 'generate',
      code: 'DRZL_SCHEMA_001',
      exitCode: 1,
    });
    expect(doc.message).toContain('./schema.ts');
  }, 120_000);

  it('still prints the failure under --quiet', async () => {
    const dir = await project(
      'throws-quiet',
      `throw new Error('boom from schema module');\nexport const x = 1;\n`,
      ZOD_CONFIG
    );
    const r = await run(['generate', '--quiet'], dir);

    expect(r.code).toBe(1);
    expect(r.err).toContain('DRZL_SCHEMA_001');
    expect(r.err).toContain('./schema.ts');
  }, 120_000);
});

// -------------------------------------------------------------------------------------------
// Item 71: the module loaded and had nothing in it
// -------------------------------------------------------------------------------------------

describe('generate: zero tables (item 71)', () => {
  it('refuses a schema that exports no tables, with its own sentence', async () => {
    const dir = await project('empty', `export {};\n`, ZOD_CONFIG);
    const r = await run(['generate'], dir);

    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    // This exact run printed a green tick and exited 0, having written only `index.ts`.
    expect(existsSync(path.join(dir, 'out', 'index.ts'))).toBe(false);
    expect(r.err).toContain('No Drizzle tables found in ./schema.ts (DRZL_SCHEMA_002).');
    // Distinguished from item 70: this module loaded perfectly well.
    expect(r.err).not.toContain('DRZL_SCHEMA_001');
    expect(r.err).not.toContain('Could not load');
  }, 120_000);

  it('refuses a module that exports things that are not tables', async () => {
    const dir = await project(
      'not-tables',
      `export const helper = (a: number) => a + 1;\nexport const NAMES = ['a'];\n`,
      ZOD_CONFIG
    );
    const r = await run(['generate'], dir);

    expect(r.code).toBe(1);
    expect(r.err).toContain('DRZL_SCHEMA_002');
    expect(existsSync(path.join(dir, 'out'))).toBe(false);
  }, 120_000);

  it('says so when the table filter, not the schema, is what emptied the run', async () => {
    const dir = await project(
      'filtered-empty',
      GOOD_SCHEMA,
      `export default {
         schema: './schema.ts',
         include: ['nosuchtable'],
         generators: [{ kind: 'zod', path: './out' }],
       };`
    );
    const r = await run(['generate'], dir);

    expect(r.code).toBe(1);
    expect(r.err).toContain('DRZL_SCHEMA_003');
    // Names the filter as the cause and the tables that were there, since the schema is fine.
    expect(r.err).toContain('users');
    expect(existsSync(path.join(dir, 'out'))).toBe(false);
  }, 120_000);

  it('fails `--check` rather than reporting an up-to-date tree', async () => {
    const dir = await project('empty-check', `export {};\n`, ZOD_CONFIG);
    const r = await run(['generate', '--check'], dir);

    // 1, not 0 and not 2. Nothing was checked, because nothing could be generated.
    expect(r.code).toBe(1);
    expect(r.err).toContain('DRZL_SCHEMA_002');
  }, 120_000);

  it('refuses to write a placeholder from generate:orpc', async () => {
    const dir = await project('orpc-empty', `export {};\n`, ZOD_CONFIG);
    const r = await run(['generate:orpc', './schema.ts', '--outDir', './out'], dir);

    expect(r.code).toBe(1);
    expect(r.err).toContain('DRZL_SCHEMA_002');
    // `placeholder.orpc.ts`, reading "No tables detected in analysis", is what used to be written
    // here with an exit code of 0.
    expect(existsSync(path.join(dir, 'out'))).toBe(false);
  }, 120_000);

  it('reports zero tables as the JSON failure document', async () => {
    const dir = await project('empty-json', `export {};\n`, ZOD_CONFIG);
    const r = await run(['generate', '--json'], dir);

    expect(r.code).toBe(1);
    expect(r.err).toBe('');
    expect(JSON.parse(r.out)).toMatchObject({
      ok: false,
      command: 'generate',
      code: 'DRZL_SCHEMA_002',
      exitCode: 1,
    });
  }, 120_000);
});

describe('watch: an empty schema does not kill the watcher (item 71)', () => {
  it('reports the empty schema, keeps watching, and generates once a table appears', async () => {
    const dir = await project('watch-empty', `export {};\n`, ZOD_CONFIG);
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of ['CI', 'NO_COLOR', 'FORCE_COLOR']) delete env[key];
    // `--poll` for the reason `commands.e2e.spec.ts` records: filesystem events do not reach
    // chokidar reliably on WSL, Docker or a network mount, and a test that depends on inotify
    // reports the environment rather than the product.
    const child = spawn(process.execPath, [CLI, 'watch', '--debounce', '50', '--poll'], {
      cwd: dir,
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (c) => (err += String(c)));

    try {
      await waitFor(() => err.includes('DRZL_SCHEMA_002'), 30_000, 'the empty-schema report');
      // The watcher is still alive: the process has not exited, and the next save fixes it.
      expect(child.exitCode).toBe(null);

      await new Promise((r) => setTimeout(r, 1000));
      await fs.writeFile(path.join(dir, 'schema.ts'), GOOD_SCHEMA, 'utf8');

      await waitFor(
        () => existsSync(path.join(dir, 'out', 'users.zod.ts')),
        60_000,
        'regeneration after a table was added'
      );
    } finally {
      child.kill('SIGTERM');
    }
  }, 180_000);
});

// -------------------------------------------------------------------------------------------
// Item 78: a config error names the key
// -------------------------------------------------------------------------------------------

describe('config validation names the key path (item 78)', () => {
  it('names a wrong-typed top-level key and shows what it found', async () => {
    const dir = await project(
      'cfg-type',
      GOOD_SCHEMA,
      `export default {
         schema: './schema.ts',
         outDir: 123,
         generators: [{ kind: 'zod', path: './out' }],
       };`
    );
    const r = await run(['generate'], dir);

    expect(r.code).toBe(1);
    expect(r.err).toContain('drzl.config.ts is not valid (DRZL_CFG_002)');
    expect(r.err).toContain('outDir: expected string, received number (found 123)');
    // The raw zod dump is what this replaces: a formatted JSON array of issue objects.
    expect(r.err).not.toContain('"code": "invalid_type"');
  }, 120_000);

  it('renders a nested path as a reader would write it', async () => {
    const dir = await project(
      'cfg-nested-path',
      GOOD_SCHEMA,
      `export default {
         schema: './schema.ts',
         generators: [
           { kind: 'zod', path: './out' },
           { kind: 'orpc', validation: { library: 'nope' } },
         ],
       };`
    );
    const r = await run(['generate'], dir);

    expect(r.code).toBe(1);
    expect(r.err).toContain('generators[1].validation.library:');
  }, 120_000);

  it('names every problem, not just the first', async () => {
    const dir = await project(
      'cfg-many',
      GOOD_SCHEMA,
      `export default {
         schema: 42,
         outDir: 123,
         generators: [{ kind: 'zod', path: 7, nestedDepth: 'deep' }],
       };`
    );
    const r = await run(['generate'], dir);

    expect(r.code).toBe(1);
    expect(r.err).toContain('4 problems');
    expect(r.err).toContain('schema:');
    expect(r.err).toContain('outDir:');
    expect(r.err).toContain('generators[0].path:');
    expect(r.err).toContain('generators[0].nestedDepth:');
  }, 120_000);

  it('gives a key path and a suggestion to a strict object zod already rejects', async () => {
    const dir = await project(
      'cfg-strict',
      GOOD_SCHEMA,
      `export default {
         schema: './schema.ts',
         columns: { users: { ommit: ['email'] } },
         generators: [{ kind: 'zod', path: './out' }],
       };`
    );
    const r = await run(['generate'], dir);

    expect(r.code).toBe(1);
    expect(r.err).toContain('columns.users: unrecognized key "ommit"');
    expect(r.err).toContain('Did you mean "omit"?');
  }, 120_000);

  it('carries the same sentence into the JSON failure document', async () => {
    const dir = await project(
      'cfg-type-json',
      GOOD_SCHEMA,
      `export default {
         schema: './schema.ts',
         outDir: 123,
         generators: [{ kind: 'zod', path: './out' }],
       };`
    );
    const r = await run(['generate', '--json'], dir);

    expect(r.code).toBe(1);
    expect(r.err).toBe('');
    const doc = JSON.parse(r.out);
    expect(doc).toMatchObject({
      ok: false,
      command: 'generate',
      code: 'DRZL_CFG_002',
      exitCode: 1,
    });
    expect(doc.message).toContain('outDir: expected string, received number (found 123)');
  }, 120_000);
});

// -------------------------------------------------------------------------------------------
// Item 79: an unknown key is a warning, not silence
// -------------------------------------------------------------------------------------------

describe('an unknown config key warns (item 79)', () => {
  it('warns about a misspelled key at the root and still generates', async () => {
    const dir = await project(
      'unknown-root',
      GOOD_SCHEMA,
      `export default {
         schema: './schema.ts',
         outDirr: 'src/api',
         generators: [{ kind: 'zod', path: './out' }],
       };`
    );
    const r = await run(['generate'], dir);

    expect(r.code).toBe(0);
    expect(r.err).toContain('drzl config: unknown key "outDirr" at the top level; it is ignored.');
    expect(r.err).toContain('Did you mean "outDir"?');
    expect(existsSync(path.join(dir, 'out', 'users.zod.ts'))).toBe(true);
  }, 120_000);

  it('warns about a misspelled key inside a generator entry', async () => {
    const dir = await project(
      'unknown-generator',
      GOOD_SCHEMA,
      `export default {
         schema: './schema.ts',
         generators: [{ kind: 'zod', path: './out', typedJsn: true }],
       };`
    );
    const r = await run(['generate'], dir);

    expect(r.code).toBe(0);
    expect(r.err).toContain('drzl config: unknown key "typedJsn" in generators[0]; it is ignored.');
    expect(r.err).toContain('Did you mean "typedJson"?');
  }, 120_000);

  it('warns about a misspelled key inside a nested object', async () => {
    const dir = await project(
      'unknown-nested',
      GOOD_SCHEMA,
      `export default {
         schema: './schema.ts',
         generators: [{ kind: 'orpc', validation: { useShared: true, librari: 'zod' } }],
       };`
    );
    const r = await run(['generate'], dir);

    expect(r.code).toBe(0);
    expect(r.err).toContain(
      'drzl config: unknown key "librari" in generators[0].validation; it is ignored.'
    );
    expect(r.err).toContain('Did you mean "library"?');
  }, 120_000);

  it('says nothing about keys the schema deliberately accepts', async () => {
    const dir = await project(
      'unknown-none',
      GOOD_SCHEMA,
      // Three keys nothing may warn about: `$schema`, which an editor needs and the config schema
      // declares for that reason; a `columns` key, which is a table pattern rather than a name the
      // schema knows; and `templateOptions`, whose keys belong to whichever template reads them.
      `export default {
         $schema: './drzl.config.schema.json',
         schema: './schema.ts',
         columns: { 'us*': { omit: ['email'] } },
         generators: [
           { kind: 'zod', path: './out' },
           { kind: 'orpc', templateOptions: { whateverKey: 1, another: 'x' } },
         ],
       };`
    );
    const r = await run(['generate'], dir);

    expect(r.code).toBe(0);
    expect(r.err).not.toContain('unknown key');
  }, 120_000);

  it('puts the warning in the document under --json and nothing on stderr', async () => {
    const dir = await project(
      'unknown-json',
      GOOD_SCHEMA,
      `export default {
         schema: './schema.ts',
         outDirr: 'src/api',
         generators: [{ kind: 'zod', path: './out' }],
       };`
    );
    const r = await run(['generate', '--json'], dir);

    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    const doc = JSON.parse(r.out);
    expect(doc.warnings.join('\n')).toContain('unknown key "outDirr"');
  }, 120_000);

  it('drops the warning under --quiet, and still exits 0', async () => {
    const dir = await project(
      'unknown-quiet',
      GOOD_SCHEMA,
      `export default {
         schema: './schema.ts',
         outDirr: 'src/api',
         generators: [{ kind: 'zod', path: './out' }],
       };`
    );
    const r = await run(['generate', '--quiet'], dir);

    expect(r.code).toBe(0);
    expect(r.err).toBe('');
  }, 120_000);
});

/** Poll until `check` holds, or fail naming what was being waited for. */
async function waitFor(check: () => boolean, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
}
