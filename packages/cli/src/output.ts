/**
 * Everything the CLI writes: which stream, in what shape, and whether it carries colour.
 *
 * Five plan items are one layer, and this file is that layer (items 72, 73, 74, 76, 77). Before it
 * existed, each of the seven commands answered those questions for itself by reaching for `chalk`,
 * `ora`, `cli-progress` and `console.log` at the call site, and the answers disagreed. Four of the
 * disagreements were measured against the built 4.22.0 CLI, each command run with stdout and stderr
 * on separate channels so the two could be told apart:
 *
 * - **`NO_COLOR` did nothing at all (item 76).** `chalk@6.0.0` vendors its own `supports-color`,
 *   and that copy contains the string `FORCE_COLOR` ten times and the string `NO_COLOR` zero
 *   times. Measured: on a pty with `NO_COLOR=1`, `chalk.level` is still 3 and `chalk.green('x')`
 *   still returns `[32mx[39m`. `drzl doctor` emitted the same 32 escape sequences with
 *   the variable set as without it.
 *
 * - **Colour was decided from the wrong stream (items 76, 77).** chalk's default instance takes
 *   its level from `supportsColor.stdout` alone (`const colorLevel = stdoutColor ? ... : 0`), and
 *   the CLI writes most of its narration to stderr. So `drzl generate > out.txt` with a terminal
 *   still on stderr turned the warnings on that terminal colourless, because a *different* stream
 *   had been redirected. chalk exposes `supportsColor.stderr` as well; nothing used it.
 *
 * - **An escape leaked into piped output regardless (item 77).** Not from chalk, which does check
 *   `isTTY`, but from `ora`'s success symbol: `log-symbols` colours it with `yoctocolors`, which
 *   reads `TERM`, `COLORTERM`, `FORCE_COLOR` and `NO_COLOR` and never asks whether the stream is a
 *   terminal. Measured on an ordinary developer machine where `TERM` is set: `drzl analyze 2> log`
 *   wrote `[32m✔[39m Analyzed in 46ms` into the file. So the symbol is rendered
 *   here now and `ora` is asked only to spin.
 *
 * - **Narration sat on stdout (item 73).** The sponsor tip was written with `console.log`, so
 *   `drzl generate | ...` fed 246 bytes of advertisement into whatever was parsing the file list.
 *   `--json` cannot be a contract while anything but the document shares that stream.
 *
 * The rule the rest of the CLI follows from here: **stdout carries the answer, stderr carries the
 * narration.** Under `--json` stdout carries exactly one JSON document and nothing else, on
 * success and on failure alike, so `drzl <cmd> --json | jq .` parses with no filtering.
 */
import { Chalk, type ChalkInstance } from 'chalk';
import cliProgress from 'cli-progress';
import ora, { type Ora } from 'ora';

/** The subset of a stream this module needs, so tests can pass an ordinary object. */
export interface OutputStream {
  write(chunk: string): unknown;
  isTTY?: boolean;
  columns?: number;
}

export type Env = Record<string, string | undefined>;

export type ColorLevel = 0 | 1 | 2 | 3;

/**
 * The three exit codes, and there are only three on purpose.
 *
 * Before this, `2` meant "the analysis found errors" from `analyze`, "findings were reported and
 * you asked for strictness" from `doctor`, and "there is no config file" from `generate` and
 * `watch`; `1` meant "the schema could not be read" from `doctor` but "a generator threw" from
 * `generate`. Three commands used the same number for three unrelated events, which is the same as
 * having no scheme.
 *
 * The distinction worth encoding is the one a pipeline acts on differently: work that could not be
 * done at all, against work that was done and turned something up. A build reacts to the first by
 * stopping, and to the second by showing a diff or a report. Everything else is prose and belongs
 * in the message.
 */
export const EXIT_OK = 0;
/** DRZL could not do the work: bad config, unreadable schema, a generator threw, a write failed. */
export const EXIT_FAILED = 1;
/**
 * DRZL did the work and found what it was asked to look for: `generate --check` drift,
 * `doctor --strict` findings, `analyze` error-level issues.
 */
export const EXIT_FINDINGS = 2;

/**
 * How many tables make a progress bar worth drawing.
 *
 * Measured rather than chosen. The generator loop the bar covers costs about 105ms fixed plus
 * 3.6ms per table on this machine (1 table 109ms, 10 tables 181ms, 50 tables 354ms, 100 tables
 * 561ms, 200 tables 901ms, 400 tables 1549ms), and `cli-progress` redraws at 10fps. A bar drawn
 * over a shorter loop therefore paints one frame reading `0%` and is then wiped by `stop()`
 * without ever advancing, which is exactly what item 72 reports: a full-width bar appearing for a
 * single table and saying nothing.
 *
 * 25 tables is where the loop first outlasts a frame, so the bar is only ever drawn when it will
 * move at least once. Below it the run is already described by the two lines around it: the
 * analysis time, and the file count per generator.
 */
export const PROGRESS_MIN_TABLES = 25;

