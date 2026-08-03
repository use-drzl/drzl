/**
 * `formatCode` when prettier cannot be resolved.
 *
 * Prettier is an optional peer, so the common case for a consumer who never asked for it is that
 * the module is simply not there. A missing optional peer surfaces as a rejected dynamic import,
 * and an unhandled one would take down `drzl generate` at the last step, after every file had
 * already been rendered. The existing `try {} catch {}` suggests that cannot happen; asserting it
 * is the difference between suggesting and knowing.
 *
 * Absence is simulated here rather than uninstalled, so the whole file mocks the module away.
 * The real artefact is exercised against a real missing peer, in a child process with no
 * node_modules at all, by no-bundled-formatter.spec.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { formatCode } from '../src';

// What Node throws for a bare specifier it cannot resolve. Thrown from the factory rather than
// returned as a stub module, because a stub would exercise a prettier that exists and misbehaves,
// which is a different failure.
vi.mock('prettier', () => {
  throw new Error("Cannot find package 'prettier' imported from drzl");
});

const filePath = path.join(os.tmpdir(), 'drzl-format-probe', 'schema.ts');
const mangled = "export  const  a={x:1,y:'two'}\n";

describe('formatCode with prettier unresolvable', () => {
  it('really cannot resolve prettier here', async () => {
    // Without this the rest of the file passes for the wrong reason the day the mock stops
    // applying: prettier would format, the code would come back changed, and only the two
    // assertions below would be left to notice.
    await expect(import('prettier')).rejects.toThrow();
  });

  it('returns the code unchanged instead of throwing', async () => {
    expect(await formatCode(mangled, filePath)).toBe(mangled);
  });

  it('returns the code unchanged when prettier is demanded by name', async () => {
    // `engine: 'prettier'` skips the biome fallback entirely, so this is the path with nothing
    // left to catch the rejection.
    expect(await formatCode(mangled, filePath, { engine: 'prettier' })).toBe(mangled);
  });
});
