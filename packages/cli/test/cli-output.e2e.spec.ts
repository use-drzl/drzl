/**
 * What the CLI writes, to which stream, in what shape (plan items 72, 73, 74, 76, 77).
 *
 * Every assertion here is on bytes rather than on a screenshot of a terminal. "No colour leaked
 * into the pipe" is `indexOf(0x1b) === -1` on the captured buffer, because a visual check of a
 * terminal is exactly the check that cannot see an escape sequence: the terminal consumes it.
 *
 * The colour rules are exercised through ordinary pipes, with no pseudo-terminal, because
 * `FORCE_COLOR=1` turns colour on where a pipe would have it off. That is what makes
 * `NO_COLOR` testable at all: on a pipe with nothing forced there is no colour to refuse, so a
 * green run would prove nothing. Every "no escapes" assertion is therefore paired with a run that
 * must produce escapes, or the assertion could pass against a CLI that had stopped printing.
 *
 * The two assertions that genuinely need a terminal (a progress bar appears, a spinner appears)
 * use `script(1)`, and skip themselves where it is not installed. The window size is set from
 * inside the session on purpose: a pty opened with no size reports zero columns, and `ora` divides
 * by the width to decide how many lines to erase, so a zero there made the CLI emit 180MB of erase
 * sequences in 30 seconds and never finish.
 *
 * Requires a build. CI builds before testing; locally, run `pnpm build` first.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';

const CLI = path.resolve(__dirname, '..', 'dist', 'cli.js');
const ROOT = path.join(__dirname, '.tmp-output');

const ESC = 0x1b;

interface Run {
  code: number;
  out: Buffer;
  err: Buffer;
  outText: string;
  errText: string;
}

/**
 * Run the built CLI with both streams on their own pipe and keep the raw bytes.
 *
 * The three variables under test are removed from the inherited environment before `env` is
 * applied, because the shell a developer runs `pnpm test` from may well export one of them. This
 * one exports `FORCE_COLOR=3`, which turns every row of the matrix into an apparent colour leak.
 */
function run(args: string[], opts: { cwd: string; env?: Record<string, string> } = { cwd: ROOT }) {
  return new Promise<Run>((resolve, reject) => {
    const env: Record<string, string | undefined> = { ...process.env, ...(opts.env ?? {}) };
    for (const key of ['CI', 'NO_COLOR', 'FORCE_COLOR']) {
      if (!(key in (opts.env ?? {}))) delete env[key];
    }
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: opts.cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      const o = Buffer.concat(out);
      const e = Buffer.concat(err);
      resolve({ code: code ?? -1, out: o, err: e, outText: o.toString('utf8'), errText: e.toString('utf8') });
    });
  });
}

/** True when `script(1)` can give a command a real terminal on both streams. */
async function hasScript(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('script', ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/** Run the CLI with stdout and stderr on one pty of a known size. Output is the merged stream. */
function runTty(args: string[], cwd: string, extraEnv: Record<string, string> = {}) {
  return new Promise<{ code: number; text: string }>((resolve, reject) => {
    const env: Record<string, string | undefined> = { ...process.env, ...extraEnv };
    for (const key of ['CI', 'NO_COLOR', 'FORCE_COLOR']) {
      if (!(key in extraEnv)) delete env[key];
    }
    const inner = `stty rows 24 cols 80; ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} ${args
      .map((a) => JSON.stringify(a))
      .join(' ')}`;
    const child = spawn('script', ['-qec', inner, '/dev/null'], {
      cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, text: Buffer.concat(chunks).toString('utf8') }));
  });
}

const SCHEMA_HEAD = `import { pgTable, integer, serial, text, customType, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const money = customType<{ data: string; driverData: string }>({ dataType: () => 'numeric(12,2)' });

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
});

export const invoices = pgTable(
  'invoices',
  {
    id: integer().primaryKey(),
    reference: text().notNull(),
    balance: money().notNull(),
  },
  (t) => [check('ref_or_id', sql\`\${t.reference} <> '' OR \${t.id} > 0\`)]
);
`;

/** A project with `tables` plain tables, for the progress-bar threshold. */
function wideSchema(tables: number): string {
  const lines = [`import { pgTable, serial, text } from 'drizzle-orm/pg-core';`];
  for (let i = 0; i < tables; i++) {
    lines.push(
      `export const t${i} = pgTable('t${i}', { id: serial('id').primaryKey(), a: text('a') });`
    );
  }
  return lines.join('\n') + '\n';
}

/** A fresh project directory. Lives under this package so drizzle-orm resolves normally. */
async function project(name: string, schema = SCHEMA_HEAD, withConfig = true) {
  const dir = path.join(ROOT, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'src', 'db'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'db', 'schema.ts'), schema, 'utf8');
  if (withConfig) {
    await fs.writeFile(
      path.join(dir, 'drzl.config.ts'),
      `export default {
         schema: './src/db/schema.ts',
         outDir: './out',
         analyzer: { includeRelations: true, validateConstraints: true },
         generators: [{ kind: 'zod', path: './zod' }],
       };`,
      'utf8'
    );
  }
  return dir;
}

