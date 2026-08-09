/**
 * `drzl watch` and the terminal it is running in (plan item 75).
 *
 * The old behaviour was `if (!opts.json) console.clear()` at the top of every rebuild. Three
 * things were wrong with it and only the first is what the plan item names:
 *
 *  - it was not optional, so every rebuild threw away the previous rebuild's errors and the
 *    startup banner naming the watched directories
 *  - it was decided from stdout's `isTTY` while everything a human reads is on stderr, so
 *    `drzl watch > events.json` on a terminal cleared nothing, and the stream it was aimed at was
 *    the one carrying the JSON
 *  - the escape went to a stream a program may be parsing. Node's own `isTTY` check is what kept
 *    that harmless, so the assertion below is on bytes rather than on the flag
 *
 * Every assertion is `indexOf(0x1b)` on a captured buffer, because a visual check of a terminal is
 * exactly the check that cannot see an escape sequence: the terminal consumes it.
 *
 * Requires a build. CI builds before testing; locally, run `pnpm build` first.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';

const CLI = path.resolve(__dirname, '..', 'dist', 'cli.js');
const ROOT = path.join(__dirname, '.tmp-watch-clear');
const ESC = 0x1b;

const SCHEMA = `
import { pgTable, serial, text } from 'drizzle-orm/pg-core';
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
});
`;

async function project(name: string) {
  const dir = path.join(ROOT, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'src', 'db'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'db', 'schema.ts'), SCHEMA, 'utf8');
  await fs.writeFile(
    path.join(dir, 'drzl.config.ts'),
    `export default { schema: './src/db/schema.ts', outDir: './out', generators: [{ kind: 'zod', path: './zod' }] };`,
    'utf8'
  );
  return dir;
}

/**
 * Start a watcher on ordinary pipes, let the startup build finish, then stop it.
 *
 * The watcher never exits on its own, so the run is bounded by the file it is waiting to produce
 * rather than by a sleep: `zod/index.ts` appearing means one rebuild has completed.
 */
function watchOnPipes(args: string[], cwd: string) {
  return new Promise<{ out: Buffer; err: Buffer }>((resolve, reject) => {
    const env = { ...process.env, DRZL_HIDE_SPONSOR: '1' } as NodeJS.ProcessEnv;
    // Removed rather than overridden: this shell exports FORCE_COLOR=3, which would turn an
    // assertion about a pipe carrying no escapes into an assertion about that variable.
    delete env.FORCE_COLOR;
    delete env.NO_COLOR;
    const child = spawn(process.execPath, [CLI, 'watch', '--poll', '--debounce', '50', ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', reject);

    const done = () => {
      child.kill('SIGTERM');
      setTimeout(() => resolve({ out: Buffer.concat(out), err: Buffer.concat(err) }), 200);
    };
    const deadline = Date.now() + 60_000;
    const poll = setInterval(() => {
      if (existsSync(path.join(cwd, 'zod', 'index.ts')) || Date.now() > deadline) {
        clearInterval(poll);
        // A moment more, so anything written just after the file lands is captured too.
        setTimeout(done, 500);
      }
    }, 200);
  });
}

/** Whether `script(1)` can give a command a real terminal. */
async function hasScript(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('script', ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/** Start a watcher under a pty, wait for one rebuild, and return everything it painted. */
function watchOnTty(args: string[], cwd: string) {
  return new Promise<string>((resolve, reject) => {
    const env = { ...process.env, DRZL_HIDE_SPONSOR: '1' } as NodeJS.ProcessEnv;
    delete env.FORCE_COLOR;
    delete env.NO_COLOR;
    const inner =
      `stty rows 24 cols 80; ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} ` +
      ['watch', '--poll', '--debounce', '50', ...args].map((a) => JSON.stringify(a)).join(' ');
    const child = spawn('script', ['-qec', inner, '/dev/null'], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', reject);

    const deadline = Date.now() + 60_000;
    const poll = setInterval(() => {
      if (existsSync(path.join(cwd, 'zod', 'index.ts')) || Date.now() > deadline) {
        clearInterval(poll);
        setTimeout(() => {
          child.kill('SIGTERM');
          setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8')), 300);
        }, 500);
      }
    }, 200);
  });
}

/** The sequence `--clear` sends: erase display, erase scrollback, cursor home. */
const CLEAR = '\u001b[2J\u001b[3J\u001b[H';

/**
 * Every way this file has ever cleared a screen, so "it did not clear" is a claim about the
 * terminal rather than about one spelling.
 *
 * `console.clear()`, which is what ran here until now, is `cursorTo(0, 0)` followed by
 * `clearScreenDown`. Measured under `script(1)` on Node 22.22 that is exactly `ESC [ 1 ; 1 H`
 * then `ESC [ 0 J`, neither of which appears in the sequence `--clear` sends, so a test naming
 * only the new spelling would pass against the old behaviour it exists to forbid.
 */
const ANY_CLEAR = ['\u001b[2J', '\u001b[3J', '\u001b[0J', '\u001b[1;1H'];

beforeAll(async () => {
  if (!existsSync(CLI)) {
    throw new Error(`Built CLI not found at ${CLI}. Run \`pnpm build\` before \`pnpm test\`.`);
  }
  await fs.mkdir(ROOT, { recursive: true });
}, 60_000);

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('drzl watch and the screen', () => {
  it('does not clear when nothing asked it to', async () => {
    const dir = await project('no-clear');
    const r = await watchOnPipes([], dir);
    expect(r.err.toString('utf8')).not.toContain(CLEAR);
    expect(r.out.toString('utf8')).not.toContain(CLEAR);
  }, 120_000);

  it('sends no escape at all to a pipe, even with --clear', async () => {
    // The item 77 defect, in the one place that still wrote an escape without asking a stream
    // whether it was a terminal.
    const dir = await project('clear-piped');
    const r = await watchOnPipes(['--clear'], dir);
    expect(r.err.indexOf(ESC)).toBe(-1);
    expect(r.out.indexOf(ESC)).toBe(-1);
  }, 120_000);

  it('keeps stdout empty without --json, clear or no clear', async () => {
    const dir = await project('clear-stdout');
    const r = await watchOnPipes(['--clear'], dir);
    expect(r.out.toString('utf8')).toBe('');
  }, 120_000);

  it('leaves the --json event stream alone', async () => {
    const dir = await project('clear-json');
    const r = await watchOnPipes(['--clear', '--json'], dir);
    expect(r.out.indexOf(ESC)).toBe(-1);
    // Still one JSON object per line, which is what a program reads it as.
    for (const line of r.out.toString('utf8').split('\n').filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  }, 120_000);

  it('clears a real terminal only when --clear is passed', async () => {
    if (!(await hasScript())) return; // `script(1)` is what makes a pty available here.
    const withFlag = await watchOnTty(['--clear'], await project('tty-clear'));
    expect(withFlag).toContain(CLEAR);

    const without = await watchOnTty([], await project('tty-plain'));
    for (const sequence of ANY_CLEAR) expect(without).not.toContain(sequence);
    // And the watcher really ran in both, so "no clear" is not "nothing happened".
    expect(without).toContain('Watching:');
  }, 180_000);
});
