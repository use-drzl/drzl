/**
 * `drzl doctor` spawned as a real process, which is the only thing that proves the command exists.
 *
 * The unit file beside this one exercises the report builder. Nothing there would notice a command
 * that was never registered, a `--json` branch that prints the human report, or an exit code that
 * fails a user's CI on a schema whose only sin is a `customType`. Those are the failures this file
 * is for.
 *
 * Requires a build, like the other end-to-end files here: CI builds before testing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';

const CLI = path.resolve(__dirname, '..', 'dist', 'cli.js');
const ROOT = path.join(__dirname, '.tmp-doctor-e2e');

const PROBLEM = `
import { sql } from 'drizzle-orm';
import { check, customType, integer, pgTable, serial, text } from 'drizzle-orm/pg-core';
const money = customType({ dataType: () => 'numeric(12,2)' });
export const accounts = pgTable(
  'accounts',
  {
    id: serial('id').primaryKey(),
    balance: money('balance').notNull(),
    age: integer('age'),
    email: text('email').notNull(),
  },
  (t) => [
    check('age_adult', sql\`\${t.age} >= 18\`),
    check('age_or', sql\`\${t.age} >= 18 OR \${t.age} <= 65\`),
    check('email_re', sql\`\${t.email} ~ '^[a-z]+$'\`),
  ]
);
`;

const CLEAN = `
import { pgTable, serial, text } from 'drizzle-orm/pg-core';
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
});
`;

/**
 * Run the CLI and return its code and streams instead of throwing.
 *
 * `execFile` rejects on a non-zero exit, and the exit code is half of what this file asserts, so
 * a rejection has to be read rather than propagated.
 */
function cli(args: string[], cwd: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ code: (err as { code?: number } | null)?.code ?? 0, stdout, stderr });
      }
    );
  });
}

async function project(name: string, schema: string) {
  const dir = path.join(ROOT, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'src', 'db'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'db', 'schema.ts'), schema, 'utf8');
  return dir;
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

describe('drzl doctor', () => {
  it('reports the untypeable column and both declined checks, and exits 0', async () => {
    const dir = await project('problem', PROBLEM);
    const r = await cli(['doctor', 'src/db/schema.ts'], dir);

    // Zero on purpose. A schema carrying a customType is normal and usable, and a doctor that
    // failed every pipeline reading it would be turned off within a week.
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('balance');
    expect(r.stdout).toContain('numeric(12,2)');
    expect(r.stdout).toContain('age_or');
    expect(r.stdout).toContain('email_re');
    // The one check DRZL really enforces is not listed as a problem.
    expect(r.stdout).not.toContain('age_adult');
  }, 120_000);

  it('exits 2 under --strict, so a pipeline can gate on it by choice', async () => {
    const dir = await project('strict', PROBLEM);
    const r = await cli(['doctor', 'src/db/schema.ts', '--strict'], dir);
    expect(r.code).toBe(2);
  }, 120_000);

  it('says so, and exits 0, on a schema with nothing wrong', async () => {
    const dir = await project('clean', CLEAN);
    const r = await cli(['doctor', 'src/db/schema.ts'], dir);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Nothing to report');

    const strict = await cli(['doctor', 'src/db/schema.ts', '--strict'], dir);
    expect(strict.code, 'a clean schema passes --strict').toBe(0);
  }, 120_000);

  it('emits the report as JSON under --json, and nothing else on stdout', async () => {
    const dir = await project('json', PROBLEM);
    const r = await cli(['doctor', 'src/db/schema.ts', '--json'], dir);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.dialect).toBe('postgres');
    expect(parsed.counts.findings).toBe(parsed.findings.length);
    expect(parsed.findings.map((f: { kind: string }) => f.kind)).toContain('check-declined');
  }, 120_000);

  it('exits 1 when the schema file is not there, rather than reporting a clean schema', async () => {
    const dir = await project('missing', CLEAN);
    const r = await cli(['doctor', 'src/db/nope.ts'], dir);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).not.toContain('Nothing to report');
    // Naming the path it could not read. Without this the test also passes when the command does
    // not exist at all, since commander exits 1 for an unknown command too.
    expect(r.stdout + r.stderr).toContain('nope.ts');
  }, 120_000);

  it('reads the schema path from drzl.config.ts when no argument is given', async () => {
    const dir = await project('config', PROBLEM);
    await fs.writeFile(
      path.join(dir, 'drzl.config.ts'),
      `export default {
         schema: './src/db/schema.ts',
         outDir: './out',
         generators: [{ kind: 'zod', path: './zod' }],
       };`,
      'utf8'
    );
    const r = await cli(['doctor'], dir);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('age_or');
    // The schema named in the config, not a guess at one.
    expect(r.stdout).toContain('src/db/schema.ts');
  }, 120_000);

  it('says what is wrong with the config rather than reporting a clean schema', async () => {
    const dir = await project('bad-config', PROBLEM);
    await fs.writeFile(
      path.join(dir, 'drzl.config.ts'),
      `export default { schema: './src/db/schema.ts', outDir: './out', generators: [] };`,
      'utf8'
    );
    const r = await cli(['doctor'], dir);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toContain('generators');
    expect(r.stdout + r.stderr).not.toContain('Nothing to report');
  }, 120_000);

  it('says which flag to pass when there is neither an argument nor a config', async () => {
    const dir = await project('nothing', CLEAN);
    const r = await cli(['doctor'], dir);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/schema/i);
  }, 120_000);
});
