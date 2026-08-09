/**
 * The drizzle-kit interop, driven end to end through the built CLI: a project whose only
 * statement of the schema path is its `drizzle.config.ts`, exactly the project this feature
 * exists for.
 *
 * The watch half exercises the rule items 51-57 established for every new config surface: the
 * files the schema really comes from must be watched. Before this feature the watcher derived
 * its targets from `cfg.schema` alone, so a schema resolved through drizzle-kit's config would
 * have generated once at startup and then never again; the "picks up an edit" and "sees a new
 * file matching the glob" tests are the ones that fail in that world.
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
const ROOT = path.join(import.meta.dirname, '.tmp-dk-interop');

const USERS = `import { pgTable, serial, text } from 'drizzle-orm/pg-core';
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
});
`;

const POSTS = `import { integer, pgTable, serial, varchar } from 'drizzle-orm/pg-core';
import { users } from './users';
export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id').references(() => users.id),
  title: varchar('title', { length: 200 }).notNull(),
});
`;

// What drizzle-kit's own docs tell a multi-file project to write. defineConfig is declared
// inline because kit's index.mjs is measured to be the identity function, so the evaluated
// config is byte-for-byte what an installed drizzle-kit would produce, without making this
// repo depend on the package.
const KIT_CONFIG = `const defineConfig = <T,>(config: T): T => config;
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/*.ts',
  out: './drizzle',
});
`;

// No schema key at all: the point of the feature.
const DRZL_CONFIG = `export default {
  outDir: './out/api',
  generators: [{ kind: 'zod', path: './out/zod' }],
};
`;

async function project(name: string) {
  const dir = path.join(ROOT, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'src', 'db', 'schema'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'db', 'schema', 'users.ts'), USERS, 'utf8');
  await fs.writeFile(path.join(dir, 'src', 'db', 'schema', 'posts.ts'), POSTS, 'utf8');
  await fs.writeFile(path.join(dir, 'drizzle.config.ts'), KIT_CONFIG, 'utf8');
  await fs.writeFile(path.join(dir, 'drzl.config.ts'), DRZL_CONFIG, 'utf8');
  return dir;
}

async function pollFor(check: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
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

describe('drzl generate with no schema in drzl.config', () => {
  it('reads drizzle.config.ts, expands its glob, and generates for every table', async () => {
    const dir = await project('generate');
    const { stdout, stderr } = await run(process.execPath, [CLI, 'generate'], {
      cwd: dir,
      maxBuffer: 20 * 1024 * 1024,
    });
    // stderr, not stdout. This line says where DRZL went looking, which is narration about the
    // run rather than a thing the run produced, and it used to sit on stdout directly in front of
    // the file list a caller was parsing. See docs/cli/output.md for the rule.
    expect(stderr).toContain('drizzle.config.ts');
    expect(stdout).not.toContain('drizzle.config.ts');
    // `.zod.ts`: the zod generator's default fileSuffix.
    expect(existsSync(path.join(dir, 'out', 'zod', 'users.zod.ts'))).toBe(true);
    expect(existsSync(path.join(dir, 'out', 'zod', 'posts.zod.ts'))).toBe(true);
    const posts = await fs.readFile(path.join(dir, 'out', 'zod', 'posts.zod.ts'), 'utf8');
    expect(posts).toContain('title');
  }, 120_000);

  it('warns when the declared dialect contradicts the schema, and still generates', async () => {
    const dir = await project('dialect-mismatch');
    await fs.writeFile(
      path.join(dir, 'drizzle.config.ts'),
      KIT_CONFIG.replace(`'postgresql'`, `'mysql'`),
      'utf8'
    );
    const { stderr } = await run(process.execPath, [CLI, 'generate'], {
      cwd: dir,
      maxBuffer: 20 * 1024 * 1024,
    });
    expect(stderr).toContain('declares dialect "mysql"');
    expect(stderr).toContain('analyzed as "postgres"');
    expect(existsSync(path.join(dir, 'out', 'zod', 'users.zod.ts'))).toBe(true);
  }, 120_000);

  it('lets an explicit drzl schema win over the drizzle-kit config, and says so', async () => {
    const dir = await project('precedence');
    await fs.mkdir(path.join(dir, 'src', 'other'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'src', 'other', 'only.ts'),
      USERS.replace(/users/g, 'accounts'),
      'utf8'
    );
    await fs.writeFile(
      path.join(dir, 'drzl.config.ts'),
      `export default {
  schema: './src/other/only.ts',
  drizzleKit: true,
  outDir: './out/api',
  generators: [{ kind: 'zod', path: './out/zod' }],
};
`,
      'utf8'
    );
    const { stderr } = await run(process.execPath, [CLI, 'generate'], {
      cwd: dir,
      maxBuffer: 20 * 1024 * 1024,
    });
    expect(stderr).toContain('both "schema" and "drizzleKit"');
    expect(existsSync(path.join(dir, 'out', 'zod', 'accounts.zod.ts'))).toBe(true);
    // The kit config's glob was not read, so its tables were not generated.
    expect(existsSync(path.join(dir, 'out', 'zod', 'users.zod.ts'))).toBe(false);
  }, 120_000);

  it('keeps typedColumns working when the kit schema resolves to one file', async () => {
    // `typedColumns` emits `typeof <table>.$inferSelect[...]` and imports the schema module to
    // do it, which needs a single module. One resolved file is that module, so the option
    // works exactly as it does with an explicit `schema`.
    const dir = await project('typed-single');
    await fs.rm(path.join(dir, 'src', 'db', 'schema', 'posts.ts'));
    await fs.writeFile(
      path.join(dir, 'drizzle.config.ts'),
      KIT_CONFIG.replace(`'./src/db/schema/*.ts'`, `'./src/db/schema/users.ts'`),
      'utf8'
    );
    await fs.writeFile(
      path.join(dir, 'drzl.config.ts'),
      DRZL_CONFIG.replace(
        `{ kind: 'zod', path: './out/zod' }`,
        `{ kind: 'zod', path: './out/zod', typedColumns: true }`
      ),
      'utf8'
    );
    await run(process.execPath, [CLI, 'generate'], { cwd: dir, maxBuffer: 20 * 1024 * 1024 });
    const users = await fs.readFile(path.join(dir, 'out', 'zod', 'users.zod.ts'), 'utf8');
    expect(users).toContain('$inferSelect');
    expect(users).toContain('../../src/db/schema/users');
  }, 120_000);

  it('says why typedColumns cannot work when the kit schema is several files', async () => {
    // Several files have no single module to import the tables from, so the generator keeps
    // its measured fallback: wide types plus the warning naming the reason, rather than a
    // fabricated import or silence.
    const dir = await project('typed-multi');
    await fs.writeFile(
      path.join(dir, 'drzl.config.ts'),
      DRZL_CONFIG.replace(
        `{ kind: 'zod', path: './out/zod' }`,
        `{ kind: 'zod', path: './out/zod', typedColumns: true }`
      ),
      'utf8'
    );
    const { stderr } = await run(process.execPath, [CLI, 'generate'], {
      cwd: dir,
      maxBuffer: 20 * 1024 * 1024,
    });
    expect(stderr).toContain('schema path is unknown');
    const users = await fs.readFile(path.join(dir, 'out', 'zod', 'users.zod.ts'), 'utf8');
    expect(users).not.toContain('$inferSelect');
  }, 120_000);

  it('fails with an error naming both files when neither yields a schema', async () => {
    const dir = await project('neither');
    await fs.rm(path.join(dir, 'drizzle.config.ts'));
    const failed = await run(process.execPath, [CLI, 'generate'], {
      cwd: dir,
      maxBuffer: 20 * 1024 * 1024,
    }).then(
      () => null,
      (e: any) => e
    );
    expect(failed, 'generate should exit non-zero').toBeTruthy();
    expect(String(failed.stderr)).toContain('no "schema"');
    expect(String(failed.stderr)).toContain('drizzle.config.ts');
  }, 120_000);
});

describe('drzl watch with the schema resolved from drizzle.config.ts', () => {
  it('start-up build matches generate byte for byte, and edits keep regenerating', async () => {
    const dir = await project('watch');
    const zodOut = path.join(dir, 'out', 'zod');

    await run(process.execPath, [CLI, 'generate'], { cwd: dir, maxBuffer: 20 * 1024 * 1024 });
    const fromGenerate: Record<string, string> = {};
    for (const f of (await fs.readdir(zodOut)).sort()) {
      fromGenerate[f] = await fs.readFile(path.join(zodOut, f), 'utf8');
    }
    await fs.rm(path.join(dir, 'out'), { recursive: true, force: true });

    // `--poll` for the reason every watch test here uses it: inotify does not reach chokidar
    // reliably on WSL, Docker or a network mount, and the test should report the product.
    const child = spawn(process.execPath, [CLI, 'watch', '--debounce', '50', '--poll'], {
      cwd: dir,
      stdio: 'ignore',
    });
    try {
      // Start-up build: same files, same bytes as generate.
      expect(
        await pollFor(() => existsSync(path.join(zodOut, 'index.ts')), 60_000),
        'watch never produced its start-up build'
      ).toBe(true);
      await new Promise((r) => setTimeout(r, 500));
      const fromWatch: Record<string, string> = {};
      for (const f of (await fs.readdir(zodOut)).sort()) {
        fromWatch[f] = await fs.readFile(path.join(zodOut, f), 'utf8');
      }
      expect(fromWatch).toEqual(fromGenerate);

      // An edit to a file the glob matched regenerates: the kit-config-derived directory is
      // really among the watch targets.
      await fs.writeFile(
        path.join(dir, 'src', 'db', 'schema', 'users.ts'),
        USERS.replace(
          `email: text('email').notNull(),`,
          `email: text('email').notNull(),\n  nickname: text('nickname'),`
        ),
        'utf8'
      );
      expect(
        await pollFor(async () => {
          const body = await fs.readFile(path.join(zodOut, 'users.zod.ts'), 'utf8').catch(() => '');
          return body.includes('nickname');
        }, 60_000),
        'the edited column never reached the regenerated schema'
      ).toBe(true);

      // A new file matching the glob joins the schema on the rebuild that first sees it: the
      // glob is re-expanded per run, not frozen at startup.
      await fs.writeFile(
        path.join(dir, 'src', 'db', 'schema', 'tags.ts'),
        USERS.replace(/users/g, 'tags').replace(`text('email')`, `text('label')`),
        'utf8'
      );
      expect(
        await pollFor(() => existsSync(path.join(zodOut, 'tags.zod.ts')), 60_000),
        'a new file matching the drizzle-kit glob never produced output'
      ).toBe(true);
    } finally {
      child.kill('SIGTERM');
    }
  }, 240_000);
});
