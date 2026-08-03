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
 * to degrade to unformatted code rather than throw.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { formatCode } from '../src';

// Outside the workspace on purpose. `resolveConfig` walks up from this path, so a path inside
// the repo would pick up .prettierrc.json and the expected output would then depend on it.
const filePath = path.join(os.tmpdir(), 'drzl-format-probe', 'schema.ts');

const mangled = "export  const  a={x:1,y:'two'}\nexport  function  f(  n:number  ){return n+1}\n";

describe('formatCode with prettier resolvable', () => {
  it('returns prettier output rather than the input', async () => {
    // Prettier's defaults, since nothing above a temp directory configures it: double quotes,
    // semicolons, two-space indent. Spelled out in full so that formatting being skipped, or
    // quietly replaced by something else, cannot pass.
    expect(await formatCode(mangled, filePath)).toBe(
      'export const a = { x: 1, y: "two" };\nexport function f(n: number) {\n  return n + 1;\n}\n'
    );
  });

  it('honours a nearby prettier config instead of imposing its own defaults', async () => {
    // The repo's own .prettierrc.json sets singleQuote, and this path resolves against it.
    // A formatter that ignored the user's config would be as wrong as one that did not run.
    const inRepo = path.join(import.meta.dirname, 'format-config-probe.ts');
    expect(await formatCode(mangled, inRepo)).toContain("y: 'two'");
  });

  it('leaves the code untouched when formatting is switched off', async () => {
    expect(await formatCode(mangled, filePath, { enabled: false })).toBe(mangled);
  });

  it('falls through to the input when the chosen engine is biome and biome is absent', async () => {
    // The biome branch is reached through a `Function`-built import precisely so no bundler can
    // see it. Selecting it with biome uninstalled must degrade, not throw.
    expect(await formatCode(mangled, filePath, { engine: 'biome' })).toBe(mangled);
  });
});