/**
 * Whether a stream should carry colour, and how much.
 *
 * Asked once per stream rather than once per process. That is the whole of item 77 and half of
 * item 76: `drzl generate > file` leaves stderr a terminal and stdout a file, and the two answers
 * differ.
 *
 * `NO_COLOR` beats `FORCE_COLOR`, which is the one place this departs from chalk. The reason is
 * which of them a human sets: `NO_COLOR` goes in a shell profile and is a standing preference,
 * while `FORCE_COLOR` is overwhelmingly injected by a wrapper (CI runners set it, and so does the
 * shell this was developed in, which set `FORCE_COLOR=3` and made every command look like a colour
 * leak until it was stripped). A wrapper's guess must not overrule a person's refusal. It also
 * makes every colour rule testable through an ordinary pipe, with no pseudo-terminal, because
 * `FORCE_COLOR=1` turns colour on where a pipe would have it off.
 *
 * `NO_COLOR` follows no-color.org: any value except the empty string counts as set.
 */
export function colorLevelFor(stream: OutputStream, env: Env): ColorLevel {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 0;
  if (env.TERM === 'dumb') return 0;

  const forced = env.FORCE_COLOR;
  if (forced !== undefined) {
    if (forced === 'false' || forced === '0') return 0;
    if (forced === '' || forced === 'true') return 1;
    const n = Number.parseInt(forced, 10);
    if (Number.isInteger(n)) return Math.min(Math.max(n, 0), 3) as ColorLevel;
    return 1;
  }

  if (!stream.isTTY) return 0;
  // A terminal that says it can do more is believed, and one that says nothing gets the sixteen
  // colours every terminal emulator has had for thirty years.
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 3;
  if (env.TERM?.includes('256')) return 2;
  return 1;
}

/** Whether a progress bar earns its place. Split out so the four reasons can be tested apart. */
export function shouldShowProgress(opts: {
  tables: number;
  stderr: OutputStream;
  quiet: boolean;
  json: boolean;
}): boolean {
  if (opts.quiet || opts.json) return false;
  if (!opts.stderr.isTTY) return false;
  return opts.tables >= PROGRESS_MIN_TABLES;
}

/** What `createProgress` hands back, so the call site never touches `cli-progress` directly. */
export interface Progress {
  start(): void;
  update(value: number): void;
  stop(): void;
}

/** A progress bar, or a shaped hole where one would have been. */
function createProgress(enabled: boolean, total: number, stream: OutputStream): Progress {
  if (!enabled) {
    return { start() {}, update() {}, stop() {} };
  }
  const bar = new cliProgress.SingleBar(
    { hideCursor: true, stream: stream as NodeJS.WritableStream },
    cliProgress.Presets.shades_classic
  );
  // `running` is what makes `start` and `stop` safe to call in any order. The dispatch loop calls
  // `stop()` from thirteen branches and from their catch blocks, and before this the bar was
  // started once outside the loop, so the second generator in a config updated a bar that the
  // first had already stopped.
  let running = false;
  return {
    start() {
      if (running) return;
      bar.start(total, 0);
      running = true;
    },
    update(value: number) {
      if (running) bar.update(value);
    },
    stop() {
      if (!running) return;
      bar.stop();
      running = false;
    },
  };
}

/** A spinner, or a shaped hole. Never renders the completion symbol itself; see `Output.succeed`. */
export interface Spinner {
  succeed(text: string): void;
  fail(text: string): void;
  stop(): void;
}

export interface OutputOptions {
  stdout?: OutputStream;
  stderr?: OutputStream;
  env?: Env;
  quiet?: boolean;
  json?: boolean;
}

/**
 * Every write the CLI makes, with the stream and the colour already decided.
 *
 * `data` is the only method that reaches stdout. Everything else is narration and goes to stderr,
 * where `--quiet` can drop it without touching either the answer or the exit code.
 */
export class Output {
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  readonly env: Env;
  readonly quiet: boolean;
  readonly json: boolean;
  /** Chalk bound to stdout's answer. */
  readonly outStyle: ChalkInstance;
  /** Chalk bound to stderr's answer, which is a different question. */
  readonly errStyle: ChalkInstance;

  constructor(options: OutputOptions = {}) {
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.env = options.env ?? process.env;
    this.quiet = options.quiet ?? false;
    this.json = options.json ?? false;
    this.outStyle = new Chalk({ level: colorLevelFor(this.stdout, this.env) });
    this.errStyle = new Chalk({ level: colorLevelFor(this.stderr, this.env) });
  }

  /** The command's answer. Never suppressed by `--quiet`, because then nothing would be left. */
  data(text: string): void {
    this.stdout.write(text.endsWith('\n') ? text : text + '\n');
  }

  /**
   * The one JSON document `--json` promises, and the reason nothing else may touch stdout.
   *
   * Stringified without indentation on purpose: this is a machine's copy, `jq` formats it for a
   * human, and the two commands that already print an indented document (`analyze`, `doctor`) keep
   * doing so through `data` because their shape is a published contract.
   */
  jsonData(payload: unknown): void {
    this.data(JSON.stringify(payload));
  }

