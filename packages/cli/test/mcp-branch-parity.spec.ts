/**
 * `generate` and `watch` hand the MCP generator the same options, confirmed on the bytes.
 *
 * The CLI dispatches over `cfg.generators` twice, once per command, and every branch in both loops
 * assembles its own options object by hand. An option added to one is simply absent from the
 * other, and nothing says so: the config parses, the generator defaults the missing value, and the
 * feature does nothing. Four options have been found dead that way, which is why both branches
 * here call `mcpOptions` instead of building the object themselves, and why this file checks that
 * they did rather than trusting that they did.
 *
 * This generator has four options no other kind takes, and every one of them is a silent default
 * if it goes missing: `sdk` decides which package the emitted server imports, `serverName` and
 * `serverVersion` are what a client sees at initialize, and `stdio` decides whether a runnable
 * entry point exists at all. All four are set below to something other than the default.
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
const ROOT = path.join(import.meta.dirname, '.mcp-parity-tmp');

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
 * Every option the MCP branch forwards, set to something other than the generator's own default,
 * so a dropped one changes the output rather than coinciding with it. `sdk` stays at `v2` for one
 * measured reason rather than by oversight: the v1 SDK is zod-only and throws at registration on
 * anything else, and `validation.library` here is valibot, which is the more interesting half to
 * check. The v1 spelling has its own case in the generator's own suite.
 */
const CONFIG = `export default {
  schema: './src/db/schema.ts',
  outDir: './unused-by-mcp',
  generators: [
    {
      kind: 'mcp',
      path: './out/mcp',
      sdk: 'v2',
      serverName: 'parity-fixture',
      serverVersion: '9.8.7',
      stdio: false,
      naming: { routerSuffix: 'Tools', procedureCase: 'snake', toolPrefix: 'fx.' },
      outputHeader: { text: 'parity fixture' },
      format: { enabled: false },
      importExtension: 'none',
      validation: { library: 'valibot' },
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
const mcpOut = path.join(dir, 'out', 'mcp');

beforeAll(async () => {
  if (!existsSync(CLI)) {
    throw new Error(`Built CLI not found at ${CLI}. Run \`pnpm build\` before \`pnpm test\`.`);
  }
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'src', 'db'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'db', 'schema.ts'), SCHEMA, 'utf8');
  await fs.writeFile(path.join(dir, 'drzl.config.ts'), CONFIG, 'utf8');

  await run(process.execPath, [CLI, 'generate'], { cwd: dir, maxBuffer: 20 * 1024 * 1024 });
  fromGenerate = await tree(mcpOut);

  await fs.rm(path.join(dir, 'out'), { recursive: true, force: true });

  // `watch` builds once on start, which is the run being compared. `--poll` for the same reason
  // the other watch tests use it: inotify does not reach chokidar reliably on WSL or in Docker.
  const child = spawn(process.execPath, [CLI, 'watch', '--pipeline', 'generate-mcp', '--poll'], {
    cwd: dir,
    stdio: 'ignore',
  });
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (existsSync(path.join(mcpOut, 'index.ts'))) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    // A short settle, so a file half-written when index.ts appeared is complete before it is read.
    await new Promise((r) => setTimeout(r, 500));
    fromWatch = await tree(mcpOut);
  } finally {
    child.kill('SIGTERM');
  }
}, 180_000);

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('the MCP branch in generate and in watch', () => {
  it('writes the same set of files', () => {
    expect(Object.keys(fromWatch)).toEqual(Object.keys(fromGenerate));
    // No stdio.ts: the fixture turns it off, and that is one of the four options this kind alone
    // takes, so its absence here is the assertion rather than a detail of the fixture.
    expect(Object.keys(fromGenerate)).toEqual(['index.ts', 'posts_tools.ts', 'users_tools.ts']);
  });

  it('writes the same bytes', () => {
    expect(fromWatch).toEqual(fromGenerate);
  });

  it('honoured every option the fixture set, so the comparison was not of two defaults', () => {
    // Without this, two branches that both dropped the same option would still agree and this
    // file would pass on output neither of them shaped.
    const tools = fromGenerate['users_tools.ts'];
    expect(tools, 'outputHeader.text').toContain('// parity fixture');
    expect(tools, 'validation.library').toContain("import * as v from 'valibot';");
    expect(tools, 'naming.toolPrefix').toContain("'fx.users_list'");
    // format.enabled false, so nothing rewrote the quotes above and made those checks vacuous.
    expect(tools, 'sdk: v2').toContain("from '@modelcontextprotocol/server'");

    const barrel = fromGenerate['index.ts'];
    expect(barrel, 'serverName + serverVersion').toContain(
      "name: 'parity-fixture', version: '9.8.7'"
    );
    expect(barrel, 'naming.routerSuffix + procedureCase').toContain("from './users_tools'");
    expect(barrel, 'importExtension: none').toContain("export * from './posts_tools';");
  });

  it('leaves the top-level outDir alone when the generator names its own path', () => {
    // `outDir` is the default for this generator like every router, so a config running it
    // beside one has to be able to separate them. The fixture points `path` elsewhere.
    expect(existsSync(path.join(dir, 'unused-by-mcp'))).toBe(false);
  });
});
