/**
 * `generate` and `watch` hand the forms generator the same options, confirmed on the bytes.
 *
 * The CLI dispatches over `cfg.generators` twice, once per command, and every branch in both loops
 * assembles its own options object by hand. An option added to one is simply absent from the other,
 * and nothing says so: the config parses, the generator defaults the missing value, and the feature
 * does nothing. Four options have been found dead that way, which is why both branches here call
 * `formsOptions` instead of building the object themselves.
 *
 * The fixture sets `target: 'both'` and `modes: ['insert', 'update', 'select']`. Neither is the
 * generator's default, so a branch that dropped either emits a different file and the byte
 * comparison sees it. `modes` is the one most likely to be forgotten, because it is a plain array
 * passed straight through.
 *
 * The fixture also gives the validation generator a `./`-prefixed path, for the reason the ts-rest
 * parity spec records: that prefix means one thing in a generator's `path` and another in
 * `validation.importPath`, and a branch copying the raw value emits a specifier resolving to
 * nothing.
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
const ROOT = path.join(import.meta.dirname, '.forms-parity-tmp');

/** A CHECK on `age`, because the narrowed bound is the fact this generator exists to carry. */
const SCHEMA = `
import { pgTable, integer, serial, text, varchar, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
  handle: varchar('handle', { length: 40 }).notNull(),
  age: integer('age').notNull(),
}, (t) => [
  check('adult', sql\`\${t.age} >= 18\`),
  check('handle_len', sql\`length(\${t.handle}) <= 20\`),
]);
`;

const CONFIG = `export default {
  schema: './src/db/schema.ts',
  outDir: './unused-by-forms',
  generators: [
    { kind: 'zod', path: './out/schemas' },
    {
      kind: 'forms',
      path: './out/forms',
      target: 'both',
      modes: ['insert', 'update', 'select'],
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
const formsOut = path.join(dir, 'out', 'forms');

beforeAll(async () => {
  if (!existsSync(CLI)) {
    throw new Error(`Built CLI not found at ${CLI}. Run \`pnpm build\` before \`pnpm test\`.`);
  }
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'src', 'db'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'db', 'schema.ts'), SCHEMA, 'utf8');
  await fs.writeFile(path.join(dir, 'drzl.config.ts'), CONFIG, 'utf8');

  await run(process.execPath, [CLI, 'generate'], { cwd: dir, maxBuffer: 20 * 1024 * 1024 });
  fromGenerate = await tree(formsOut);

  await fs.rm(path.join(dir, 'out'), { recursive: true, force: true });

  // `watch` builds once on start, which is the run being compared. `--poll` for the same reason
  // the other watch tests use it: inotify does not reach chokidar reliably on WSL or in Docker.
  const child = spawn(process.execPath, [CLI, 'watch', '--pipeline', 'generate-forms', '--poll'], {
    cwd: dir,
    stdio: 'ignore',
  });
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (existsSync(path.join(formsOut, 'index.ts'))) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 500));
    fromWatch = await tree(formsOut);
  } finally {
    child.kill('SIGTERM');
  }
}, 180_000);

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('the forms branch in generate and in watch', () => {
  it('writes the same set of files', () => {
    expect(Object.keys(fromWatch)).toEqual(Object.keys(fromGenerate));
    expect(Object.keys(fromGenerate)).toEqual(['index.ts', 'users.form.ts']);
  });

  it('writes the same bytes', () => {
    expect(fromWatch).toEqual(fromGenerate);
  });

  it('honoured every option the fixture set, so the comparison was not of two defaults', () => {
    const form = fromGenerate['users.form.ts'];
    expect(form, 'outputHeader.text').toContain('// parity fixture');
    // target: 'both' emits the react-hook-form resolver and the TanStack options together.
    expect(form, 'target both, resolver half').toContain('usersInsertResolver');
    expect(form, 'target both, tanstack half').toContain('usersInsertFormOptions');
    // modes included select, which is off by default.
    expect(form, 'modes').toContain('usersSelectResolver');
  });

  /**
   * The fact the whole generator exists for: the emitted bound is the one the database enforces,
   * not the column's type range. A branch reading the column directly would put the int32 floor on
   * an input for a column restricted to 18.
   */
  it('emitted the CHECK-narrowed bounds rather than the column type range', () => {
    const form = fromGenerate['users.form.ts'];
    const age = form.slice(form.indexOf('"age":'), form.indexOf('} as const'));
    expect(age).toContain('min: "18"');
    expect(age).not.toContain('-2147483648');
    // The length CHECK is tighter than the declared varchar(40).
    expect(form).toContain('maxLength: 20');
  });

  it('derived an import path that points at the sibling generator', () => {
    expect(fromGenerate['users.form.ts']).toContain('"../schemas/index"');
    expect(fromGenerate['users.form.ts']).not.toContain('out/schemas');
  });

  it('leaves the top-level outDir alone when the generator names its own path', () => {
    expect(existsSync(path.join(dir, 'unused-by-forms'))).toBe(false);
  });
});