  /** Narration. Dropped by `--quiet` and by `--json`. */
  note(text: string): void {
    if (this.quiet || this.json) return;
    this.stderr.write(text + '\n');
  }

  /** A warning: narration a user asked to be quiet still does not need. */
  warn(text: string): void {
    if (this.quiet || this.json) return;
    this.stderr.write(this.errStyle.yellow(text) + '\n');
  }

  /**
   * A failure. Never suppressed by anything, because a script that cannot tell a success from a
   * swallowed failure is worse off than one with no `--quiet` at all.
   *
   * Under `--json` the machine-readable failure goes to stdout as the document, so this stays
   * quiet there rather than printing the same fact twice in two shapes.
   */
  error(text: string, detail?: string): void {
    if (this.json) return;
    const line = this.errStyle.red(text) + (detail ? ' ' + detail : '');
    this.stderr.write(line + '\n');
  }

  /** A hint under an error. Suppressed by `--quiet`: the error above it already said what broke. */
  hint(text: string): void {
    if (this.quiet || this.json) return;
    this.stderr.write(this.errStyle.dim(text) + '\n');
  }

  /**
   * A spinner on stderr, or nothing.
   *
   * `ora` is constructed only when stderr is a terminal. Given a pipe it still writes its text
   * once as `- Analyzing...`, which is a line nobody reading a log wants, and given `NO_COLOR` it
   * writes a coloured symbol anyway. Both are avoided by not building it.
   */
  spinner(text: string): Spinner {
    const live: Ora | null =
      !this.quiet && !this.json && this.stderr.isTTY
        ? ora({
            text,
            stream: this.stderr as NodeJS.WritableStream,
            // ora paints its own frame cyan through its own chalk, which is a second colour
            // decision beside this one and does not read `NO_COLOR` either. Measured with the
            // variable set: everything else on the line went plain and the spinner frame arrived
            // as `[36m⠋[39m`. `false` is ora's documented way to turn that off.
            color: this.errStyle.level > 0 ? 'cyan' : false,
          }).start()
        : null;
    return {
      succeed: (done: string) => {
        live?.stop();
        this.succeed(done);
      },
      fail: (done: string) => {
        live?.stop();
        this.error(done);
      },
      stop: () => live?.stop(),
    };
  }

  /**
   * A completed step.
   *
   * The tick is rendered here rather than by `ora.succeed`, which is the fix for the escape that
   * reached piped output: `log-symbols` colours the symbol from the environment alone and never
   * looks at the stream, so `drzl analyze 2> log` used to write `[32m✔[39m` into
   * the file. Here the symbol goes through the same per-stream decision as everything else.
   */
  succeed(text: string): void {
    if (this.quiet || this.json) return;
    this.stderr.write(this.errStyle.green('✔') + ' ' + text + '\n');
  }

  /** A progress bar for `tables` items, or a no-op. See `shouldShowProgress` for the four gates. */
  progress(tables: number): Progress {
    return createProgress(
      shouldShowProgress({
        tables,
        stderr: this.stderr,
        quiet: this.quiet,
        json: this.json,
      }),
      tables,
      this.stderr
    );
  }

  /**
   * Whether an unrequested extra, such as the sponsor tip, should be shown at all.
   *
   * A terminal is the only place an aside has a reader. Piped into a file it is noise in someone's
   * log, and under `--json` it would be noise in the middle of a document.
   */
  get wantsAsides(): boolean {
    return !this.quiet && !this.json && Boolean(this.stderr.isTTY);
  }
}

/** The failure document every command emits under `--json`, whatever went wrong. */
export interface JsonFailure {
  ok: false;
  command: string;
  code: string;
  message: string;
  exitCode: number;
}

/**
 * The failure half of the `--json` contract.
 *
 * A `--json` run writes one document on stdout whether it worked or not, because the case people
 * script against is the one that fails, and a command whose failure exists only as prose on stderr
 * forces every caller to parse English.
 *
 * `ok: false` appears here and nowhere in the shared envelope, which is deliberate: `doctor` has
 * published an `ok` of its own since it shipped, meaning "nothing to report about your schema",
 * and that is a different question from whether the run worked. Redefining it would break a
 * documented field and carrying both spellings would let them disagree, so the run's answer is
 * `exitCode` on every document, and `ok` keeps its own meaning where it already had one. A failure
 * document has no payload to collide with, so it says `ok: false` plainly.
 */
export function jsonFailure(
  command: string,
  code: string,
  message: string,
  exitCode: number = EXIT_FAILED
): JsonFailure {
  return { ok: false, command, code, message, exitCode };
}

/**
 * The message off a thrown value, whatever was thrown.
 *
 * Whole, not the first line. The config validator throws a zod error whose message is a formatted
 * JSON array, and the first line of that is `[`, so truncating it would turn "your config names no
 * generators" into a bracket. The `--json` document carries the same string, where newlines cost
 * nothing.
 */
export function messageOf(value: unknown): string {
  const message = (value as { message?: string })?.message;
  return String(message ?? value);
}
