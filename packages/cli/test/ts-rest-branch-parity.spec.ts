/**
 * `generate` and `watch` hand the ts-rest generator the same options, confirmed on the bytes.
 *
 * The CLI dispatches over `cfg.generators` twice, once per command, and every branch in both loops
 * assembles its own options object by hand. An option added to one is simply absent from the other,
 * and nothing says so: the config parses, the generator defaults the missing value, and the feature
 * does nothing. Four options have been found dead that way, which is why both branches here call
 * `tsRestOptions` instead of building the object themselves, and why this file checks that they did
 * rather than trusting that they did.
 *
 * The fixture runs arktype on purpose. It is the library whose optional query parameters are spelled
 * on the *key* rather than around the value, so a branch that dropped `validation` would emit zod
 * spellings and the byte comparison would see it.
 *
 * The fixture also gives the validation generator a `./`-prefixed path. That prefix means one thing
 * in a generator's `path` and another in `validation.importPath`, and the builder strips it; a
 * branch that copied the raw value would emit a specifier resolving to nothing.
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
const ROOT = path.join(import.meta.dirname, '.ts-rest-parity-tmp');

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
 * Every option the ts-rest branch forwards, set to something other than the generator's own default,
 * so a dropped one changes the output rather than coinciding with it.
 */
const CONFIG = `export default {
  schema: './src/db/schema.ts',
  outDir: './unused-by-ts-rest',
  generators: [
    { kind: 'arktype', path: './out/schemas' },
    {
      kind: 'ts-rest',
      path: './out/contract',
      contractName: 'shopContract',
      pathPrefix: '/api/v1',
      naming: { routerSuffix: 'Api', procedureCase: 'snake' },
      outputHeader: { text: 'parity fixture' },
      format: { enabled: false },
      importExtension: 'none',
      validation: { library: 'arktype' },
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
const contractOut = path.join(dir, 'out', 'contract');

beforeAll(async () => {
  if (!existsSync(CLI)) {
    throw new Error(`Built CLI not found at ${CLI}. Run \`pnpm build\` before \`pnpm test\`.`);
  }
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'src', 'db'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'db', 'schema.ts'), SCHEMA, 'utf8');
  await fs.writeFile(path.join(dir, 'drzl.config.ts'), CONFIG, 'utf8');

  await run(process.execPath, [CLI, 'generate'], { cwd: dir, maxBuffer: 20 * 1024 * 1024 });
  fromGenerate = await tree(contractOut);

  await fs.rm(path.join(dir, 'out'), { recursive: true, force: true });

  // `watch` builds once on start, which is the run being compared. `--poll` for the same reason
  // the other watch tests use it: inotify does not reach chokidar reliably on WSL or in Docker.
  const child = spawn(
    process.execPath,
    [CLI, 'watch', '--pipeline', 'generate-ts-rest', '--poll'],
    { cwd: dir, stdio: 'ignore' }
  );
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (existsSync(path.join(contractOut, 'index.ts'))) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    // A short settle, so a file half-written when index.ts appeared is complete before it is read.
    await new Promise((r) => setTimeout(r, 500));
    fromWatch = await tree(contractOut);
  } finally {
    child.kill('SIGTERM');
  }
}, 180_000);

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('the ts-rest branch in generate and in watch', () => {
  it('writes the same set of files', () => {
    expect(Object.keys(fromWatch)).toEqual(Object.keys(fromGenerate));
    expect(Object.keys(fromGenerate)).toEqual(['index.ts', 'posts_api.ts', 'users_api.ts']);
  });

  it('writes the same bytes', () => {
    expect(fromWatch).toEqual(fromGenerate);
  });

  it('honoured every option the fixture set, so the comparison was not of two defaults', () => {
    const contract = fromGenerate['users_api.ts'];
    expect(contract, 'outputHeader.text').toContain('// parity fixture');
    expect(contract, 'validation.library').toContain("import { type } from 'arktype';");
    // arktype marks an optional key rather than wrapping the value, which zod would not produce.
    // Quoted either way here: this fixture sets `format.enabled: false`, so the emitted double
    // quotes survive, where a formatted tree would have been rewritten to single ones.
    expect(contract, 'the arktype optional-key spelling').toMatch(/["']limit\?["']/);
    // format.enabled false, so nothing rewrote the quotes above and made those checks vacuous.
    expect(contract, 'the ts-rest import').toContain("from '@ts-rest/core'");

    const barrel = fromGenerate['index.ts'];
    expect(barrel, 'contractName').toContain('export const shopContract');
    expect(barrel, 'pathPrefix').toMatch(/pathPrefix: ["']\/api\/v1["']/);
    expect(barrel, 'naming.routerSuffix + procedureCase').toContain("from './users_api'");
    expect(barrel, 'importExtension: none').toContain("export * from './posts_api';");
  });

  /**
   * The derived import path, which is where the `./` prefix would go wrong.
   *
   * The sibling entry says `path: './out/schemas'`, and a `path` is project-relative while an
   * `importPath` beginning with `./` is relative to the *output* directory. Copied across raw it
   * would resolve to `out/contract/out/schemas`, which does not exist. The specifier below is what
   * the builder produced after stripping the prefix.
   */
  it('derived an import path that points at the sibling generator', () => {
    expect(fromGenerate['users_api.ts']).toContain("from '../schemas/index'");
    expect(fromGenerate['users_api.ts']).not.toContain('out/schemas');
  });

  it('leaves the top-level outDir alone when the generator names its own path', () => {
    expect(existsSync(path.join(dir, 'unused-by-ts-rest'))).toBe(false);
  });
});