let script = false;

beforeAll(async () => {
  if (!existsSync(CLI)) {
    throw new Error(`Built CLI not found at ${CLI}. Run \`pnpm build\` before \`pnpm test\`.`);
  }
  await fs.mkdir(ROOT, { recursive: true });
  script = await hasScript();
}, 60_000);

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

/** Every command, with an invocation that reaches its real work rather than its usage text. */
const COMMANDS: Array<{ name: string; args: string[] }> = [
  { name: 'analyze', args: ['analyze', 'src/db/schema.ts'] },
  { name: 'doctor', args: ['doctor', 'src/db/schema.ts'] },
  { name: 'generate', args: ['generate'] },
  { name: 'generate:orpc', args: ['generate:orpc', 'src/db/schema.ts', '--outDir', 'out-orpc'] },
  { name: 'generate:trpc', args: ['generate:trpc', 'src/db/schema.ts', '--outDir', 'out-trpc'] },
];

describe('item 77: no escape sequence reaches a stream that is not a terminal', () => {
  for (const { name, args } of COMMANDS) {
    it(`${name} writes no escapes to either pipe`, async () => {
      const dir = await project(`esc-${name.replace(':', '-')}`);
      const r = await run(args, { cwd: dir });
      expect(r.out.indexOf(ESC), `stdout of ${name}: ${JSON.stringify(r.outText.slice(0, 300))}`).toBe(-1);
      expect(r.err.indexOf(ESC), `stderr of ${name}: ${JSON.stringify(r.errText.slice(0, 300))}`).toBe(-1);
    }, 120_000);
  }

  it('the failure paths are colourless through a pipe too', async () => {
    const dir = await project('esc-fail');
    const missing = await run(['analyze', 'no-such.ts'], { cwd: dir });
    expect(missing.out.indexOf(ESC)).toBe(-1);
    expect(missing.err.indexOf(ESC)).toBe(-1);

    const noConfig = await run(['generate', '--config', 'no-such.config.ts'], { cwd: dir });
    expect(noConfig.out.indexOf(ESC)).toBe(-1);
    expect(noConfig.err.indexOf(ESC)).toBe(-1);
  }, 120_000);

  // Without this the assertions above hold just as well against a CLI that prints nothing at all,
  // and against one whose colour was removed rather than gated.
  it('the same commands do emit colour when it is asked for, so the checks above are not vacuous', async () => {
    const dir = await project('esc-forced');
    const r = await run(['generate'], { cwd: dir, env: { FORCE_COLOR: '1' } });
    expect(r.out.indexOf(ESC)).toBeGreaterThan(-1);
    expect(r.err.indexOf(ESC)).toBeGreaterThan(-1);
  }, 120_000);
});

