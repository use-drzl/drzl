/**
 * The two decisions the whole output layer rests on, exercised without spawning anything.
 *
 * `colorLevelFor` and `shouldShowProgress` are pure so that the combinations can be enumerated
 * here rather than sampled through a terminal. The end-to-end file next door proves the CLI
 * actually routes through them; this proves they are right.
 */
import { describe, expect, it } from 'vitest';
import {
  colorLevelFor,
  EXIT_FAILED,
  EXIT_FINDINGS,
  EXIT_OK,
  jsonFailure,
  messageOf,
  Output,
  PROGRESS_MIN_TABLES,
  shouldShowProgress,
} from '../src/output.js';

const tty = { write: () => {}, isTTY: true };
const pipe = { write: () => {}, isTTY: false };

describe('colorLevelFor', () => {
  it('is off on a pipe and on at a terminal', () => {
    expect(colorLevelFor(pipe, {})).toBe(0);
    expect(colorLevelFor(tty, {})).toBeGreaterThan(0);
  });

  it('answers per stream, so one redirected stream does not decide for the other', () => {
    // `drzl generate > out.txt` from a terminal. The old behaviour took stdout's answer for both.
    const env = { TERM: 'xterm-256color' };
    expect(colorLevelFor(pipe, env)).toBe(0);
    expect(colorLevelFor(tty, env)).toBeGreaterThan(0);
  });

  it('reads the terminal it was given rather than guessing a level', () => {
    expect(colorLevelFor(tty, { COLORTERM: 'truecolor' })).toBe(3);
    expect(colorLevelFor(tty, { TERM: 'xterm-256color' })).toBe(2);
    expect(colorLevelFor(tty, { TERM: 'xterm' })).toBe(1);
  });

  it('honours NO_COLOR, which chalk 6 does not', () => {
    expect(colorLevelFor(tty, { NO_COLOR: '1', COLORTERM: 'truecolor' })).toBe(0);
    expect(colorLevelFor(tty, { NO_COLOR: 'anything' })).toBe(0);
  });

  it('treats an empty NO_COLOR as unset, per no-color.org', () => {
    expect(colorLevelFor(tty, { NO_COLOR: '' })).toBeGreaterThan(0);
  });

  it('lets NO_COLOR win over FORCE_COLOR', () => {
    // The precedence chalk does not use, and the reason is in the module comment: FORCE_COLOR is
    // usually a wrapper's doing and NO_COLOR is usually a person's.
    expect(colorLevelFor(pipe, { FORCE_COLOR: '3', NO_COLOR: '1' })).toBe(0);
    expect(colorLevelFor(tty, { FORCE_COLOR: '3', NO_COLOR: '1' })).toBe(0);
  });

  it('reads FORCE_COLOR the way every other tool does', () => {
    expect(colorLevelFor(pipe, { FORCE_COLOR: '1' })).toBe(1);
    expect(colorLevelFor(pipe, { FORCE_COLOR: '2' })).toBe(2);
    expect(colorLevelFor(pipe, { FORCE_COLOR: '3' })).toBe(3);
    expect(colorLevelFor(pipe, { FORCE_COLOR: '' })).toBe(1);
    expect(colorLevelFor(pipe, { FORCE_COLOR: 'true' })).toBe(1);
    expect(colorLevelFor(pipe, { FORCE_COLOR: '0' })).toBe(0);
    expect(colorLevelFor(pipe, { FORCE_COLOR: 'false' })).toBe(0);
    expect(colorLevelFor(tty, { FORCE_COLOR: '9', COLORTERM: 'truecolor' })).toBe(3);
  });

  it('refuses a terminal that says it cannot do colour', () => {
    expect(colorLevelFor(tty, { TERM: 'dumb' })).toBe(0);
  });
});

describe('shouldShowProgress', () => {
  const base = { stderr: tty, quiet: false, json: false };

  it('is off below the measured threshold and on at it', () => {
    expect(shouldShowProgress({ ...base, tables: 1 })).toBe(false);
    expect(shouldShowProgress({ ...base, tables: PROGRESS_MIN_TABLES - 1 })).toBe(false);
    expect(shouldShowProgress({ ...base, tables: PROGRESS_MIN_TABLES })).toBe(true);
  });

  it('is off whenever nobody is watching the stream', () => {
    expect(shouldShowProgress({ ...base, stderr: pipe, tables: 500 })).toBe(false);
  });

  it('is off under --quiet and under --json', () => {
    expect(shouldShowProgress({ ...base, tables: 500, quiet: true })).toBe(false);
    expect(shouldShowProgress({ ...base, tables: 500, json: true })).toBe(false);
  });
});

