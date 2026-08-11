/**
 * `generate` and `watch` hand the fast-check generator the same options, confirmed on the bytes.
 *
 * The CLI dispatches over `cfg.generators` twice, once per command, and every branch in both loops
 * assembles its own options object by hand. An option added to one is simply absent from the other,
 * and nothing says so: the config parses, the generator defaults the missing value, and the feature
 * does nothing. Four options have been found dead that way, which is why both branches here call
 * `fastCheckOptions` instead of building the object themselves.
 *
 * The fixture's schema carries a real `check()`, so this also runs the whole path: a Drizzle
 * declaration, through the analyzer's parser, into an emitted `fc.integer({ min, max })`.
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
const ROOT = path.join(import.meta.dirname, '.fast-check-parity-tmp');

const SCHEMA = `
import { pgTable, integer, serial, text, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
});
export const products = pgTable('products', {
  id: serial('id').primaryKey(),
  quantity: integer('quantity').notNull(),
}, (t) => [check('quantity_range', sql\`\${t.quantity} >= 1 AND \${t.quantity} <= 999\`)]);
`;

/**
 * Every option the fast-check branch forwards, set to something other than the generator's own
 * default, so a dropped one changes the output rather than coinciding with it.
 */
const CONFIG = `export default {
  schema: './src/db/schema.ts',
  outDir: './unused-by-fast-check',
  generators: [
    {
      kind: 'fast-check',
      path: './out/arb',
      naming: { routerSuffix: 'Fixture', procedureCase: 'snake' },
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
const arbOut = path.join(dir, 'out', 'arb');

beforeAll(async () => {
  if (!existsSync(CLI)) {
    throw new Error(`Built CLI not found at ${CLI}. Run \`pnpm build\` before \`pnpm test\`.`);
  }
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'src', 'db'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'db', 'schema.ts'), SCHEMA, 'utf8');
  await fs.writeFile(path.join(dir, 'drzl.config.ts'), CONFIG, 'utf8');

  await run(process.execPath, [CLI, 'generate'], { cwd: dir, maxBuffer: 20 * 1024 * 1024 });
  fromGenerate = await tree(arbOut);

  await fs.rm(path.join(dir, 'out'), { recursive: true, force: true });

  // `watch` builds once on start, which is the run being compared. `--poll` for the same reason
  // the other watch tests use it: inotify does not reach chokidar reliably on WSL or in Docker.
  const child = spawn(
    process.execPath,
    [CLI, 'watch', '--pipeline', 'generate-fast-check', '--poll'],
    { cwd: dir, stdio: 'ignore' }
  );
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (existsSync(path.join(arbOut, 'index.ts'))) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    // A short settle, so a file half-written when index.ts appeared is complete before it is read.
    await new Promise((r) => setTimeout(r, 500));
    fromWatch = await tree(arbOut);
  } finally {
    child.kill('SIGTERM');
  }
}, 180_000);

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('the fast-check branch in generate and in watch', () => {
  it('writes the same set of files', () => {
    expect(Object.keys(fromWatch)).toEqual(Object.keys(fromGenerate));
    expect(Object.keys(fromGenerate)).toEqual([
      'index.ts',
      'products_fixture.ts',
      'users_fixture.ts',
    ]);
  });

  it('writes the same bytes', () => {
    expect(fromWatch).toEqual(fromGenerate);
  });

  it('honoured every option the fixture set, so the comparison was not of two defaults', () => {
    const arb = fromGenerate['products_fixture.ts'];
    expect(arb, 'outputHeader.text').toContain('// parity fixture');
    // The CHECK reached the emitted arbitrary, which is the whole point of this generator.
    expect(arb, 'the parsed bound').toContain('fc.integer({ min: 1, max: 999 })');
    // An integer column cannot hold a NaN, so the flag is not emitted for one. The float case has
    // its own assertions, both directions, in the generator's own suite.
    expect(arb, 'no stray noNaN on an integer').not.toContain('noNaN');
    expect(arb, 'naming.routerSuffix + procedureCase').toContain('products_fixtureArbitrary');

    const barrel = fromGenerate['index.ts'];
    expect(barrel, 'importExtension: none').toContain("from './users_fixture'");
    expect(barrel, 'the keyed map').toContain('export const arbitraries');
  });

  it('leaves the top-level outDir alone when the generator names its own path', () => {
    expect(existsSync(path.join(dir, 'unused-by-fast-check'))).toBe(false);
  });
});
