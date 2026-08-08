/**
 * `generate` and `watch` hand the Hono generator the same options, confirmed on the bytes.
 *
 * The CLI dispatches over `cfg.generators` twice, once per command, and every branch in both loops
 * assembles its own options object by hand. An option added to one is simply absent from the
 * other, and nothing says so: the config parses, the generator defaults the missing value, and the
 * feature does nothing. Four options have been found dead that way, which is why both branches
 * here call `honoOptions` instead of building the object themselves, and why this file checks that
 * they did rather than trusting that they did.
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
const ROOT = path.join(import.meta.dirname, '.hono-parity-tmp');

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
 * Every option the Hono branch is supposed to forward, all set to something other than the
 * generator's own default, so a dropped one changes the output rather than coinciding with it.
 */
const CONFIG = `export default {
  schema: './src/db/schema.ts',
  outDir: './unused-by-hono',
  generators: [
    { kind: 'zod', path: './out/zod' },
    {
      kind: 'hono',
      path: './out/hono',
      validator: 'zod',
      includeRelations: true,
      naming: { routerSuffix: 'Api', procedureCase: 'snake' },
      outputHeader: { text: 'parity fixture' },
      format: { enabled: false },
      importExtension: 'none',
      validation: { useShared: true, library: 'zod', importPath: 'out/zod' },
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
const honoOut = path.join(dir, 'out', 'hono');

beforeAll(async () => {
  if (!existsSync(CLI)) {
    throw new Error(`Built CLI not found at ${CLI}. Run \`pnpm build\` before \`pnpm test\`.`);
  }
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'src', 'db'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'db', 'schema.ts'), SCHEMA, 'utf8');
  await fs.writeFile(path.join(dir, 'drzl.config.ts'), CONFIG, 'utf8');

  await run(process.execPath, [CLI, 'generate'], { cwd: dir, maxBuffer: 20 * 1024 * 1024 });
  fromGenerate = await tree(honoOut);

  await fs.rm(path.join(dir, 'out'), { recursive: true, force: true });

  // `watch` builds once on start, which is the run being compared. `--poll` for the same reason
  // the other watch tests use it: inotify does not reach chokidar reliably on WSL or in Docker.
  const child = spawn(process.execPath, [CLI, 'watch', '--pipeline', 'generate-hono', '--poll'], {
    cwd: dir,
    stdio: 'ignore',
  });
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (existsSync(path.join(honoOut, 'index.ts'))) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    // A short settle, so a file half-written when index.ts appeared is complete before it is read.
    await new Promise((r) => setTimeout(r, 500));
    fromWatch = await tree(honoOut);
  } finally {
    child.kill('SIGTERM');
  }
}, 180_000);

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('the Hono branch in generate and in watch', () => {
  it('writes the same set of files', () => {
    expect(Object.keys(fromWatch)).toEqual(Object.keys(fromGenerate));
    expect(Object.keys(fromGenerate)).toEqual(['index.ts', 'posts_api.ts', 'users_api.ts']);
  });

  it('writes the same bytes', () => {
    expect(fromWatch).toEqual(fromGenerate);
  });

  it('honoured every option the fixture set, so the comparison was not of two defaults', () => {
    // Without this, two branches that both dropped the same option would still agree and this
    // file would pass on output neither of them shaped.
    const routes = fromGenerate['users_api.ts'];
    expect(routes, 'outputHeader.text').toContain('// parity fixture');
    expect(routes, 'importExtension: none').toBeDefined();
    expect(routes, 'naming.routerSuffix + procedureCase').toContain('export const users_api =');
    expect(routes, 'validator: zod').toContain("from '@hono/zod-validator'");
    expect(routes, 'validator: zod').toContain('zValidator(');
    expect(routes, 'validation.useShared').toContain("from '../zod/index'");
    expect(fromGenerate['posts_api.ts'], 'includeRelations').toContain('/by_author_id/:authorId');
    // format.enabled false, so nothing rewrote the quotes above and made those checks vacuous.
    expect(routes, 'format.enabled: false').toContain("from 'hono'");

    const barrel = fromGenerate['index.ts'];
    expect(barrel, 'importExtension: none').toContain("from './users_api'");
    // Single-quoted even here, where `format.enabled: false` means no prettier ran to normalise
    // it. The generator emits the quotes it wants rather than relying on an optional peer.
    expect(barrel, 'the mounted segment').toContain("route('/users', users_api)");
  });

  it('leaves the top-level outDir alone when the generator names its own path', () => {
    // `outDir` is the default for every router generator, so a config running two of them has to
    // be able to separate them. The fixture points `path` elsewhere and no other router is
    // configured.
    expect(existsSync(path.join(dir, 'unused-by-hono'))).toBe(false);
  });
});