/** A stream that keeps what was written to it, so a write can be asserted byte for byte. */
function sink(isTTY: boolean) {
  const chunks: string[] = [];
  return {
    isTTY,
    write: (s: string) => {
      chunks.push(s);
      return true;
    },
    get text() {
      return chunks.join('');
    },
  };
}

describe('Output', () => {
  it('puts data on stdout and narration on stderr', () => {
    const stdout = sink(false);
    const stderr = sink(false);
    const out = new Output({ stdout, stderr, env: {} });
    out.data('answer');
    out.note('narration');
    out.warn('careful');
    out.error('broke');
    expect(stdout.text).toBe('answer\n');
    expect(stderr.text).toBe('narration\ncareful\nbroke\n');
  });

  it('drops narration under --quiet and keeps the answer and the error', () => {
    const stdout = sink(false);
    const stderr = sink(false);
    const out = new Output({ stdout, stderr, env: {}, quiet: true });
    out.data('answer');
    out.note('narration');
    out.warn('careful');
    out.succeed('done');
    out.error('broke');
    expect(stdout.text).toBe('answer\n');
    expect(stderr.text).toBe('broke\n');
  });

  it('writes nothing but the document to stdout under --json, and nothing at all to stderr', () => {
    const stdout = sink(false);
    const stderr = sink(false);
    const out = new Output({ stdout, stderr, env: {}, json: true });
    out.note('narration');
    out.warn('careful');
    out.error('broke');
    out.succeed('done');
    out.jsonData({ ok: true });
    expect(stdout.text).toBe('{"ok":true}\n');
    expect(stderr.text).toBe('');
  });

  it('colours each stream from its own answer', () => {
    const stdout = sink(false);
    const stderr = sink(true);
    const out = new Output({ stdout, stderr, env: { TERM: 'xterm' } });
    expect(out.outStyle.level).toBe(0);
    expect(out.errStyle.level).toBe(1);
    // The tick is rendered here rather than by ora, which is what stops the symbol carrying a
    // colour decision of its own; see the module comment on `succeed`.
    out.succeed('done');
    expect(stderr.text).toContain('[32m');
    out.data(out.outStyle.cyan('plain'));
    expect(stdout.text).toBe('plain\n');
  });

  it('shows an aside only where one has a reader', () => {
    const env = {};
    expect(new Output({ stderr: sink(true), env }).wantsAsides).toBe(true);
    expect(new Output({ stderr: sink(false), env }).wantsAsides).toBe(false);
    expect(new Output({ stderr: sink(true), env, quiet: true }).wantsAsides).toBe(false);
    expect(new Output({ stderr: sink(true), env, json: true }).wantsAsides).toBe(false);
  });
});

describe('the exit codes', () => {
  it('are three, and distinct', () => {
    expect(new Set([EXIT_OK, EXIT_FAILED, EXIT_FINDINGS]).size).toBe(3);
    expect(EXIT_OK).toBe(0);
    expect(EXIT_FAILED).toBe(1);
    expect(EXIT_FINDINGS).toBe(2);
  });

  it('are repeated in the failure document, so a caller reads one field', () => {
    expect(jsonFailure('generate', 'DRZL_CFG_001', 'no config')).toEqual({
      ok: false,
      command: 'generate',
      code: 'DRZL_CFG_001',
      message: 'no config',
      exitCode: EXIT_FAILED,
    });
  });
});

describe('messageOf', () => {
  it('keeps the whole message, because a config error is a formatted block', () => {
    const zodish = new Error('[\n  {\n    "path": ["generators"],\n    "message": "too small"\n  }\n]');
    expect(messageOf(zodish)).toContain('generators');
    expect(messageOf(zodish).split('\n').length).toBeGreaterThan(1);
  });

  it('survives a thrown non-error', () => {
    expect(messageOf('plain string')).toBe('plain string');
    expect(messageOf(undefined)).toBe('undefined');
  });
});