describe('item 76: NO_COLOR', () => {
  it('turns colour off on a pipe that FORCE_COLOR would have turned on', async () => {
    const dir = await project('nc-generate');
    const forced = await run(['generate'], { cwd: dir, env: { FORCE_COLOR: '1' } });
    expect(forced.err.indexOf(ESC)).toBeGreaterThan(-1);

    const refused = await run(['generate'], { cwd: dir, env: { FORCE_COLOR: '1', NO_COLOR: '1' } });
    expect(refused.out.indexOf(ESC)).toBe(-1);
    expect(refused.err.indexOf(ESC)).toBe(-1);
  }, 120_000);

  it('is honoured by every command, including the ones that only print a report', async () => {
    const dir = await project('nc-all');
    for (const { name, args } of COMMANDS) {
      const r = await run(args, { cwd: dir, env: { FORCE_COLOR: '1', NO_COLOR: '1' } });
      expect(r.out.indexOf(ESC), `stdout of ${name}`).toBe(-1);
      expect(r.err.indexOf(ESC), `stderr of ${name}`).toBe(-1);
    }
  }, 240_000);

  it('an empty NO_COLOR is not set, which is what no-color.org says', async () => {
    const dir = await project('nc-empty');
    const r = await run(['generate'], { cwd: dir, env: { FORCE_COLOR: '1', NO_COLOR: '' } });
    expect(r.err.indexOf(ESC)).toBeGreaterThan(-1);
  }, 120_000);

  it('a terminal still gets colour when nothing refuses it', async () => {
    if (!script) return;
    const dir = await project('nc-tty');
    const r = await runTty(['doctor', 'src/db/schema.ts'], dir);
    expect(r.text).toContain('[');
  }, 120_000);

  it('and none when NO_COLOR is set, on that same terminal', async () => {
    if (!script) return;
    const dir = await project('nc-tty-off');
    const loud = await runTty(['doctor', 'src/db/schema.ts'], dir);
    expect(loud.text).toContain('[');
    const off = await runTty(['doctor', 'src/db/schema.ts'], dir, { NO_COLOR: '1' });
    // The report itself, with no SGR sequence anywhere in it. `script` echoes nothing of its own.
    expect(off.text).toContain('DRZL doctor');
    expect(off.text).not.toContain('[3');
  }, 120_000);

  // Cursor moves and line erases are not colour, and a spinner has to make them to be a spinner.
  // So this asserts on SGR sequences alone, which is the only kind NO_COLOR speaks about. It
  // covers the spinner frame in particular: ora paints that one through a chalk of its own, and
  // with the variable set everything else on the line went plain while the frame still arrived as
  // an escape-wrapped cyan glyph.
  it('leaves cursor control alone and removes only the colour', async () => {
    if (!script) return;
    const dir = await project('nc-sgr', wideSchema(30));
    const sgr = /\[[0-9;]*m/;
    const loud = await runTty(['generate'], dir);
    expect(loud.text).toMatch(sgr);
    const off = await runTty(['generate'], dir, { NO_COLOR: '1' });
    expect(off.text).toContain('Analysis complete');
    expect(off.text).not.toMatch(sgr);
  }, 300_000);
});

describe('item 72: the progress bar', () => {
  const GLYPHS = /[█░]/;

  it('is absent for a single table on a terminal', async () => {
    if (!script) return;
    const dir = await project('bar-one', wideSchema(1));
    const r = await runTty(['generate'], dir);
    expect(r.text).not.toMatch(GLYPHS);
  }, 180_000);

  it('appears once there are enough tables for it to move', async () => {
    if (!script) return;
    const dir = await project('bar-many', wideSchema(30));
    const r = await runTty(['generate'], dir);
    expect(r.text).toMatch(GLYPHS);
  }, 240_000);

  it('never appears when the stream is not a terminal, however many tables there are', async () => {
    const dir = await project('bar-pipe', wideSchema(30));
    const r = await run(['generate'], { cwd: dir });
    expect(r.outText).not.toMatch(GLYPHS);
    expect(r.errText).not.toMatch(GLYPHS);
  }, 240_000);

  it('is gone under --quiet on a terminal', async () => {
    if (!script) return;
    const dir = await project('bar-quiet', wideSchema(30));
    const r = await runTty(['generate', '--quiet'], dir);
    expect(r.text).not.toMatch(GLYPHS);
  }, 240_000);
});

describe('item 73: --json is one document on stdout, for every command', () => {
  const JSON_COMMANDS: Array<{ name: string; args: string[] }> = [
    { name: 'analyze', args: ['analyze', 'src/db/schema.ts', '--json'] },
    { name: 'doctor', args: ['doctor', 'src/db/schema.ts', '--json'] },
    { name: 'generate', args: ['generate', '--json'] },
    { name: 'generate:orpc', args: ['generate:orpc', 'src/db/schema.ts', '--outDir', 'o', '--json'] },
    { name: 'generate:trpc', args: ['generate:trpc', 'src/db/schema.ts', '--outDir', 't', '--json'] },
    { name: 'init', args: ['init', '--yes', '--json'] },
  ];

  for (const { name, args } of JSON_COMMANDS) {
    it(`${name} --json parses with no filtering`, async () => {
      const dir = await project(`json-${name.replace(':', '-')}`, SCHEMA_HEAD, name !== 'init');
      const r = await run(args, { cwd: dir });
      expect(r.out.indexOf(ESC)).toBe(-1);
      expect(() => JSON.parse(r.outText)).not.toThrow();
    }, 120_000);
  }

  it('a failure is a document too, not prose on stderr', async () => {
    const dir = await project('json-fail');
    const r = await run(['generate', '--config', 'no-such.config.ts', '--json'], { cwd: dir });
    const doc = JSON.parse(r.outText);
    expect(doc.ok).toBe(false);
    expect(doc.command).toBe('generate');
    expect(typeof doc.code).toBe('string');
    expect(typeof doc.message).toBe('string');
    expect(doc.exitCode).toBe(r.code);
  }, 120_000);

  it('every document names its command and repeats the process exit code', async () => {
    const dir = await project('json-envelope');
    const cases: Array<[string[], string]> = [
      [['analyze', 'src/db/schema.ts', '--json'], 'analyze'],
      [['doctor', 'src/db/schema.ts', '--json'], 'doctor'],
      [['generate', '--json'], 'generate'],
      [['generate:orpc', 'src/db/schema.ts', '--outDir', 'o', '--json'], 'generate:orpc'],
      [['generate:trpc', 'src/db/schema.ts', '--outDir', 't', '--json'], 'generate:trpc'],
    ];
    for (const [args, command] of cases) {
      const r = await run(args, { cwd: dir });
      const doc = JSON.parse(r.outText);
      expect(doc.command, args.join(' ')).toBe(command);
      expect(doc.exitCode, args.join(' ')).toBe(r.code);
    }
  }, 300_000);

  it("doctor's own `ok` still means the schema is clean, not that the run worked", async () => {
    const dir = await project('json-doctor-ok');
    // This schema carries an untypeable customType and a CHECK using OR, so there are findings.
    const withFindings = JSON.parse(
      (await run(['doctor', 'src/db/schema.ts', '--json'], { cwd: dir })).outText
    );
    expect(withFindings.ok).toBe(false);
    expect(withFindings.exitCode).toBe(0);
    expect(withFindings.findings.length).toBeGreaterThan(0);
  }, 120_000);

  it('the sponsor tip never reaches stdout, with or without --json', async () => {
    const dir = await project('json-sponsor');
    const plain = await run(['generate'], { cwd: dir });
    expect(plain.outText).not.toContain('Sponsors keep DRZL shipping');
    const asJson = await run(['generate', '--json'], { cwd: dir });
    expect(asJson.outText).not.toContain('Sponsors keep DRZL shipping');
  }, 120_000);

  it('--json keeps stdout to the document even when there are warnings to print', async () => {
    // This schema carries an untypeable customType, so the human run prints a warning block.
    const dir = await project('json-warn');
    const human = await run(['generate'], { cwd: dir });
    expect(human.errText).toContain('could not be typed');
    const asJson = await run(['generate', '--json'], { cwd: dir });
    expect(asJson.errText).toBe('');
    const doc = JSON.parse(asJson.outText);
    expect(doc.warnings.join(' ')).toContain('could not be typed');
  }, 120_000);
});

describe('item 73: --quiet is quiet, not silent', () => {
  it('drops the narration and keeps the answer', async () => {
    const dir = await project('quiet-analyze');
    const loud = await run(['analyze', 'src/db/schema.ts'], { cwd: dir });
    const quiet = await run(['analyze', 'src/db/schema.ts', '--quiet'], { cwd: dir });
    expect(quiet.errText).toBe('');
    expect(quiet.outText).toBe(loud.outText);
    expect(quiet.code).toBe(loud.code);
  }, 120_000);

  it('still reports a failure, and still exits non-zero', async () => {
    const dir = await project('quiet-fail');
    const r = await run(['generate', '--config', 'no-such.config.ts', '--quiet'], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.errText.length).toBeGreaterThan(0);
    expect(r.errText).toContain('DRZL_CFG_001');
  }, 120_000);

  it('is available on every command', async () => {
    const dir = await project('quiet-all');
    for (const { name, args } of COMMANDS) {
      const r = await run([...args, '--quiet'], { cwd: dir });
      expect(r.code, `${name} --quiet should not be a usage error`).not.toBe(1);
    }
    const init = await run(['init', '--yes', '--quiet'], {
      cwd: await project('quiet-init', SCHEMA_HEAD, false),
    });
    expect(init.code).toBe(0);
    expect(init.errText).toBe('');
  }, 240_000);
});

describe('item 74: exit codes', () => {
  it('0 when the command did what it was asked', async () => {
    const dir = await project('exit-ok');
    expect((await run(['analyze', 'src/db/schema.ts'], { cwd: dir })).code).toBe(0);
    expect((await run(['doctor', 'src/db/schema.ts'], { cwd: dir })).code).toBe(0);
    expect((await run(['generate'], { cwd: dir })).code).toBe(0);
    expect((await run(['generate', '--check'], { cwd: dir })).code).toBe(0);
  }, 240_000);

  it('1 when DRZL could not run', async () => {
    const dir = await project('exit-failed');
    expect((await run(['generate', '--config', 'nope.config.ts'], { cwd: dir })).code).toBe(1);
    expect((await run(['doctor', 'no-such.ts'], { cwd: dir })).code).toBe(1);
    // A schema path that is not there is not a schema with problems: it is a run that could not
    // happen. `generate:orpc` used to write a placeholder file and exit 0 for exactly this.
    expect((await run(['generate:orpc', 'no-such.ts', '--outDir', 'o'], { cwd: dir })).code).toBe(1);
    expect((await run(['generate:trpc', 'no-such.ts', '--outDir', 't'], { cwd: dir })).code).toBe(1);
  }, 240_000);

  it('2 when it ran fine and found what it was asked to look for', async () => {
    const dir = await project('exit-findings');
    // A customType the analyzer cannot type is a finding, and --strict is the opt-in.
    expect((await run(['doctor', 'src/db/schema.ts', '--strict'], { cwd: dir })).code).toBe(2);
    // Drift: generate once, edit the output, then check.
    expect((await run(['generate'], { cwd: dir })).code).toBe(0);
    await fs.appendFile(path.join(dir, 'zod', 'users.zod.ts'), '\n// edited by hand\n', 'utf8');
    expect((await run(['generate', '--check'], { cwd: dir })).code).toBe(2);
  }, 240_000);

  it('a missing schema is 1 from every command that takes one', async () => {
    const dir = await project('exit-missing');
    for (const args of [
      ['analyze', 'no-such.ts'],
      ['doctor', 'no-such.ts'],
      ['generate:orpc', 'no-such.ts', '--outDir', 'o'],
      ['generate:trpc', 'no-such.ts', '--outDir', 't'],
    ]) {
      const r = await run(args, { cwd: dir });
      expect(r.code, `${args.join(' ')}`).toBe(1);
    }
  }, 240_000);

  it('the JSON document reports the same code the process returns', async () => {
    const dir = await project('exit-json');
    for (const args of [
      ['doctor', 'src/db/schema.ts', '--strict', '--json'],
      ['analyze', 'no-such.ts', '--json'],
      ['generate', '--config', 'nope.config.ts', '--json'],
    ]) {
      const r = await run(args, { cwd: dir });
      const doc = JSON.parse(r.outText);
      expect(doc.exitCode, `${args.join(' ')}`).toBe(r.code);
    }
  }, 240_000);
});

describe('the stream rule: stdout is the answer, stderr is the narration', () => {
  it('analyze puts the analysis on stdout and the spinner line on stderr', async () => {
    const dir = await project('stream-analyze');
    const r = await run(['analyze', 'src/db/schema.ts'], { cwd: dir });
    expect(() => JSON.parse(r.outText)).not.toThrow();
    expect(r.errText).toContain('Analyzed in');
  }, 120_000);

  it('generate keeps warnings and progress off stdout', async () => {
    const dir = await project('stream-generate');
    const r = await run(['generate'], { cwd: dir });
    expect(r.outText).not.toContain('could not be typed');
    expect(r.errText).toContain('could not be typed');
  }, 120_000);

  it('every failure message is on stderr, and stdout stays empty', async () => {
    const dir = await project('stream-fail');
    const r = await run(['generate', '--config', 'nope.config.ts'], { cwd: dir });
    expect(r.outText).toBe('');
    expect(r.errText).toContain('DRZL_CFG_001');
  }, 120_000);
});
