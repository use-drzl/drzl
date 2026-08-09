/**
 * When `drzl watch` rebuilds, and how many rebuilds a burst becomes (plan item 75).
 *
 * The measurement that motivated this is in `watch-loop.ts`: against the shipped 4.22 build, six
 * saves 700ms apart produced six rebuilds with four running at once, all writing the same output
 * directory, because the debounce guarded the wait and nothing guarded the work. These are the
 * tests that would have caught it, and the concurrency ones fail against a scheduler with the
 * debounce alone.
 *
 * The clock is injected rather than real. A debounce test that sleeps is a test that is flaky on a
 * loaded CI machine, and the thing under test is the ordering, not the milliseconds.
 */
import { describe, it, expect } from 'vitest';
import {
  createRebuildScheduler,
  resolveDebounce,
  DEFAULT_WATCH_DEBOUNCE_MS,
} from '../src/watch-loop';

/** A clock a test drives by hand. Only the last-scheduled callback can be pending, as in the CLI. */
function fakeTimers() {
  let next = 1;
  const queued = new Map<number, { fn: () => void; at: number }>();
  let now = 0;
  return {
    now: () => now,
    timers: {
      setTimeout(fn: () => void, ms: number) {
        const id = next++;
        queued.set(id, { fn, at: now + ms });
        return id;
      },
      clearTimeout(handle: unknown) {
        queued.delete(handle as number);
      },
    },
    /** Move time on, firing everything due. */
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...queued]) {
        if (t.at <= now) {
          queued.delete(id);
          t.fn();
        }
      }
    },
    get pending() {
      return queued.size;
    },
  };
}

/** A run that finishes only when the test says so, so overlap is observable. */
function controllableRun() {
  let starts = 0;
  let finishes = 0;
  let maxConcurrent = 0;
  let concurrent = 0;
  const waiting: Array<() => void> = [];
  return {
    get starts() {
      return starts;
    },
    get finishes() {
      return finishes;
    },
    get maxConcurrent() {
      return maxConcurrent;
    },
    run: () =>
      new Promise<void>((resolve) => {
        starts++;
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        waiting.push(() => {
          concurrent--;
          finishes++;
          resolve();
        });
      }),
    /** Let the oldest in-flight run finish. */
    finishOne() {
      waiting.shift()?.();
      // Two microtask turns: one for the `await run()` to resume, one for the trailing re-run it
      // may start.
      return Promise.resolve().then(() => Promise.resolve());
    },
  };
}

describe('the debounce', () => {
  it('turns a burst of changes into one rebuild', async () => {
    const clock = fakeTimers();
    const runner = controllableRun();
    const s = createRebuildScheduler({ run: runner.run, debounceMs: 200, timers: clock.timers });

    // Five saves inside the window, which is what chokidar reports for a tool rewriting several
    // files at once: the widest gap measured inside one burst was 9ms.
    for (let i = 0; i < 5; i++) {
      s.trigger();
      clock.advance(9);
    }
    expect(runner.starts).toBe(0);
    clock.advance(200);
    expect(runner.starts).toBe(1);
  });

  it('rebuilds again for a change that arrives after the window', async () => {
    const clock = fakeTimers();
    const runner = controllableRun();
    const s = createRebuildScheduler({ run: runner.run, debounceMs: 200, timers: clock.timers });

    s.trigger();
    clock.advance(200);
    await runner.finishOne();
    s.trigger();
    clock.advance(200);
    expect(runner.starts).toBe(2);
  });
});

describe('one rebuild at a time', () => {
  it('never runs two rebuilds at once, however many changes arrive during one', async () => {
    const clock = fakeTimers();
    const runner = controllableRun();
    const s = createRebuildScheduler({ run: runner.run, debounceMs: 200, timers: clock.timers });

    s.trigger();
    clock.advance(200);
    expect(runner.starts).toBe(1);

    // Four more saves while that rebuild is still going, each far enough apart that the debounce
    // cannot merge them. This is the case the shipped watcher started four rebuilds for.
    for (let i = 0; i < 4; i++) {
      s.trigger();
      clock.advance(700);
    }
    expect(runner.starts).toBe(1);
    expect(runner.maxConcurrent).toBe(1);
  });

  it('owes exactly one more rebuild, not one per change, when the first finishes', async () => {
    const clock = fakeTimers();
    const runner = controllableRun();
    const s = createRebuildScheduler({ run: runner.run, debounceMs: 200, timers: clock.timers });

    s.trigger();
    clock.advance(200);
    for (let i = 0; i < 4; i++) {
      s.trigger();
      clock.advance(700);
    }

    await runner.finishOne();
    expect(runner.starts).toBe(2);
    expect(runner.maxConcurrent).toBe(1);

    await runner.finishOne();
    expect(runner.starts).toBe(2);
    expect(s.busy).toBe(false);
  });

  it('does not drop a change that arrives during a rebuild', async () => {
    // The failure mode the other way: refusing a change while busy loses an edit, which is worse
    // than the overlap it fixes.
    const clock = fakeTimers();
    const runner = controllableRun();
    const s = createRebuildScheduler({ run: runner.run, debounceMs: 200, timers: clock.timers });

    s.trigger();
    clock.advance(200);
    s.trigger();
    clock.advance(200);
    await runner.finishOne();
    expect(runner.starts).toBe(2);
  });

  it('puts the startup build under the same guard', async () => {
    const clock = fakeTimers();
    const runner = controllableRun();
    const s = createRebuildScheduler({ run: runner.run, debounceMs: 200, timers: clock.timers });

    const startup = s.runNow();
    s.trigger();
    clock.advance(200);
    expect(runner.starts).toBe(1);
    await runner.finishOne();
    await runner.finishOne();
    await startup;
    expect(runner.maxConcurrent).toBe(1);
  });

  it('forgets a pending debounce when cancelled', () => {
    const clock = fakeTimers();
    const runner = controllableRun();
    const s = createRebuildScheduler({ run: runner.run, debounceMs: 200, timers: clock.timers });
    s.trigger();
    s.cancel();
    clock.advance(1000);
    expect(runner.starts).toBe(0);
  });
});

describe('resolveDebounce', () => {
  const swallow = () => {};

  it('defaults to the measured interval', () => {
    expect(resolveDebounce(undefined, swallow)).toBe(DEFAULT_WATCH_DEBOUNCE_MS);
    expect(DEFAULT_WATCH_DEBOUNCE_MS).toBe(200);
  });

  it('takes a number, as a string, which is what commander hands over', () => {
    expect(resolveDebounce('50', swallow)).toBe(50);
  });

  it('accepts zero, which `Number(x) || 200` silently turned into 200', () => {
    expect(resolveDebounce('0', swallow)).toBe(0);
  });

  it('warns rather than silently substituting when the value is not a number', () => {
    const warnings: string[] = [];
    expect(resolveDebounce('banana', (w) => warnings.push(w))).toBe(DEFAULT_WATCH_DEBOUNCE_MS);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('banana');
    expect(warnings[0]).toContain('200ms');
  });

  it('refuses a negative interval', () => {
    const warnings: string[] = [];
    expect(resolveDebounce('-5', (w) => warnings.push(w))).toBe(DEFAULT_WATCH_DEBOUNCE_MS);
    expect(warnings).toHaveLength(1);
  });
});
