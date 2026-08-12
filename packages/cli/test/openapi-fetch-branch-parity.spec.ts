/**
 * `generate` and `watch` hand the openapi-fetch generator the same options, confirmed on the bytes.
 *
 * The CLI dispatches over `cfg.generators` twice, once per command, and every branch in both loops
 * assembles its own options object by hand. An option added to one is simply absent from the other,
 * and nothing says so: the config parses, the generator defaults the missing value, and the feature
 * does nothing. Four options have been found dead that way, which is why both branches here call
 * `openApiFetchOptions` instead of building the object themselves, and why this file checks that
 * they did rather than trusting that they did.
 *
 * The fixture sets `document.validationStatus: 422`. That value reaches the emitted `paths` type as
 * a response key and nowhere else, so a branch that dropped `document` would emit `400` and the byte
 * comparison would see it. It is also the option most likely to be forgotten, because it is
 * forwarded rather than derived.
 *
 * The fixture gives the validation generator a `./`-prefixed path for the reason the ts-rest parity
 * spec records: that prefix means one thing in a generator's `path` and another in
 * `validation.importPath`, and a branch copying the raw value emits a specifier resolving to nothing.
 *
 * Requires a build. CI builds before testing; locally, run `pnpm build` first.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const CLI = path.resolve(import.meta.dirname, '..', 'dist', 'cli.js');
const ROOT = path.join(import.meta.dirname, '.openapi-fetch-parity-tmp');

const SCHEMA = `
import { pgTable, integer, serial, text, varchar } from 'drizzle-orm/pg-core';
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
});
export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id').references(() => users.id),
  title: varchar('title', { length: 200 }).notNull(),
});
`;

/**
 * Every option the branch forwards, set to something other than the generator's own default, so a
 * dropped one changes the output rather than coinciding with it.
 */
const CONFIG = `export default {
  schema: './src/db/schema.ts',
  outDir: './unused-by-openapi-fetch',
  generators: [
    { kind: 'zod', path: './out/schemas' },
    {
      kind: 'openapi-fetch',
      path: './out/client',
      clientName: 'createShopClient',
      document: { validationStatus: 422 },
      outputHeader: { text: 'parity fixture' },
      format: { enabled: false },
      importExtension: 'none',
    },
  ],
};
`;

/** Every emitted file under `dir`, as a path-to-contents map. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await fs.readdir(dir)).sort()) {
    out[name] = await fs.readFile(path.join(dir, name), 'utf8');
  }
  return out;
}

let fromGenerate: Record<string, string>;
let fromWatch: Record<string, string>;
const dir = path.join(ROOT, 'parity');
const clientOut = path.join(dir, 'out', 'client');

beforeAll(async () => {
  if (!existsSync(CLI)) {
    throw new Error(`Built CLI not found at ${CLI}. Run \`pnpm build\` before \`pnpm test\`.`);
  }
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'src', 'db'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'db', 'schema.ts'), SCHEMA, 'utf8');
  await fs.writeFile(path.join(dir, 'drzl.config.ts'), CONFIG, 'utf8');

  await run(process.execPath, [CLI, 'generate'], { cwd: dir, maxBuffer: 20 * 1024 * 1024 });
  fromGenerate = await tree(clientOut);

  await fs.rm(path.join(dir, 'out'), { recursive: true, force: true });

  // `watch` builds once on start, which is the run being compared. `--poll` for the same reason
  // the other watch tests use it: inotify does not reach chokidar reliably on WSL or in Docker.
  const child = spawn(
    process.execPath,
    [CLI, 'watch', '--pipeline', 'generate-openapi-fetch', '--poll'],
    { cwd: dir, stdio: 'ignore' }
  );
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (existsSync(path.join(clientOut, 'client.ts'))) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 500));
    fromWatch = await tree(clientOut);
  } finally {
    child.kill('SIGTERM');
  }
}, 180_000);

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('the openapi-fetch branch in generate and in watch', () => {
  it('writes the same set of files', () => {
    expect(Object.keys(fromWatch)).toEqual(Object.keys(fromGenerate));
    expect(Object.keys(fromGenerate)).toEqual(['client.ts']);
  });

  it('writes the same bytes', () => {
    expect(fromWatch).toEqual(fromGenerate);
  });

  it('honoured every option the fixture set, so the comparison was not of two defaults', () => {
    const client = fromGenerate['client.ts'];
    expect(client, 'outputHeader.text').toContain('// parity fixture');
    expect(client, 'clientName').toContain('export function createShopClient');
    // The forwarded document option, which reaches the output as a response key and nowhere else.
    expect(client, 'document.validationStatus').toContain('422:');
    expect(client, 'the default status it replaces').not.toContain('400:');
    expect(client, 'the openapi-fetch import').toContain('from "openapi-fetch"');
  });

  /**
   * The derived import path, which is where the `./` prefix would go wrong.
   *
   * The sibling entry says `path: './out/schemas'`, and a `path` is project-relative while an
   * `importPath` beginning with `./` is relative to the *output* directory. Copied across raw it
   * would resolve to `out/client/out/schemas`, which does not exist.
   */
  it('derived an import path that points at the sibling generator', () => {
    expect(fromGenerate['client.ts']).toContain('"../schemas/index"');
    expect(fromGenerate['client.ts']).not.toContain('out/schemas');
  });

  it('leaves the top-level outDir alone when the generator names its own path', () => {
    expect(existsSync(path.join(dir, 'unused-by-openapi-fetch'))).toBe(false);
  });
});
