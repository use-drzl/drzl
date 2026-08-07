/**
 * `nestedSchemas` reaches every validation branch of both dispatch loops, confirmed on the output.
 *
 * The CLI loops over `cfg.generators` twice, once for `generate` and once for `watch`, and every
 * branch used to assemble its own options object by hand. Three documented options were found dead
 * that way before the shared builder existed, and the `watch` copies of the zod, valibot and
 * arktype branches had never been moved onto it: they still passed six keys, so `coerceDates`,
 * `applyDefaults`, `typedJson`, `typedColumns` and `duplicateFinder` were all silently dropped on
 * a rebuild. `watch` had no typebox or json-schema branch at all, so those two directories simply
 * went stale from the first save onward.
 *
 * Reading the wiring is what missed all of that. This runs both commands over a config that turns
 * the option on for every generator that takes it, and looks at what landed on disk.
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
// Named `.tmp-*` so `packages/*/test/.tmp-*` in .gitignore catches it. `afterAll` removes it, and
// an interrupted run does not, which is exactly how 22 generated modules once reached a merge.
const ROOT = path.join(import.meta.dirname, '.tmp-nested-parity');

const SCHEMA = `
import { pgTable, integer, serial, text } from 'drizzle-orm/pg-core';
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
});
export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id').notNull().references(() => users.id),
  title: text('title').notNull(),
});
`;

/** Every generator that takes the option, each writing somewhere of its own. */
const LIBS = ['zod', 'valibot', 'arktype', 'typebox'] as const;

const CONFIG = `export default {
  schema: './src/db/schema.ts',
  outDir: './unused',
  analyzer: { includeRelations: true, validateConstraints: true },
  generators: [
${LIBS.map((l) => `    { kind: '${l}', path: './out/${l}', nestedSchemas: true },`).join('\n')}
  ],
};
`;

const outFor = (dir: string, lib: string) => path.join(dir, 'out', lib);

async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await fs.readdir(dir)).sort()) {
    out[name] = await fs.readFile(path.join(dir, name), 'utf8');
  }
  return out;
}

const dir = path.join(ROOT, 'parity');
let fromGenerate: Record<string, Record<string, string>>;
let fromWatch: Record<string, Record<string, string>>;

beforeAll(async () => {
  if (!existsSync(CLI)) {
    throw new Error(`Built CLI not found at ${CLI}. Run \`pnpm build\` before \`pnpm test\`.`);
  }
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'src', 'db'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'db', 'schema.ts'), SCHEMA, 'utf8');
  await fs.writeFile(path.join(dir, 'drzl.config.ts'), CONFIG, 'utf8');

  await run(process.execPath, [CLI, 'generate'], { cwd: dir, maxBuffer: 20 * 1024 * 1024 });
  fromGenerate = Object.fromEntries(
    await Promise.all(LIBS.map(async (l) => [l, await tree(outFor(dir, l))] as const))
  );

  await fs.rm(path.join(dir, 'out'), { recursive: true, force: true });

  // `watch` builds once on start, which is the run being compared. `--poll` for the same reason
  // the other watch tests use it: inotify does not reach chokidar reliably on WSL or in Docker.
  const child = spawn(process.execPath, [CLI, 'watch', '--poll'], { cwd: dir, stdio: 'ignore' });
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (LIBS.every((l) => existsSync(path.join(outFor(dir, l), 'index.ts')))) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 800));
    fromWatch = Object.fromEntries(
      await Promise.all(
        LIBS.map(async (l) => {
          const d = outFor(dir, l);
          return [l, existsSync(d) ? await tree(d) : {}] as const;
        })
      )
    );
  } finally {
    child.kill('SIGTERM');
  }
}, 240_000);

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('generate', () => {
  it.each(LIBS)('emits the nested schemas for %s', (lib) => {
    const users = fromGenerate[lib]['users.' + lib + '.ts'];
    expect(users, `${lib} nested insert`).toContain('NestedInsertusersSchema');
    expect(users, `${lib} nested select`).toContain('NestedSelectusersSchema');
    // The child's foreign key is what the parent supplies, so it is not in the nested shape. The
    // plain insert schema still has it, which is what makes this a real check rather than a
    // coincidence of a schema that never mentioned it.
    const from = users.indexOf('export const NestedInsertusersSchema');
    const to = users.indexOf('export type NestedInsertusersInput');
    expect(from, `${lib} nested insert block`).toBeGreaterThan(-1);
    const insertBlock = users.slice(from, to);
    expect(insertBlock, `${lib} omits the child's foreign key`).not.toContain('authorId');
    // It is still there on the select side, where the row really comes back carrying it.
    const selectFrom = users.indexOf('export const NestedSelectusersSchema');
    expect(users.slice(selectFrom), `${lib} keeps it on a read`).toContain('authorId');
    expect(fromGenerate[lib]['posts.' + lib + '.ts']).toContain('authorId');
  });

  it('emits no nested update schema anywhere', () => {
    for (const lib of LIBS) {
      for (const [name, code] of Object.entries(fromGenerate[lib])) {
        expect(code, `${lib}/${name}`).not.toContain('NestedUpdate');
      }
    }
  });
});

describe('watch', () => {
  it.each(LIBS)('runs the %s branch at all', (lib) => {
    // typebox had no watch branch before this change, so its directory was never written and a
    // rebuild left whatever was there from the last `generate`.
    expect(Object.keys(fromWatch[lib]), `${lib} produced no files under watch`).not.toEqual([]);
  });

  it.each(LIBS)('hands the %s branch the same options generate does', (lib) => {
    expect(fromWatch[lib]).toEqual(fromGenerate[lib]);
  });
});
