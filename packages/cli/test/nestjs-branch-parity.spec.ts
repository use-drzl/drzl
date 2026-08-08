/**
 * `generate` and `watch` hand the NestJS generator the same options, confirmed on the bytes.
 *
 * The CLI dispatches over `cfg.generators` twice, once per command, and every branch in both loops
 * assembles its own options object by hand. An option added to one is simply absent from the
 * other, and nothing says so: the config parses, the generator defaults the missing value, and the
 * feature does nothing. Four options have been found dead that way, which is why both branches
 * here call `nestjsOptions` instead of building the object themselves, and why this file checks
 * that they did rather than trusting that they did.
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
const ROOT = path.join(import.meta.dirname, '.nestjs-parity-tmp');

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
 * Every option the NestJS branch is supposed to forward, all set to something other than the
 * generator's own default, so a dropped one changes the output rather than coinciding with it.
 * There is no `includeRelations` entry, unlike the router fixtures: this generator takes none,
 * and `resolveConfig` warns when a config sets one. `validation.library` is the one key of the
 * validation block this kind reads, and `valibot` is not the default, so a branch that dropped
 * the block would emit zod spellings and fail below.
 */
const CONFIG = `export default {
  schema: './src/db/schema.ts',
  outDir: './unused-by-nestjs',
  generators: [
    {
      kind: 'nestjs',
      path: './out/nestjs',
      naming: { routerSuffix: 'Dto', procedureCase: 'snake' },
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
const nestjsOut = path.join(dir, 'out', 'nestjs');

beforeAll(async () => {
  if (!existsSync(CLI)) {
    throw new Error(`Built CLI not found at ${CLI}. Run \`pnpm build\` before \`pnpm test\`.`);
  }
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'src', 'db'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'db', 'schema.ts'), SCHEMA, 'utf8');
  await fs.writeFile(path.join(dir, 'drzl.config.ts'), CONFIG, 'utf8');

  await run(process.execPath, [CLI, 'generate'], { cwd: dir, maxBuffer: 20 * 1024 * 1024 });
  fromGenerate = await tree(nestjsOut);

  await fs.rm(path.join(dir, 'out'), { recursive: true, force: true });

  // `watch` builds once on start, which is the run being compared. `--poll` for the same reason
  // the other watch tests use it: inotify does not reach chokidar reliably on WSL or in Docker.
  const child = spawn(
    process.execPath,
    [CLI, 'watch', '--pipeline', 'generate-nestjs', '--poll'],
    {
      cwd: dir,
      stdio: 'ignore',
    }
  );
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (existsSync(path.join(nestjsOut, 'index.ts'))) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    // A short settle, so a file half-written when index.ts appeared is complete before it is read.
    await new Promise((r) => setTimeout(r, 500));
    fromWatch = await tree(nestjsOut);
  } finally {
    child.kill('SIGTERM');
  }
}, 180_000);

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('the NestJS branch in generate and in watch', () => {
  it('writes the same set of files', () => {
    expect(Object.keys(fromWatch)).toEqual(Object.keys(fromGenerate));
    // A validation module, unlike the Fastify set: the pipe is a deliverable of this generator.
    expect(Object.keys(fromGenerate)).toEqual([
      'index.ts',
      'posts_dto.ts',
      'users_dto.ts',
      'validation.ts',
    ]);
  });

  it('writes the same bytes', () => {
    expect(fromWatch).toEqual(fromGenerate);
  });

  it('honoured every option the fixture set, so the comparison was not of two defaults', () => {
    // Without this, two branches that both dropped the same option would still agree and this
    // file would pass on output neither of them shaped.
    const dtos = fromGenerate['users_dto.ts'];
    expect(dtos, 'outputHeader.text').toContain('// parity fixture');
    expect(dtos, 'validation.library').toContain("import * as v from 'valibot';");
    // format.enabled false, so nothing rewrote the quotes above and made those checks vacuous.
    expect(dtos, 'format.enabled: false').toContain("from './validation'");

    const barrel = fromGenerate['index.ts'];
    expect(barrel, 'naming.routerSuffix + procedureCase').toContain("from './users_dto'");
    expect(barrel, 'importExtension: none').toContain("export * from './validation';");
  });

  it('leaves the top-level outDir alone when the generator names its own path', () => {
    // `outDir` is the default for this generator like every router, so a config running it
    // beside one has to be able to separate them. The fixture points `path` elsewhere.
    expect(existsSync(path.join(dir, 'unused-by-nestjs'))).toBe(false);
  });
});
