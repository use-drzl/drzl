/**
 * What `drzl generate` would write, what it did write, and what differs (plan items 68, 80, 81,
 * and the evidence for 82), spawned as real processes.
 *
 * All four read one mechanism, so they are tested against one fixture. The assertions that carry
 * weight:
 *
 *  - **68**: a dry run in a project that has never been generated into leaves the directory
 *    byte-for-byte what it was, directories included. Not "no generated files appeared": no
 *    entry appeared and no existing byte changed, which is the only form of the claim that also
 *    catches a stray `mkdir`, a lockfile or a formatter cache.
 *  - **80**: the report distinguishes created from changed from unchanged. A run that rewrites
 *    twelve identical files and one real change used to say "13 files".
 *  - **81**: a failing `--check` prints a diff that names the file and shows the changed lines.
 *  - **82**: the analysis happens once per run however many generators are configured.
 *
 * Requires a build. CI builds before testing; locally, run `pnpm build` first.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';

const CLI = path.resolve(__dirname, '..', 'dist', 'cli.js');
const ROOT = path.join(__dirname, '.tmp-generate-plan');

const SCHEMA = `
import { pgTable, serial, text } from 'drizzle-orm/pg-core';
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
});
`;

const EXTRA_TABLE = `export const posts = pgTable('posts', { id: serial('id').primaryKey() });\n`;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn the built CLI, keeping the exit code rather than throwing on a non-zero one. */
function run(args: string[], cwd: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      {
        cwd,
        maxBuffer: 40 * 1024 * 1024,
        // `NO_COLOR` so the assertions are on words rather than on escape sequences, and
        // `DRZL_HIDE_SPONSOR` so no run of this file writes the sponsor cache into the fixture.
        env: { ...process.env, NO_COLOR: '1', DRZL_HIDE_SPONSOR: '1', FORCE_COLOR: '0' },
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') return reject(error);
        resolve({ code: (error?.code as number) ?? 0, stdout, stderr });
      }
    );
  });
}

/** Every entry under `dir`, with file contents, so "unchanged" means bytes and not a listing. */
async function tree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(current: string) {
    for (const e of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, e.name);
      const rel = path.relative(dir, full);
      if (e.isDirectory()) {
        out.set(rel + path.sep, '<dir>');
        await walk(full);
      } else {
        out.set(rel, await fs.readFile(full, 'utf8'));
      }
    }
  }
  await walk(dir);
  return out;
}

/**
 * A fresh project. Lives under this package so `drizzle-orm` resolves by the normal node_modules
 * walk, and so the project directory itself holds nothing but what this test put there.
 */
async function project(name: string, generators: string) {
  const dir = path.join(ROOT, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'src', 'db'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'db', 'schema.ts'), SCHEMA, 'utf8');
  await fs.writeFile(
    path.join(dir, 'drzl.config.ts'),
    `export default { schema: './src/db/schema.ts', outDir: './out', generators: [${generators}] };`,
    'utf8'
  );
  return dir;
}

const ZOD = `{ kind: 'zod', path: './zod' }`;

beforeAll(async () => {
  if (!existsSync(CLI)) {
    throw new Error(`Built CLI not found at ${CLI}. Run \`pnpm build\` before \`pnpm test\`.`);
  }
  await fs.mkdir(ROOT, { recursive: true });
}, 60_000);

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('generate --dry-run (item 68)', () => {
  it('leaves an ungenerated project byte-for-byte what it was', async () => {
    const dir = await project(
      'dry-fresh',
      `{ kind: 'orpc' }, ${ZOD}, { kind: 'service', path: './svc' }`
    );
    const before = await tree(dir);

    const r = await run(['generate', '--dry-run'], dir);
    expect(r.code).toBe(0);

    const after = await tree(dir);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [key, contents] of before) expect(after.get(key)).toBe(contents);
  }, 180_000);

  it('still says what it would have written, on stdout, one path per line', async () => {
    const dir = await project('dry-list', ZOD);
    const r = await run(['generate', '--dry-run'], dir);
    const lines = r.stdout.split('\n').filter(Boolean);
    expect(lines.every((l) => l.startsWith('  - '))).toBe(true);
    expect(lines.some((l) => l.endsWith(path.join('zod', 'users.zod.ts')))).toBe(true);
    expect(lines.some((l) => l.endsWith(path.join('zod', 'index.ts')))).toBe(true);
  }, 180_000);

  it('says nothing was written, and does not claim to have generated anything', async () => {
    const dir = await project('dry-words', ZOD);
    const r = await run(['generate', '--dry-run'], dir);
    expect(r.stderr).toContain('Nothing was written');
    expect(r.stderr).toContain('Would write (zod)');
    expect(r.stderr).not.toContain('Generated (zod)');
  }, 180_000);

  it('exits 0 even when everything would change, because that is the answer and not a finding', async () => {
    // The distinction from `--check`, which is the flag whose question is "is anything stale".
    const dir = await project('dry-exit', ZOD);
    const fresh = await run(['generate', '--dry-run'], dir);
    expect(fresh.code).toBe(0);
    await run(['generate'], dir);
    const clean = await run(['generate', '--dry-run'], dir);
    expect(clean.code).toBe(0);
  }, 240_000);

  it('carries the verdicts and a dryRun flag in the --json document', async () => {
    const dir = await project('dry-json', ZOD);
    const r = await run(['generate', '--dry-run', '--json'], dir);
    const doc = JSON.parse(r.stdout);
    expect(doc.dryRun).toBe(true);
    expect(doc.exitCode).toBe(0);
    expect(doc.check).toBeNull();
    const zod = doc.generators.find((g: any) => g.kind === 'zod');
    expect(zod.files.length).toBe(zod.changes.length);
    expect(zod.changes.every((c: any) => c.status === 'created')).toBe(true);
    // Relative, so a document is readable and comparable across machines.
    expect(zod.changes[0].file.startsWith('/')).toBe(false);
  }, 180_000);
});

