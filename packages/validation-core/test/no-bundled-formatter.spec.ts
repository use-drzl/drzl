/**
 * The published bundles must not contain a formatter, and must still work without one.
 *
 * `formatCode` reached prettier through `await import('prettier')`, a specifier tsup can resolve
 * statically, so esbuild inlined the whole of prettier into `dist`: 11 MB per package across the
 * three that had a copy of the function, roughly 32 MB pulled in by installing `@drzl/cli`. The
 * source looked correct throughout. Only the artefact was wrong, which is why this asserts on a
 * real build rather than on the source.
 *
 * It builds each package with the `build` script from its own package.json rather than a build
 * of its own, and runs the built entry in a child process with no node_modules in scope, which is
 * a genuinely missing optional peer rather than a mocked one.
 *
 * What the byte-level checks below can and cannot see, measured rather than assumed. Two separate
 * things keep prettier out of the bundle, and **either one alone is sufficient**: the
 * `--external prettier` flag in the build script, and the `peerDependencies` entry, which tsup
 * externalises by default. Deleting either one on its own leaves all of these green, because the
 * bundle really is still correct. Only deleting both puts prettier back, and that these catch.
 *
 * That leaves a gap those checks structurally cannot cover, so it is asserted directly at the
 * bottom of this file: dropping the peer entry keeps the bundle small and still breaks users.
 * pnpm links an optional peer into the package's own node_modules only because it is declared,
 * so without the entry `import('prettier')` resolves to nothing for a pnpm consumer and their
 * output silently stops being formatted, with no size change to notice it by.
 *
 * It lives in validation-core because validation-core owns `formatCode`; the other two packages
 * are covered here because they are the ones that used to carry a private copy of it.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
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

/**
 * The built validation-core, copied somewhere Node's resolver cannot reach this repo's
 * node_modules, so an optional peer is genuinely missing rather than mocked away.
 */
const sandboxed = new Map<string, Promise<string>>();
function sandbox(): Promise<string> {
  const existing = sandboxed.get('validation-core');
  if (existing) return existing;
  const run = (async () => {
    const dir = await build('validation-core');
    const to = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-no-peer-'));
    for (const name of await fs.readdir(dir)) {
      await fs.copyFile(path.join(dir, name), path.join(to, name));
    }
    // Without this, `.js` in a directory with no manifest is read as CommonJS.
    await fs.writeFile(path.join(to, 'package.json'), '{"type":"module"}');
    return to;
  })();
  sandboxed.set('validation-core', run);
  return run;
}

