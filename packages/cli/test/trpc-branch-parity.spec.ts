/**
 * `generate` and `watch` hand the tRPC generator the same options, confirmed on the bytes.
 *
 * The CLI dispatches over `cfg.generators` twice, once per command, and every branch in both loops
 * assembles its own options object by hand. An option added to one is simply absent from the
 * other, and nothing says so: the config parses, the generator defaults the missing value, and the
 * feature does nothing. Three options were found dead that way before this file existed, and a
 * fourth was found while writing it, `servicesDir`, which `generate`'s oRPC branch passed and
 * `watch`'s did not, so a watch rebuild emitted a service import pointing somewhere the config
 * never named.
 *
 * Reading the two branches is what missed all four. So this runs both commands over a config that
 * sets every option the generator takes, and compares what landed on disk. A reviewer cannot check
 * this by eye and neither can a reader of the wiring.
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
const ROOT = path.join(import.meta.dirname, '.trpc-parity-tmp');

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
 * Every option the tRPC branch is supposed to forward, all set to something other than the
 * generator's own default, so a dropped one changes the output rather than coinciding with it.
 */
const CONFIG = `export default {
  schema: './src/db/schema.ts',
  outDir: './unused-by-trpc',
  generators: [
    { kind: 'zod', path: './out/zod' },
    { kind: 'service', path: './out/svc', dataAccess: 'drizzle', schemaImportPath: 'src/db/schema' },
    {
      kind: 'trpc',
      path: './out/trpc',
      template: 'service',
      includeRelations: true,
      naming: { routerSuffix: 'Api', procedureCase: 'snake' },
      outputHeader: { text: 'parity fixture' },
      format: { enabled: false },
      importExtension: 'none',
      validation: { useShared: true, library: 'zod', importPath: 'out/zod' },
      databaseInjection: {
        enabled: true,
        databaseType: 'Database',
        databaseTypeImport: { name: 'Database', from: '../../src/db/client.js' },
      },
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
const trpcOut = path.join(dir, 'out', 'trpc');

beforeAll(async () => {
  if (!existsSync(CLI)) {
    throw new Error(`Built CLI not found at ${CLI}. Run \`pnpm build\` before \`pnpm test\`.`);
  }
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'src', 'db'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'db', 'schema.ts'), SCHEMA, 'utf8');
  await fs.writeFile(path.join(dir, 'drzl.config.ts'), CONFIG, 'utf8');

  await run(process.execPath, [CLI, 'generate'], { cwd: dir, maxBuffer: 20 * 1024 * 1024 });
  fromGenerate = await tree(trpcOut);

  await fs.rm(path.join(dir, 'out'), { recursive: true, force: true });

  // `watch` builds once on start, which is the run being compared. `--poll` for the same reason
  // the other watch test uses it: inotify does not reach chokidar reliably on WSL or in Docker.
  const child = spawn(process.execPath, [CLI, 'watch', '--pipeline', 'generate-trpc', '--poll'], {
    cwd: dir,
    stdio: 'ignore',
  });
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (existsSync(path.join(trpcOut, 'index.ts'))) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    // A short settle, so a file half-written when index.ts appeared is complete before it is read.
    await new Promise((r) => setTimeout(r, 500));
    fromWatch = await tree(trpcOut);
  } finally {
    child.kill('SIGTERM');
  }
}, 180_000);

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('the tRPC branch in generate and in watch', () => {
  it('writes the same set of files', () => {
    expect(Object.keys(fromWatch)).toEqual(Object.keys(fromGenerate));
    expect(Object.keys(fromGenerate)).toEqual([
      'index.ts',
      'posts_api.ts',
      'trpc.ts',
      'users_api.ts',
    ]);
  });

  it('writes the same bytes', () => {
    expect(fromWatch).toEqual(fromGenerate);
  });

  it('honoured every option the fixture set, so the comparison was not of two defaults', () => {
    // Without this, two branches that both dropped the same option would still agree and this
    // file would pass on output neither of them shaped.
    const router = fromGenerate['users_api.ts'];
    expect(router, 'outputHeader.text').toContain('// parity fixture');
    expect(router, 'importExtension: none').toContain("from './trpc'");
    expect(router, 'naming.routerSuffix + procedureCase').toContain('export const users_api =');
    expect(router, 'naming.procedureCase: snake').toContain('by_id:');
    expect(router, 'validation.useShared').toContain("from '../zod/index'");
    expect(router, 'template: service + servicesDir').toContain(
      "from '../svc/userService'"
    );
    expect(router, 'databaseInjection').toContain('dbProcedure');
    expect(router, 'databaseInjection').toContain('UserService.getAll(ctx.db)');
    expect(fromGenerate['posts_api.ts'], 'includeRelations').toContain('list_by_author_id:');
    expect(fromGenerate['trpc.ts'], 'databaseTypeImport').toContain(
      "import type { Database } from '../../src/db/client.js';"
    );
    // format.enabled false, so nothing rewrote the quotes above and made those checks vacuous.
    expect(router, 'format.enabled: false').toContain("from 'zod'");
  });

  it('leaves the top-level outDir alone when the generator names its own path', () => {
    // `outDir` is oRPC's by default and tRPC's too, so a config running both has to be able to
    // separate them. The fixture points `path` elsewhere and no oRPC generator is configured.
    expect(existsSync(path.join(dir, 'unused-by-trpc'))).toBe(false);
  });
});
