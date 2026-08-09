/**
 * A Biome manifest that is not part of the project's install must not be spawned.
 *
 * Measured under Bun 1.3.14, which is the whole reason this guard exists. `biomeBinary` locates
 * Biome with `createRequire(...).resolve('@biomejs/biome/package.json')`. Node and Deno answer a
 * missing package with MODULE_NOT_FOUND, `formatCode` catches it, and the generated code comes
 * back unformatted. Bun answers it by *auto-installing the package from npm* and resolving to its
 * global cache:
 *
 *   node   -> MODULE_NOT_FOUND
 *   deno   -> MODULE_NOT_FOUND
 *   bun    -> /home/<user>/.bun/install/cache/@biomejs/biome@2.5.7@@@1/package.json
 *
 * The consequences were both observed on a packed install of @drzl/cli 4.22.0 driving a real
 * Drizzle schema, with `@biomejs/biome` in nobody's package.json:
 *
 *   1. `drzl generate` emitted Biome-formatted files under Bun and unformatted files under Node,
 *      from the same config and the same schema. `drzl generate --check` under Node then reported
 *      every file out of date, which is a CI failure produced entirely by the choice of runtime.
 *   2. Codegen silently downloaded a package, and a multi-megabyte native binary behind it, from
 *      the network.
 *
 * Worse than either, it was not even stable within Bun: whether the auto-install fired depended on
 * the state of a cache outside the project, so the same command on the same tree emitted different
 * bytes on different days.
 *
 * The discriminator is exact and is the one asserted below. Every real install of a package,
 * npm, pnpm's `.pnpm` store and Yarn's PnP paths alike, reaches it through a `node_modules`
 * directory. Bun's auto-install cache is the only shape that does not, because it is not a project
 * install at all. Under Node the guard is unreachable by construction, since Node's resolver has
 * no other kind of path to return, which is exactly why it costs nothing there.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatCode, isProjectInstallPath } from '../src';

describe('isProjectInstallPath', () => {
  it('refuses the path Bun auto-install really returned', () => {
    // Copied from the run, not invented: this is what `require.resolve` handed back under Bun
    // 1.3.14 in a directory with no node_modules anywhere above it.
    expect(
      isProjectInstallPath('/home/user/.bun/install/cache/@biomejs/biome@2.5.7@@@1/package.json')
    ).toBe(false);
  });

  it('accepts an ordinary npm install', () => {
    expect(isProjectInstallPath('/srv/app/node_modules/@biomejs/biome/package.json')).toBe(true);
  });

  it("accepts pnpm's store layout, which nests node_modules twice", () => {
    expect(
      isProjectInstallPath(
        '/srv/app/node_modules/.pnpm/@biomejs+biome@2.5.7/node_modules/@biomejs/biome/package.json'
      )
    ).toBe(true);
  });

  it("accepts Yarn PnP's zip and unplugged paths", () => {
    expect(
      isProjectInstallPath(
        '/srv/app/.yarn/cache/@biomejs-biome-npm-2.5.7-abc.zip/node_modules/@biomejs/biome/package.json'
      )
    ).toBe(true);
    expect(
      isProjectInstallPath(
        '/srv/app/.yarn/unplugged/@biomejs-biome-npm-2.5.7-abc/node_modules/@biomejs/biome/package.json'
      )
    ).toBe(true);
  });

  it('refuses a directory merely named like the marker', () => {
    // `node_modules` has to be a whole path segment. A directory called `my_node_modules`, or a
    // package whose own name contains the word, is not an install root.
    expect(isProjectInstallPath('/srv/my_node_modules/@biomejs/biome/package.json')).toBe(false);
    expect(isProjectInstallPath('/srv/node_modules_old/@biomejs/biome/package.json')).toBe(false);
  });

  it('reads the separator as a path separator on this platform', () => {
    const p = ['', 'srv', 'app', 'node_modules', '@biomejs', 'biome', 'package.json'].join(path.sep);
    expect(isProjectInstallPath(p)).toBe(true);
  });
});

/**
 * The working directory is the fallback anchor, and it has to keep working.
 *
 * `biomeManifest` used to be one `createRequire` with `resolve(spec, { paths: [startDir, cwd] })`.
 * It is now a loop that anchors a fresh `createRequire` at each candidate, because Bun ignores the
 * `paths` list and auto-installs instead of walking on to the second entry. That rewrite is only
 * safe if the fallback it replaces still resolves, so this drives the case `paths` existed for: an
 * absolute `outDir` whose directory has no node_modules above it, with the install in the working
 * directory instead.
 */
describe('the working directory as fallback anchor', () => {
  const cwd = process.cwd();
  afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
  });

  it('finds a Biome installed in the working directory when the output dir is elsewhere', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-biome-cwd-'));
    const pkgDir = path.join(projectDir, 'node_modules', '@biomejs', 'biome');
    await fs.mkdir(path.join(pkgDir, 'bin'), { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@biomejs/biome', version: '2.5.7', bin: { biome: 'bin/biome' } })
    );
    // Echoes a fixed marker so the assertion is that this binary ran, not that Biome formats.
    await fs.writeFile(
      path.join(pkgDir, 'bin', 'biome'),
      [
        '#!/usr/bin/env node',
        'let input = "";',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", (c) => (input += c));',
        'process.stdin.on("end", () => { process.stdout.write("/* formatted by cwd anchor */\\n"); });',
      ].join('\n'),
      { mode: 0o755 }
    );

    // Somewhere with no node_modules of its own anywhere above it, which is what an absolute
    // outDir pointing outside the project looks like.
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-biome-outside-'));
    const filePath = path.join(outsideDir, 'users.ts');

    process.chdir(projectDir);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await formatCode('export const a=1\n', filePath, { engine: 'biome' });
    expect(out).toBe('/* formatted by cwd anchor */\n');
    expect(warn.mock.calls).toEqual([]);
  });
});