describe('generate reports what changed (item 80)', () => {
  it('calls a first run created and a repeat run unchanged', async () => {
    const dir = await project('verdicts', ZOD);
    const first = await run(['generate'], dir);
    expect(first.stderr).toContain('2 created');

    const second = await run(['generate'], dir);
    expect(second.stderr).toContain('2 unchanged');
    expect(second.stderr).not.toContain('created');
  }, 240_000);

  it('separates created from changed from unchanged in one run', async () => {
    const dir = await project('verdicts-mixed', ZOD);
    await run(['generate'], dir);
    await fs.appendFile(path.join(dir, 'src', 'db', 'schema.ts'), EXTRA_TABLE, 'utf8');

    const r = await run(['generate'], dir);
    // A new table adds its own module, rewrites the barrel, and leaves the other module alone.
    expect(r.stderr).toContain('1 created, 1 changed, 1 unchanged');
    expect(r.stderr).toContain('+ ' + path.join('zod', 'posts.zod.ts'));
    expect(r.stderr).toContain('~ ' + path.join('zod', 'index.ts'));
    // The unchanged one is counted and not listed: the list is what changed.
    expect(r.stderr).not.toContain('~ ' + path.join('zod', 'users.zod.ts'));
  }, 240_000);

  it('keeps the file list on stdout in the shape it has always had', async () => {
    // The verdicts are narration on stderr. stdout stays the answer, so anything parsing
    // `drzl generate > files.txt` is unaffected.
    const dir = await project('verdicts-stdout', ZOD);
    const r = await run(['generate'], dir);
    for (const line of r.stdout.split('\n').filter(Boolean)) {
      expect(line.startsWith('  - ')).toBe(true);
      expect(path.isAbsolute(line.slice(4))).toBe(true);
    }
  }, 180_000);

  it('puts a per-file status in the --json document', async () => {
    const dir = await project('verdicts-json', ZOD);
    await run(['generate'], dir);
    await fs.appendFile(path.join(dir, 'src', 'db', 'schema.ts'), EXTRA_TABLE, 'utf8');
    const r = await run(['generate', '--json'], dir);
    const doc = JSON.parse(r.stdout);
    const changes: Array<{ file: string; status: string }> = doc.generators[0].changes;
    const byStatus = (s: string) => changes.filter((c) => c.status === s).map((c) => c.file);
    expect(byStatus('created')).toEqual([path.join('zod', 'posts.zod.ts')]);
    expect(byStatus('changed')).toEqual([path.join('zod', 'index.ts')]);
    expect(byStatus('unchanged')).toEqual([path.join('zod', 'users.zod.ts')]);
  }, 240_000);

  it('stays silent on success under --quiet', async () => {
    const dir = await project('verdicts-quiet', ZOD);
    const r = await run(['generate', '--quiet'], dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  }, 180_000);
});

describe('generate --check prints a diff (item 81)', () => {
  it('names the file and shows the changed lines when someone edited generated output', async () => {
    const dir = await project('check-handedit', ZOD);
    await run(['generate'], dir);

    const target = path.join(dir, 'zod', 'users.zod.ts');
    const original = await fs.readFile(target, 'utf8');
    await fs.writeFile(target, original.replace('z.string()', 'z.string().min(1)'), 'utf8');

    const r = await run(['generate', '--check'], dir);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('out of date');
    // The file, named twice: once in the list, once in the diff header.
    expect(r.stderr).toContain('~ changed  ' + path.join('zod', 'users.zod.ts'));
    expect(r.stderr).toContain('--- a/' + path.join('zod', 'users.zod.ts'));
    expect(r.stderr).toContain('+++ b/' + path.join('zod', 'users.zod.ts'));
    // The changed lines, in both directions.
    expect(r.stderr).toContain('-  email: z.string().min(1),');
    expect(r.stderr).toContain('+  email: z.string(),');
    // A hunk header, so the diff is greppable and applies.
    expect(/@@ -\d+,\d+ \+\d+,\d+ @@/.test(r.stderr)).toBe(true);
  }, 240_000);

  it('shows a whole new file as an addition when the schema gained a table', async () => {
    const dir = await project('check-newtable', ZOD);
    await run(['generate'], dir);
    await fs.appendFile(path.join(dir, 'src', 'db', 'schema.ts'), EXTRA_TABLE, 'utf8');

    const r = await run(['generate', '--check'], dir);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('+ added    ' + path.join('zod', 'posts.zod.ts'));
    expect(r.stderr).toContain('@@ -0,0 +1,');
    expect(r.stderr).toContain('+export const InsertpostsSchema');
  }, 240_000);

  it('writes nothing at all, so the hand-edit and the stale tree both survive', async () => {
    // Stronger than the old guarantee. `--check` used to regenerate over the tree and restore it
    // from a snapshot, so the window between the two was a tree in an intermediate state; now
    // there is no write to restore from.
    const dir = await project('check-nowrites', ZOD);
    await run(['generate'], dir);

    const target = path.join(dir, 'zod', 'users.zod.ts');
    const edited = (await fs.readFile(target, 'utf8')).replace('z.string()', 'z.string().min(1)');
    await fs.writeFile(target, edited, 'utf8');
    const before = await tree(dir);

    const r = await run(['generate', '--check'], dir);
    expect(r.code).toBe(2);

    const after = await tree(dir);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [key, contents] of before) expect(after.get(key)).toBe(contents);
  }, 240_000);

  it('exits 0 and prints no diff on a tree that is up to date', async () => {
    const dir = await project('check-clean', ZOD);
    await run(['generate'], dir);
    const r = await run(['generate', '--check'], dir);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('up to date');
    expect(r.stderr).not.toContain('@@');
  }, 240_000);

  it('keeps the drift list under --quiet and drops the diff', async () => {
    // The list is the finding, which a `2` with nothing to read makes unusable. The diff is the
    // explanation, which is what `--quiet` is asking to be spared.
    const dir = await project('check-quiet', ZOD);
    await run(['generate'], dir);
    const target = path.join(dir, 'zod', 'users.zod.ts');
    const original = await fs.readFile(target, 'utf8');
    await fs.writeFile(target, original.replace('z.string()', 'z.string().min(1)'), 'utf8');

    const r = await run(['generate', '--check', '--quiet'], dir);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('~ changed  ' + path.join('zod', 'users.zod.ts'));
    expect(r.stderr).not.toContain('@@');
  }, 240_000);

  it('carries the diff and the cap in the --json document', async () => {
    const dir = await project('check-json', ZOD);
    await run(['generate'], dir);
    const target = path.join(dir, 'zod', 'users.zod.ts');
    const original = await fs.readFile(target, 'utf8');
    await fs.writeFile(target, original.replace('z.string()', 'z.string().min(1)'), 'utf8');

    const r = await run(['generate', '--check', '--json'], dir);
    const doc = JSON.parse(r.stdout);
    expect(doc.exitCode).toBe(2);
    expect(doc.check.upToDate).toBe(false);
    expect(doc.check.diffFileCap).toBeGreaterThan(0);
    const entry = doc.check.drift[0];
    expect(entry.file).toBe(path.join('zod', 'users.zod.ts'));
    expect(entry.status).toBe('changed');
    expect(entry.diff).toContain('@@');
    expect(entry.diff).toContain('+  email: z.string(),');
  }, 240_000);
});

describe('one analysis per run (item 82)', () => {
  it('analyses once however many generators are configured', async () => {
    // The plan item says "if it is not already shared", and it is: the analysis is built once in
    // `generate` and handed to every generator's constructor. This is the guard that says so, so
    // a future refactor that moved the analyzer inside the loop would fail here rather than
    // quietly multiplying the cost by the number of generators.
    const one = await project('shared-one', ZOD);
    const many = await project(
      'shared-many',
      `${ZOD}, { kind: 'valibot', path: './valibot' }, { kind: 'arktype', path: './arktype' }, ` +
        `{ kind: 'typebox', path: './typebox' }, { kind: 'effect', path: './effect' }`
    );

    const rOne = await run(['generate'], one);
    const rMany = await run(['generate'], many);

    const analyses = (text: string) => text.split('Analysis complete in').length - 1;
    expect(analyses(rOne.stderr)).toBe(1);
    expect(analyses(rMany.stderr)).toBe(1);
    // Five generators really did run, so the single analysis is not a single generator.
    expect(rMany.stderr.split('Generated (').length - 1).toBe(5);
  }, 300_000);
});
