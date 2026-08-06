/**
 * Telling "this generator is not installed" apart from "this generator threw".
 *
 * Every generator branch in the CLI used to answer both with the same sentence, so a bug inside a
 * generator that was present and working was reported as a missing npm package and the real reason
 * was demoted to a trailing detail line. The two are distinguishable, and this proves the
 * distinguisher on real module loads rather than on hand-built error objects: an absent package, a
 * present package whose own dependency is absent, and a module that throws while evaluating all
 * arrive here as they arrive in production.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as os from 'node:os';
import * as path from 'node:path';
import { GeneratorNotInstalledError, loadGenerator } from '../src/generator-loader';

/**
 * Outside the repository on purpose. A fixture written under `packages/` would resolve its
 * "absent" dependency against this workspace's node_modules and stop being absent.
 */
let ROOT = '';
const url = (p: string) => pathToFileURL(p).href;

beforeAll(async () => {
  ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-loader-'));
  await fs.mkdir(path.join(ROOT, 'node_modules', 'present-pkg'), { recursive: true });
  await fs.writeFile(
    path.join(ROOT, 'node_modules', 'present-pkg', 'package.json'),
    JSON.stringify({ name: 'present-pkg', version: '1.0.0', type: 'module', main: 'index.js' }),
    'utf8'
  );
  await fs.writeFile(
    path.join(ROOT, 'node_modules', 'present-pkg', 'index.js'),
    `import 'a-dependency-nobody-installed';\nexport const ok = true;\n`,
    'utf8'
  );
  await fs.writeFile(
    path.join(ROOT, 'throws-on-load.mjs'),
    `throw new Error('the generator blew up while loading');\n`,
    'utf8'
  );
  await fs.writeFile(path.join(ROOT, 'loads-fine.mjs'), `export const value = 41 + 1;\n`, 'utf8');
});

afterAll(async () => {
  if (ROOT) await fs.rm(ROOT, { recursive: true, force: true });
});

describe('loadGenerator', () => {
  it('returns the module when the package loads', async () => {
    const spec = url(path.join(ROOT, 'loads-fine.mjs'));
    const mod = await loadGenerator<{ value: number }>(spec, () => import(/* @vite-ignore */ spec));
    expect(mod.value).toBe(42);
  });

  it('reports a package that is genuinely not installed as not installed', async () => {
    const spec = '@drzl/generator-nobody-published';
    await expect(
      loadGenerator(spec, () => import(/* @vite-ignore */ spec))
    ).rejects.toBeInstanceOf(GeneratorNotInstalledError);
  });

  it('keeps the specifier on the not-installed error, so the install line names it', async () => {
    const spec = '@drzl/generator-nobody-published';
    const err = await loadGenerator(spec, () => import(/* @vite-ignore */ spec)).catch((e) => e);
    expect(err).toBeInstanceOf(GeneratorNotInstalledError);
    expect((err as GeneratorNotInstalledError).specifier).toBe(spec);
  });

  it('does not call a present package absent when one of its own imports is', async () => {
    // The hardest case, and the one a bare `ERR_MODULE_NOT_FOUND` check gets wrong: the package
    // asked for resolved perfectly well, and something it imported did not. Node reports both
    // with the same code, and only the message says which specifier failed.
    const spec = 'present-pkg';
    const from = url(path.join(ROOT, 'consumer.mjs'));
    const err = await loadGenerator(spec, () =>
      import(/* @vite-ignore */ new URL('./node_modules/present-pkg/index.js', from).href)
    ).catch((e) => e);
    expect(err).not.toBeInstanceOf(GeneratorNotInstalledError);
    expect((err as Error).message).toContain('a-dependency-nobody-installed');
  });

  it('lets an error thrown while the module evaluates through untouched', async () => {
    const spec = url(path.join(ROOT, 'throws-on-load.mjs'));
    const err = await loadGenerator(spec, () => import(/* @vite-ignore */ spec)).catch((e) => e);
    expect(err).not.toBeInstanceOf(GeneratorNotInstalledError);
    expect((err as Error).message).toBe('the generator blew up while loading');
  });

  it('lets an error thrown after the module loaded through untouched', async () => {
    // The load succeeded, so nothing about this is a packaging problem. This is the shape of the
    // real bug: the CLI wrapped `generate()` in the same try as the import.
    const spec = url(path.join(ROOT, 'loads-fine.mjs'));
    const err = await loadGenerator(spec, async () => {
      await import(/* @vite-ignore */ spec);
      throw new Error('EACCES: permission denied, mkdir');
    }).catch((e) => e);
    expect(err).not.toBeInstanceOf(GeneratorNotInstalledError);
    expect((err as Error).message).toContain('EACCES');
  });
});