/** Both published entry points, since a consumer reaches one or the other and not both. */
const ENTRIES = ['./index.js', './index.cjs'];

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
    // Both, and in the same form: esbuild leaves an external `import()` alone in a CJS bundle
    // rather than lowering it to `require`, which is what lets a CommonJS consumer reach an
    // ESM-only prettier at all.
    expect(esm).toMatch(/import\("prettier"\)/);
    expect(cjs).toMatch(/import\("prettier"\)/);
  });

  it('returns the code unchanged when prettier is genuinely not installed', async () => {
    const dir = await sandbox();
    await fs.writeFile(
      path.join(dir, 'probe.mjs'),
      [
        'const input = "export  const  a={x:1,y:\'two\'}\\n";',
        "const at = new URL('./generated.ts', import.meta.url).pathname;",
        'let resolved = true;',
        "try { await import('prettier'); } catch { resolved = false; }",
        'const out = {};',
        `for (const entry of ${JSON.stringify(ENTRIES)}) {`,
        '  const mod = await import(entry);',
        '  const fn = mod.formatCode ?? mod.default?.formatCode;',
        '  out[entry] = (await fn(input, at)) === input;',
        '}',
        'process.stdout.write(JSON.stringify({ resolved, out }));',
      ].join('\n')
    );
    // A child process, because vitest resolves bare specifiers through vite against this
    // workspace: an in-process import would have found the repo's prettier and proved nothing.
    const raw = execFileSync(process.execPath, ['probe.mjs'], { cwd: dir, encoding: 'utf8' });
    const result = JSON.parse(raw);
    expect(result.resolved, 'prettier resolved in the sandbox, so this proved nothing').toBe(false);
    expect(result.out).toEqual(Object.fromEntries(ENTRIES.map((e) => [e, true])));
  });

  /**
   * The same real absence, for a consumer who named the engine.
   *
   * `engine: 'auto'` above asked for whatever was present and got an answer. Naming an engine is a
   * request, and the request went unmet: the files come back exactly as rendered. Returning them
   * with nothing on stderr is the whole defect, and it is asserted here rather than only against a
   * mocked import because a stub proves the branch runs, not that a real resolution failure lands
   * in it. Neither formatter is installed in this sandbox, so both specifiers fail the way they
   * fail for a consumer who has not installed them.
   */
  it('says so on stderr when the named engine is genuinely not installed', async () => {
    const dir = await sandbox();
    const engines = ['prettier', 'biome'];
    await fs.writeFile(
      path.join(dir, 'probe-named.mjs'),
      [
        'const input = "export  const  a={x:1,y:\'two\'}\\n";',
        "const at = new URL('./generated.ts', import.meta.url).pathname;",
        'const out = {};',
        `for (const entry of ${JSON.stringify(ENTRIES)}) {`,
        '  const mod = await import(entry);',
        '  const fn = mod.formatCode ?? mod.default?.formatCode;',
        `  for (const engine of ${JSON.stringify(engines)}) {`,
        // Twice, so a warning repeated per emitted file would show up in the count below.
        '    await fn(input, at, { engine });',
        '    out[entry + " " + engine] = (await fn(input, at, { engine })) === input;',
        '  }',
        '}',
        'process.stdout.write(JSON.stringify(out));',
      ].join('\n')
    );
    // spawnSync rather than execFileSync, because the message under test is the stderr.
    const run = spawnSync(process.execPath, ['probe-named.mjs'], { cwd: dir, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    const wanted = ENTRIES.flatMap((e) => engines.map((g) => [`${e} ${g}`, true]));
    expect(JSON.parse(run.stdout)).toEqual(Object.fromEntries(wanted));

    const lines = run.stderr.split('\n').filter((l) => l.includes('[drzl] format.engine'));
    // One per engine per module instance, and no more: each entry is a separate copy of the
    // module with its own record of what it has already reported.
    expect(lines).toHaveLength(wanted.length);
    for (const engine of engines) {
      // `is "<engine>"` rather than the bare name, because the biome message mentions prettier
      // too, as one of the things to switch to.
      const line = lines.find((l) => l.includes(`is "${engine}"`));
      expect(line, `nothing on stderr named the ${engine} engine`).toBeTruthy();
    }
    // The resolver's own words for a package that is not installed, which is what separates this
    // from a mocked import and from a formatter that loaded and then misbehaved. Asserted for both,
    // since the prose of the message names both packages on its own and would match either way.
    //
    // The two engines reach their package differently and their resolvers say different things, so
    // these are not the same string with a name swapped. Prettier is imported, and an ESM import
    // that cannot resolve says "Cannot find package". Biome is spawned as the binary it publishes,
    // which is found by resolving its manifest with `createRequire`, and that says "Cannot find
    // module" naming the manifest path. Both are quoted from a run rather than composed here.
    expect(run.stderr).toContain("Cannot find package 'prettier'");
    expect(run.stderr).toContain("Cannot find module '@biomejs/biome/package.json'");
  });
});

describe('the two declarations that keep prettier external', () => {
  const manifest = async () =>
    JSON.parse(
      await fs.readFile(path.join(repoRoot, 'packages/validation-core/package.json'), 'utf8')
    );

  it('declares prettier as an optional peer, and the install honours it', async () => {
    // The one deletion nothing above can see. Removing this entry leaves the bundle exactly as
    // small and correct as it is now, and stops prettier resolving for a pnpm consumer, because
    // pnpm links an optional peer into the package's own node_modules only when it is declared.
    // Their generated files would quietly stop being formatted with no size change to notice by.
    const pkg = await manifest();
    expect(pkg.peerDependencies?.prettier).toBe('>=3');
    expect(pkg.peerDependenciesMeta?.prettier?.optional).toBe(true);
    // Declared and then actually linked, which is the mechanism rather than the intent. A missing
    // link here means the entry was added without the lockfile being regenerated.
    await expect(
      fs.stat(path.join(repoRoot, 'packages/validation-core/node_modules/prettier'))
    ).resolves.toBeTruthy();
  });

  it('also passes --external prettier, which is a second and independent guarantee', async () => {
    // tsup externalises peerDependencies on its own, so this flag is redundant while the entry
    // above exists, and that is the point: either one alone keeps prettier out of the bundle, so
    // one of them being lost is survivable. Delete this assertion if you delete the flag, and
    // know that the peer entry is then all that stands between this build and 11 MB.
    const pkg = await manifest();
    expect(pkg.scripts.build).toContain('--external prettier');
  });
});
