/**
 * `formatCode` when prettier is installed, executed rather than string-matched.
 *
 * Prettier is no longer bundled into this package; it is an optional peer resolved at call time.
 * The failure that buys is silent: unformatted output is still valid TypeScript, so formatting
 * could stop happening for every user of every generator while the entire suite stayed green.
 * Nothing else here would notice, because nothing else asserts on whitespace.
 *
 * So these feed deliberately mangled input through and demand prettier's exact output back.
 * Its pair, format-without-prettier.spec.ts, covers the other half: the peer being absent has
 * to degrade to unformatted code rather than throw, and has to say so when it was asked for
 * by name.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { formatCode } from '../src';

// Outside the workspace on purpose. `resolveConfig` walks up from this path, so a path inside
// the repo would pick up .prettierrc.json and the expected output would then depend on it.
const filePath = path.join(os.tmpdir(), 'drzl-format-probe', 'schema.ts');

const mangled = "export  const  a={x:1,y:'two'}\nexport  function  f(  n:number  ){return n+1}\n";

const PRETTIFIED =
  'export const a = { x: 1, y: "two" };\nexport function f(n: number) {\n  return n + 1;\n}\n';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatCode with prettier resolvable', () => {
  it('returns prettier output rather than the input', async () => {
    // Prettier's defaults, since nothing above a temp directory configures it: double quotes,
    // semicolons, two-space indent. Spelled out in full so that formatting being skipped, or
    // quietly replaced by something else, cannot pass.
    expect(await formatCode(mangled, filePath)).toBe(PRETTIFIED);
  });

  it('formats and stays quiet when prettier is the engine the config names', async () => {
    // The request was met, so there is nothing to report. A warning here would fire on every
    // correctly configured project in the world.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await formatCode(mangled, filePath, { engine: 'prettier' })).toBe(PRETTIFIED);
    expect(warn.mock.calls).toEqual([]);
  });

  it('honours a nearby prettier config instead of imposing its own defaults', async () => {
    // The repo's own .prettierrc.json sets singleQuote, and this path resolves against it.
    // A formatter that ignored the user's config would be as wrong as one that did not run.
    const inRepo = path.join(import.meta.dirname, 'format-config-probe.ts');
    expect(await formatCode(mangled, inRepo)).toContain("y: 'two'");
  });

  it('leaves the code untouched when formatting is switched off', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await formatCode(mangled, filePath, { enabled: false })).toBe(mangled);
    // `enabled: false` is not an unmet request. Nothing was supposed to happen and nothing did.
    expect(warn.mock.calls).toEqual([]);
  });

  it('warns, once, when the chosen engine is biome and biome cannot be loaded', async () => {
    // The biome branch is reached through a `Function`-built import precisely so no bundler can
    // see it. Selecting it with biome unreachable must degrade rather than throw, and must not
    // fall back to the prettier that is installed right here: the config named an engine.
    //
    // Why the expected reason is taken from a run rather than written down: under vitest that
    // import fails as ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING, and under plain node as
    // ERR_MODULE_NOT_FOUND. Hardcoding either would assert the harness instead of the message,
    // and would go stale the moment the harness changed. no-bundled-formatter.spec.ts runs the
    // node one for real.
    let cause = '';
    try {
      await Function('s', 'return import(s)')('@biomejs/biome');
    } catch (e: any) {
      cause = String(e?.message ?? e);
    }
    expect(cause, 'biome resolved here, so this test proved nothing').not.toBe('');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await formatCode(mangled, filePath, { engine: 'biome' })).toBe(mangled);
    expect(await formatCode(mangled, filePath, { engine: 'biome' })).toBe(mangled);
    expect(warn).toHaveBeenCalledTimes(1);

    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('[drzl]');
    expect(message).toContain('format.engine');
    expect(message).toContain('@biomejs/biome');
    // The reason, carried rather than paraphrased, as on the prettier side.
    expect(message).toContain(cause);
  });
});
