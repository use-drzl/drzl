/**
 * `engine: 'auto'` reaching Biome, which is the half of "tries Prettier, then Biome" that has never
 * happened.
 *
 * Both README and docs describe `auto` as trying Prettier and then Biome. The second step ran, and
 * could not succeed: it reached for `import('@biomejs/biome')`, and that package publishes `bin`
 * and no module entry point at any version, so the import always rejected. A consumer with Biome
 * installed and no Prettier therefore got unformatted files while `auto` was silently doing what it
 * said it would.
 *
 * Prettier is removed here rather than uninstalled, so this is its own file. Its pair,
 * format-biome.spec.ts, holds prettier in place and shows that it still wins; between them the
 * ordering is pinned in both directions.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { formatCode } from '../src';

vi.mock('prettier', () => {
  throw new Error("Cannot find package 'prettier' imported from drzl");
});

const mangled = "export  const  a={x:1,y:'two'}\nexport  function  f(  n:number  ){return n+1}\n";

/** Biome 2.5.7's real output for the input above, tabs and double quotes. See format-biome.spec.ts. */
const BIOME_OUTPUT =
  'export const a = { x: 1, y: "two" };\nexport function f(n: number) {\n\treturn n + 1;\n}\n';

async function projectWithBiome() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-biome-auto-'));
  const pkgDir = path.join(dir, 'node_modules', '@biomejs', 'biome');
  await fs.mkdir(path.join(pkgDir, 'bin'), { recursive: true });
  await fs.writeFile(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@biomejs/biome', version: '2.5.7', bin: { biome: 'bin/biome' } })
  );
  await fs.writeFile(
    path.join(pkgDir, 'bin', 'biome'),
    [
      '#!/usr/bin/env node',
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (c) => (input += c));',
      'process.stdin.on("end", () => {',
      '  process.stdout.write(' + JSON.stringify(BIOME_OUTPUT) + ');',
      '  process.exit(0);',
      '});',
    ].join('\n'),
    { mode: 0o755 }
  );
  const outDir = path.join(dir, 'src', 'generated');
  await fs.mkdir(outDir, { recursive: true });
  return path.join(outDir, 'users.ts');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatCode with engine: auto and no prettier', () => {
  it('really cannot resolve prettier here', async () => {
    // Without this the test below passes for the wrong reason the day the mock stops applying.
    await expect(import('prettier')).rejects.toThrow();
  });

  it('falls through to biome and returns biome output', async () => {
    const filePath = await projectWithBiome();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await formatCode(mangled, filePath, { engine: 'auto' })).toBe(BIOME_OUTPUT);
    // `auto` asked for whatever was there and got an answer, so there is nothing to report.
    expect(warn.mock.calls).toEqual([]);
  });

  it('stays silent when neither formatter is available', async () => {
    // Unchanged behaviour, asserted here because the biome branch is no longer a guaranteed
    // failure and could start warning under `auto` by accident.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-biome-auto-none-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await formatCode(mangled, path.join(dir, 'users.ts'), { engine: 'auto' })).toBe(mangled);
    expect(warn.mock.calls).toEqual([]);
  });
});
