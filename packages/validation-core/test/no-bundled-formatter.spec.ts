/**
 * The published bundles must not contain a formatter, and must still work without one.
 *
 * `formatCode` reached prettier through `await import('prettier')`, a specifier tsup can resolve
 * statically, so esbuild inlined the whole of prettier into `dist`: 11 MB per package across the
 * three that had a copy of the function, roughly 32 MB pulled in by installing `@drzl/cli`. The
 * source looked correct throughout. Only the artefact was wrong, which is why this asserts on a
 * real build rather than on the source.
 *
 * It builds each package with the `build` script from its own package.json, so removing the
 * `--external` flag there fails here rather than only at publish time, and it runs the built
 * entry in a child process with no node_modules in scope, which is a genuinely missing optional
 * peer rather than a mocked one.
 *
 * It lives in validation-core because validation-core owns `formatCode`; the other two packages
 * are covered here because they are the ones that used to carry a private copy of it.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

/** Every package that has ever reached `formatCode`, and so could bundle a formatter again. */
const packages = ['validation-core', 'generator-orpc', 'generator-service'];

/**
 * A formatter is megabytes; everything DRZL emits is tens of kilobytes. Anything between the two
 * is worth a look, so the ceiling is deliberately far above the real figure rather than a budget
 * to be tuned. Raising it is not the fix for a build that started bundling a dependency.
 */
const CEILING = 1_000_000;

/**
 * A string prettier's own source contains and nothing here does. The size check alone would catch
 * a whole formatter; this one names it, and catches a partial parser too.
 */
const MARKER = 'prettier-ignore';

const built = new Map<string, Promise<string>>();

/** Run a package's real build script into a temp directory, so nothing stale can answer for it. */
function build(pkg: string): Promise<string> {
  const existing = built.get(pkg);
  if (existing) return existing;
  const run = (async () => {
    const dir = path.join(repoRoot, 'packages', pkg);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    const script: string = manifest.scripts.build;
    expect(script, `${pkg} has no build script`).toMatch(/^tsup /);
    const out = await fs.mkdtemp(path.join(os.tmpdir(), `drzl-build-${pkg}-`));
    // `pnpm exec` so the workspace's own tsup answers, and a shell so the script is run exactly
    // as written rather than re-assembled from parsed arguments.
    execFileSync('pnpm', ['exec', 'sh', '-c', `${script} --out-dir ${out}`], {
      cwd: dir,
      stdio: 'pipe',
    });
    return out;
  })();
  built.set(pkg, run);
  return run;
}

async function outputFiles(dir: string) {
  const names = (await fs.readdir(dir)).filter((f) => /\.(js|cjs|mjs)$/.test(f));
  return Promise.all(
    names.map(async (name) => ({ name, text: await fs.readFile(path.join(dir, name), 'utf8') }))
  );
}

describe.each(packages)('%s, freshly built', (pkg) => {
  it('is small enough that no formatter can be hiding in it', async () => {
    const dir = await build(pkg);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    let total = 0;
    for (const e of entries) {
      if (e.isFile()) total += (await fs.stat(path.join(dir, e.name))).size;
    }
    expect(total, `${pkg} dist is ${(total / 1e6).toFixed(1)} MB`).toBeLessThan(CEILING);
  });

  it('contains no prettier source', async () => {
    const dir = await build(pkg);
    const offenders = (await outputFiles(dir)).filter((f) => f.text.includes(MARKER));
    expect(offenders.map((f) => f.name)).toEqual([]);
  });
});

describe('the built validation-core entry', () => {
  it('still asks for prettier by name, rather than having lost the call', async () => {
    // The cheap way to shrink the bundle is to stop calling prettier at all, which would pass
    // both checks above and silently unformat every generated file. The specifier surviving in
    // the output is what separates "external" from "gone".
    const dir = await build('validation-core');
    const esm = await fs.readFile(path.join(dir, 'index.js'), 'utf8');
    const cjs = await fs.readFile(path.join(dir, 'index.cjs'), 'utf8');
    expect(esm).toMatch(/import\("prettier"\)/);
    expect(cjs).toMatch(/require\("prettier"\)/);
  });

  it('returns the code unchanged when prettier is genuinely not installed', async () => {
    const dir = await build('validation-core');
    // A copy outside the workspace, so Node's resolver cannot walk up into this repo's
    // node_modules and find prettier there.
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-no-peer-'));
    for (const name of await fs.readdir(dir)) {
      await fs.copyFile(path.join(dir, name), path.join(sandbox, name));
    }
    // Without this, `.js` in a directory with no manifest is read as CommonJS.
    await fs.writeFile(path.join(sandbox, 'package.json'), '{"type":"module"}');
    await fs.writeFile(
      path.join(sandbox, 'probe.mjs'),
      [
        'const input = "export  const  a={x:1,y:\'two\'}\\n";',
        "const at = new URL('./generated.ts', import.meta.url).pathname;",
        'let resolved = true;',
        "try { await import('prettier'); } catch { resolved = false; }",
        'const out = {};',
        "for (const entry of ['./index.js', './index.cjs']) {",
        '  const mod = await import(entry);',
        '  const fn = mod.formatCode ?? mod.default?.formatCode;',
        '  out[entry] = (await fn(input, at)) === input;',
        '}',
        'process.stdout.write(JSON.stringify({ resolved, out }));',
      ].join('\n')
    );
    // A child process, because vitest resolves bare specifiers through vite against this
    // workspace: an in-process import would have found the repo's prettier and proved nothing.
    const raw = execFileSync(process.execPath, ['probe.mjs'], { cwd: sandbox, encoding: 'utf8' });
    const result = JSON.parse(raw);
    expect(result.resolved, 'prettier resolved in the sandbox, so this proved nothing').toBe(false);
    expect(result.out).toEqual({ './index.js': true, './index.cjs': true });
  });
});
