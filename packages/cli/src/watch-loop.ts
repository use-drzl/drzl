/**
 * When `drzl watch` rebuilds, and how many rebuilds one burst of saves is allowed to become
 * (plan item 75).
 *
 * ## What was measured
 *
 * The watcher already had a debounce, so the item reads as done until you watch it run. The
 * debounce covers the *wait* and not the *work*: `setTimeout(run, 200)` collapses changes arriving
 * within 200ms of each other and then starts a rebuild that takes as long as it takes. Every
 * change arriving during that rebuild starts another one 200ms later, on top of the first, writing
 * the same files.
 *
 * Measured against the shipped 4.22 build, with a 600-table schema where one rebuild takes about
 * 1.4s, saving two files alternately 700ms apart:
 *
 *   32370ms START  in flight 1
 *   33195ms START  in flight 2
 *   33814ms START  in flight 3
 *   34379ms END    in flight 2
 *   34475ms START  in flight 3
 *   35174ms START  in flight 4      <- four rebuilds writing one output directory
 *
 * Six saves, six rebuilds, four of them running at once. Each one reloads the config, re-resolves
 * the schema, re-runs the analysis and rewrites every generated file, so the last writer wins per
 * file with no ordering between them.
 *
 * Chokidar's own `awaitWriteFinish` is why this is not worse: with a 400ms stability threshold, one
 * save of one file arrives as exactly one event, so the ordinary case never reached the overlap.
 * The bursts that do reach it are the ones that span a rebuild, which is any refactor across a
 * schema split into several modules.
 *
 * ## What this does about it
 *
 * One rebuild in flight at a time, and a change arriving during one is remembered rather than
 * dropped, so it gets exactly one rebuild afterwards however many changes arrived. The alternative,
 * refusing a change while busy, loses edits, which is worse than the overlap it fixes.
 */

/** What `--debounce` means when it is not given, or is given something that is not a number. */
export const DEFAULT_WATCH_DEBOUNCE_MS = 200;

/**
 * How long `watch` waits after the last change before rebuilding.
 *
 * 200ms is kept, and it is kept because it was measured rather than because it was already there.
 * With the `awaitWriteFinish: { stabilityThreshold: 400 }` this watcher passes chokidar, one
 * logical save reaches the trigger as a single event in every shape tested, and the widest gap
 * inside one burst was 9ms, from a tool rewriting two files back to back. With `awaitWriteFinish`
 * off, which is what a future version of this file might reach for to cut the 400ms it adds to
 * every rebuild, the same bursts spread out: a chunked write became five events with a 62ms
 * maximum gap, an atomic save became three events spanning 101ms, and format-on-save became two
 * events 121ms apart. 200ms covers the widest of those with headroom and is short enough that a
 * save still feels immediate. Every one of those numbers was taken with chokidar 5 on this
 * filesystem, under both inotify and polling.
 *
 * `0` is accepted and means "rebuild on the next tick", which is what the tests want and what
 * somebody debugging the watcher wants. It was previously impossible: `Number(opts.debounce) ||
 * 200` reads `0` as absent and silently used 200, and read `--debounce banana` as absent too. A
 * value that cannot be honoured now says so rather than being quietly replaced.
 */
export function resolveDebounce(value: unknown, warn: (message: string) => void): number {
  if (value === undefined || value === null || value === '') return DEFAULT_WATCH_DEBOUNCE_MS;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) {
    warn(
      `--debounce ${String(value)} is not a number of milliseconds. ` +
        `Using ${DEFAULT_WATCH_DEBOUNCE_MS}ms.`
    );
    return DEFAULT_WATCH_DEBOUNCE_MS;
  }
  return ms;
}

export interface RebuildScheduler {
  /** A file changed. Rebuild after the debounce, or after the rebuild already running. */
  trigger(): void;
  /** Rebuild now, skipping the debounce, still one at a time. The startup build uses this. */
  runNow(): Promise<void>;
  /** Drop a pending debounce. Nothing calls this in the CLI; tests and a shutdown path do. */
  cancel(): void;
  /** Whether a rebuild is in flight. Exposed for tests rather than for the CLI. */
  readonly busy: boolean;
}

export interface RebuildSchedulerOptions {
  run: () => Promise<void>;
  debounceMs: number;
  /**
   * Injected so a test does not have to spend real milliseconds.
   *
   * Defaults to the global timers. A fake clock is the difference between a debounce test that
   * takes 5ms and one that takes a second and is flaky on a loaded CI machine.
   */
  timers?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
}

export function createRebuildScheduler(options: RebuildSchedulerOptions): RebuildScheduler {
  const timers = options.timers ?? {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout),
  };

  let handle: unknown = null;
  let running = false;
  let pending = false;

  const drain = async () => {
    if (running) {
      // Remembered, not merged: the rebuild in flight has already read the old file, so a change
      // that arrives now needs its own pass. One pass, however many changes arrive, because they
      // will all be on disk by the time it reads them.
      pending = true;
      return;
    }
    running = true;
    try {
      await options.run();
      while (pending) {
        pending = false;
        await options.run();
      }
    } finally {
      running = false;
      pending = false;
    }
  };

  return {
    trigger() {
      if (handle !== null) timers.clearTimeout(handle);
      handle = timers.setTimeout(() => {
        handle = null;
        void drain();
      }, options.debounceMs);
    },
    runNow() {
      return drain();
    },
    cancel() {
      if (handle !== null) timers.clearTimeout(handle);
      handle = null;
    },
    get busy() {
      return running;
    },
  };
}
