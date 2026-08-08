/**
 * Every OpenAPI-document option reaches both dispatch loops, confirmed on the output.
 *
 * The CLI loops over `cfg.generators` twice, once for `generate` and once for `watch`, and the
 * json-schema branch is assembled by hand in both. That arrangement has already dropped options
 * silently twice: five validation options never reached a watch rebuild, and `watch` had no
 * typebox or json-schema branch at all for a while. Reading the wiring is what missed both.
 *
 * So this asks for a document whose every field comes from a different config key, generates it
 * with each command, and compares the files. A field that arrives with its default value is a key
 * that was dropped, and it shows up as a difference from what the config asked for rather than as
 * a difference between the two commands, which is the failure mode a parity check alone misses.
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
const ROOT = path.join(import.meta.dirname, '.tmp-openapi-parity');

const SCHEMA = `
import { pgEnum, pgTable, integer, serial, text, uniqueIndex } from 'drizzle-orm/pg-core';
export const mood = pgEnum('mood', ['sad', 'ok', 'happy']);
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
  mood: mood('mood').notNull(),
}, (t) => ({ byEmail: uniqueIndex('users_email_key').on(t.email) }));
export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id').notNull().references(() => users.id),
  title: text('title').notNull(),
  mood: mood('mood').notNull(),
});
`;

/** Every field below is set to something no default would produce. */
const CONFIG = `export default {
  schema: './src/db/schema.ts',
  outDir: './unused',
  analyzer: { includeRelations: true, validateConstraints: true },
  generators: [
    {
      kind: 'json-schema',
      path: './out/json-schema',
      target: 'openapi-3.0',
      includeRelations: true,
      sharedEnums: true,
      document: {
        format: 'both',
        info: { title: 'Shop', version: '4.2.0', description: 'the shop api' },
        servers: [{ url: 'https://api.example.com/v1' }],
        validationStatus: 422,
      },
    },
  ],
};
`;

const OUT = path.join(ROOT, 'out', 'json-schema');

async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await fs.readdir(dir)).sort()) {
    out[name] = await fs.readFile(path.join(dir, name), 'utf8');
  }
  return out;
}

let fromGenerate: Record<string, string>;
let fromWatch: Record<string, string>;

beforeAll(async () => {
  if (!existsSync(CLI)) {
    throw new Error(`Built CLI not found at ${CLI}. Run \`pnpm build\` before \`pnpm test\`.`);
  }
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(path.join(ROOT, 'src', 'db'), { recursive: true });
  await fs.writeFile(path.join(ROOT, 'src', 'db', 'schema.ts'), SCHEMA, 'utf8');
  await fs.writeFile(path.join(ROOT, 'drzl.config.ts'), CONFIG, 'utf8');

  await run(process.execPath, [CLI, 'generate'], { cwd: ROOT, maxBuffer: 20 * 1024 * 1024 });
  fromGenerate = await tree(OUT);

  await fs.rm(path.join(ROOT, 'out'), { recursive: true, force: true });

  // `--poll` for the reason the other watch tests use it: inotify does not reach chokidar
  // reliably on WSL or in Docker.
  const child = spawn(process.execPath, [CLI, 'watch', '--poll'], { cwd: ROOT, stdio: 'ignore' });
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (existsSync(path.join(OUT, 'openapi.json'))) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 800));
    fromWatch = existsSync(OUT) ? await tree(OUT) : {};
  } finally {
    child.kill('SIGTERM');
  }
}, 240_000);

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('generate', () => {
  it('writes both forms of the document', () => {
    expect(Object.keys(fromGenerate)).toContain('openapi.ts');
    expect(Object.keys(fromGenerate)).toContain('openapi.json');
  });

  it('carries every field the config set', () => {
    const doc = JSON.parse(fromGenerate['openapi.json']);
    expect(doc.openapi, 'target').toBe('3.0.3');
    expect(doc.info, 'info').toMatchObject({
      title: 'Shop',
      version: '4.2.0',
      description: 'the shop api',
    });
    expect(doc.servers, 'servers').toEqual([{ url: 'https://api.example.com/v1' }]);
    expect(Object.keys(doc.paths), 'includeRelations').toContain('/users/{id}/posts');
    const codes = Object.keys(doc.paths['/users'].post.responses);
    expect(codes, 'validationStatus').toContain('422');
    expect(codes, 'validationStatus').not.toContain('400');
  });

  it('shares the enum the analysis named, across both tables', () => {
    // The document shares whatever `sharedEnums` says, since a document is only ever read whole.
    // `mood` is on one column of each table, so nothing inside one schema could see it twice.
    const doc = JSON.parse(fromGenerate['openapi.json']);
    expect(doc.components.schemas.mood).toEqual({ enum: ['sad', 'ok', 'happy'] });
    expect(doc.components.schemas.usersSelect.properties.mood).toEqual({
      $ref: '#/components/schemas/mood',
    });
    expect(doc.components.schemas.postsSelect.properties.mood).toEqual({
      $ref: '#/components/schemas/mood',
    });
  });

  it('emits no $defs into a 3.0 module, whatever sharedEnums says', () => {
    // `sharedEnums: true` is set above. `$defs` is a 2020-12 keyword and 3.0's Schema Object is
    // closed, so the per-table modules on this target keep their inline lists.
    expect(fromGenerate['users.schema.ts']).not.toContain('$defs');
    expect(fromGenerate['users.schema.ts']).not.toContain('$ref');
    expect(fromGenerate['users.schema.ts'], 'the list is still there, inline').toContain('sad');
  });
});

describe('watch', () => {
  it('runs the json-schema branch at all', () => {
    expect(Object.keys(fromWatch)).not.toEqual([]);
  });

  it('hands it the same options generate does', () => {
    expect(fromWatch).toEqual(fromGenerate);
  });
});
