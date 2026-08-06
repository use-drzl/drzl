/**
 * `formatCode` when prettier cannot be resolved.
 *
 * Prettier is an optional peer, so the common case for a consumer who never asked for it is that
 * the module is simply not there. A missing optional peer surfaces as a rejected dynamic import,
 * and an unhandled one would take down `drzl generate` at the last step, after every file had
 * already been rendered. The `catch` around the import suggests that cannot happen; asserting it
 * is the difference between suggesting and knowing.
 *
 * The two configurations are not the same request and do not get the same answer. `engine: 'auto'`
 * asked for whatever is present, so finding nothing is an outcome and stays silent. Naming
 * prettier is a request, and an unmet request that produces no output and no message is the whole
 * defect: the consumer gets unformatted files and no reason to look.
 *
 * Absence is simulated here rather than uninstalled, so the whole file mocks the module away.
 * The real artefact is exercised against a real missing peer, in a child process with no
 * node_modules at all, by no-bundled-formatter.spec.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { formatCode } from '../src';

// Thrown from the factory rather than returned as a stub module, because a stub would exercise a
// prettier that exists and misbehaves, which is a different failure. The wording is Node's for an
// unresolvable bare specifier, but vitest does not pass it through, which is why the third test
// takes the expected reason from a run instead of from here.
vi.mock('prettier', () => {
  throw new Error("Cannot find package 'prettier' imported from drzl");
});

const filePath = path.join(os.tmpdir(), 'drzl-format-probe', 'schema.ts');
const mangled = "export  const  a={x:1,y:'two'}\n";

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatCode with prettier unresolvable', () => {
  it('really cannot resolve prettier here', async () => {
    // Without this the rest of the file passes for the wrong reason the day the mock stops
    // applying: prettier would format, the code would come back changed, and only the assertions
    // below would be left to notice.
    await expect(import('prettier')).rejects.toThrow();
  });

  it('returns the code unchanged instead of throwing, and says nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await formatCode(mangled, filePath)).toBe(mangled);
    // The default engine is 'auto', which asked for no formatter in particular. Nothing was
    // promised, so there is nothing to report.
    expect(warn.mock.calls).toEqual([]);
  });

  it('warns, once, when prettier is demanded by name and is not there', async () => {
    // `engine: 'prettier'` skips the biome fallback entirely, so this is the path with nothing
    // left to catch the rejection.
    //
    // The expected reason is taken from a run rather than written down, because the mock does not
    // deliver the words above: vitest catches a throwing factory and substitutes an explanation of
    // its own. Asserting either text would assert the harness. What a consumer actually reads is
    // Node's own "Cannot find package 'prettier'", asserted against a real missing peer in
    // no-bundled-formatter.spec.ts.
    let cause = '';
    try {
      await import('prettier');
    } catch (e: any) {
      cause = String(e?.message ?? e);
    }
    expect(cause, 'prettier resolved here, so this test proved nothing').not.toBe('');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await formatCode(mangled, filePath, { engine: 'prettier' })).toBe(mangled);
    // Twice in one call site stands in for a generate run, which reaches formatCode once per
    // emitted file: the condition belongs to the environment, not to the file, so repeating it
    // per table would bury the message it exists to deliver.
    expect(await formatCode(mangled, filePath, { engine: 'prettier' })).toBe(mangled);
    expect(warn).toHaveBeenCalledTimes(1);

    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('[drzl]');
    expect(message).toContain('prettier');
    // Naming the setting, so the message points at the line in the config that produced it.
    expect(message).toContain('format.engine');
    // The reason, carried through rather than paraphrased. "Not installed" and "installed and
    // broken" arrive at this branch identically, and only the underlying error separates them.
    expect(message).toContain(cause);
  });
});
