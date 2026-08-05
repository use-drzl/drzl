/**
 * Every entry point a published package names loads, in both module formats, from a plain Node
 * process running against `dist`.
 *
 * `@drzl/validation-core`'s CommonJS bundle emitted unformatted output for its entire life.
 * `formatCode` reached prettier through `createRequire(import.meta.url)`, which esbuild lowers to
 * `createRequire(undefined)` in a CJS bundle, and a bare `catch {}` swallowed the throw. It
 * survived because nothing in this repo had ever loaded a CJS build: every other test imports
 * from source, and vitest resolves those imports through vite against the workspace, so an
 * in-process `import` says nothing about what tsup emitted. One package is covered by
 * `packages/validation-core/test/no-bundled-formatter.spec.ts`; this covers the other eleven.
 *
 * Hence a child process, plain Node, absolute paths into `dist`: `require()` for the CommonJS
 * twin and `import()` for the ESM entry, with the two export surfaces then compared, because a
 * format that loads and exports a different shape is the same defect one step later.
 *
 * The CommonJS twin is checked even where no `exports` map names it, because tsup emits it under
 * `--format esm,cjs` and `files: ["dist"]` publishes it.
 *
 * The CLI's own entry is a bin: it calls `program.parseAsync(process.argv)` at module scope, so
 * importing it runs the program. It is exercised the way a consumer reaches it instead, by being
 * run, which is the only form in which a CommonJS bundle that cannot start would show up.
 *
 * **What this does and does not prove.** The child inherits the Node running the tests, which in
 * this repo is 22.13 or newer, because pnpm 11 declares that floor and the workspace cannot be
 * installed below it. From Node 22.12 onwards `require()` of an ES module is allowed, and that is
 * what carries ten of these thirteen entries. It is not what the packages advertise: eleven
 * manifests say `engines.node: ">=18.17.0"` and `@drzl/cli` says `">=22"`, and every one of those
 * floors predates 22.12. That last sentence is checked rather than trusted, by the first test
 * below, because the previous version of this paragraph asserted a number that was wrong for one
 * of the twelve. So a green run here means the bundles load on the Node this repo develops on,
 * and says nothing about the floor the packages claim. The gap is measured rather than left to a
 * comment, at the bottom of this file.
 *
 * This asserts on the build, so the build has to have happened. `pnpm build` first.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const packagesDir = path.join(repoRoot, 'packages');

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  main?: string;
  bin?: Record<string, string>;
  exports?: Record<string, string | Record<string, string>>;
  engines?: { node?: string };
}

const rel = (p: string) => p.replace(/^\.\//, '');

/** Read from disk rather than listed, so a package added later is covered without editing this. */
const publishable = fs
  .readdirSync(packagesDir)
  .filter((dir) => fs.existsSync(path.join(packagesDir, dir, 'package.json')))
  .map((dir) => ({
    dir,
    manifest: JSON.parse(
      fs.readFileSync(path.join(packagesDir, dir, 'package.json'), 'utf8')
    ) as Manifest,
  }))
  .filter((p) => !p.manifest.private);

interface Entry {
  subpath: string;
  esm: string;
  cjs: string;
  isBin: boolean;
  /** Whether package.json names the CommonJS file, or it was derived as the twin beside the ESM
   *  one. Only the wording of a failure depends on this, and getting it wrong sends the reader
   *  looking for a field that is not there. */
  cjsDeclared: boolean;
}

/**
 * The entries a consumer can reach, each paired with the CommonJS twin beside it.
 *
 * `exports` when there is one, `main` otherwise. The twin is taken from the `require` condition
 * where the map declares it and derived from the ESM filename where it does not, which is nine of
 * the twelve packages: they publish a `.cjs` that no condition names.
 */
function entryPoints(m: Manifest): Entry[] {
  const bins = new Set(Object.values(m.bin ?? {}).map(rel));
  const found = new Map<string, Entry>();
  const add = (subpath: string, esm: string | undefined, cjs: string | undefined) => {
    if (!esm) return;
    const esmPath = rel(esm);
    found.set(subpath, {
      subpath,
      esm: esmPath,
      cjs: cjs ? rel(cjs) : esmPath.replace(/\.js$/, '.cjs'),
      isBin: bins.has(esmPath),
      cjsDeclared: Boolean(cjs),
    });
  };
  if (m.exports) {
    for (const [subpath, conditions] of Object.entries(m.exports)) {
      if (typeof conditions === 'string') add(subpath, conditions, undefined);
      else add(subpath, conditions.import ?? conditions.default, conditions.require);
    }
  } else {
    add('.', m.main, undefined);
  }
  return [...found.values()];
}

/**
 * Loads both formats of every entry and reports what each exported, or how it failed.
 *
 * One child per package: `execFileSync` is synchronous and twelve processes cost less than
 * twenty-four. Written to a temp directory rather than into the package, because resolution for
 * an absolute path does not consult the caller's location and a probe file left in `dist` would
 * be published by `files: ["dist"]`.
 */
const PROBE = `
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const job = JSON.parse(process.argv[2]);
const require = createRequire(pathToFileURL(job.pkgDir + '/probe.cjs').href);
const describe = (mod) =>
  Object.fromEntries(Object.keys(mod).sort().map((k) => {
    // typeof rather than the value: a CJS interop wrapper that turns a class into a plain object
    // exports the same name and is not the same module.
    try { return [k, typeof mod[k]]; } catch (e) { return [k, 'THREW: ' + e.message]; }
  }));

const out = {};
for (const entry of job.entries) {
  const result = {};
  for (const format of ['esm', 'cjs']) {
    const abs = job.pkgDir + '/' + entry[format];
    try {
      const mod = format === 'cjs' ? require(abs) : await import(pathToFileURL(abs).href);
      result[format] = { exports: describe(mod) };
    } catch (err) {
      result[format] = { error: String(err && err.stack ? err.stack : err) };
    }
  }
  out[entry.subpath] = result;
}
// To a file rather than to stdout: an entry that logs on import would land in the middle of the
// JSON, and the parent would report a parse error instead of the module that printed.
writeFileSync(job.resultFile, JSON.stringify(out));
`;

const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drzl-entry-probe-'));
const probeFile = path.join(probeDir, 'probe.mjs');
fs.writeFileSync(probeFile, PROBE);

type Loaded = { exports?: Record<string, string>; error?: string };
const loaded = new Map<string, Record<string, Record<'esm' | 'cjs', Loaded>>>();

function load(dir: string, entries: Entry[]) {
  const cached = loaded.get(dir);
  if (cached) return cached;
  const pkgDir = path.join(packagesDir, dir);
  const resultFile = path.join(probeDir, `${dir}.json`);
  const job = JSON.stringify({ pkgDir, resultFile, entries: entries.filter((e) => !e.isBin) });
  execFileSync(process.execPath, [probeFile, job], {
    cwd: probeDir,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const parsed = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  loaded.set(dir, parsed);
  return parsed;
}

/** A missing dist means the build has not run; a missing file inside one is a real defect. */
function requireBuilt(dir: string, file: string, declared: boolean) {
  const dist = path.join(packagesDir, dir, 'dist');
  if (!fs.existsSync(dist)) {
    throw new Error(
      `packages/${dir}/dist does not exist. These assertions are about the built artefact, ` +
        `not the source: run 'pnpm build' first.`
    );
  }
  const abs = path.join(packagesDir, dir, file);
  const why = declared
    ? `packages/${dir}/package.json points at ${file}, which the build did not emit.`
    : `packages/${dir} publishes no ${file} beside its ESM entry, so its build has stopped ` +
      `emitting CommonJS. Check for --format esm,cjs in the build script.`;
  expect(fs.existsSync(abs), `${why} dist holds: ${fs.readdirSync(dist).join(', ')}`).toBe(true);
  return abs;
}

const cases = publishable.flatMap(({ dir, manifest }) =>
  entryPoints(manifest).map((entry) => ({
    dir,
    name: manifest.name,
    version: manifest.version,
    entry,
  }))
);

it('found every publishable package', () => {
  // A discovery bug here would empty the table below and every assertion would pass vacuously.
  expect(publishable.map((p) => p.dir).sort()).toEqual([
    'analyzer',
    'cli',
    'generator-arktype',
    'generator-json-schema',
    'generator-orpc',
    'generator-service',
    'generator-typebox',
    'generator-valibot',
    'generator-zod',
    'template-orpc-service',
    'template-standard',
    'validation-core',
  ]);
  expect(cases.length).toBeGreaterThanOrEqual(publishable.length);
});

it('advertises a Node floor older than require(esm) everywhere', () => {
  // The premise of the table at the bottom of this file, and of the header's claim about it,
  // turned into something that fails rather than something a reader has to believe. The floors
  // are not uniform: eleven manifests say 18.17.0 and @drzl/cli says 22, and a comment that said
  // otherwise shipped once already.
  const tooNew = publishable
    .map(({ dir, manifest }) => {
      const declared = manifest.engines?.node ?? '';
      const m = declared.match(/>=\s*(\d+)(?:\.(\d+))?/);
      const major = m ? Number(m[1]) : Number.NaN;
      const minor = m ? Number(m[2] ?? 0) : Number.NaN;
      // 22.12 is where `require()` of an ES module arrived. A floor at or above it would mean
      // the table below is measuring a Node no consumer is promised, and is no longer evidence.
      const predates = major < 22 || (major === 22 && minor < 12);
      return { dir, declared, predates };
    })
    .filter((p) => !p.predates);
  expect(
    tooNew,
    'engines.node no longer predates require(esm), so the table below is moot'
  ).toEqual([]);
});

const entriesOf = (dir: string) => entryPoints(publishable.find((p) => p.dir === dir)!.manifest);

describe.each(cases)('$name $entry.subpath', ({ dir, version, entry }) => {
  it('emits both an ESM entry and its CommonJS twin', () => {
    requireBuilt(dir, entry.esm, true);
    requireBuilt(dir, entry.cjs, entry.cjsDeclared);
  });

  if (entry.isBin) {
    // A bin cannot be imported for its exports: this one parses argv at module scope. Running it
    // is what a consumer does and is the only thing that catches a bundle that cannot start.
    //
    // The assertion is equality with the manifest, not merely that something was printed. For
    // every one of the 29 published versions of @drzl/cli this printed the literal `0.0.1`,
    // hardcoded in the `program.version()` call, while the manifest said otherwise; a
    // non-empty check passed on all of them, so every version report ever filed was `0.0.1`.
    it.each(['--version', '-V'])('prints the manifest version for %s, from both builds', (flag) => {
      for (const format of ['esm', 'cjs'] as const) {
        const abs = requireBuilt(dir, entry[format], format === 'esm' || entry.cjsDeclared);
        const out = execFileSync(process.execPath, [abs, flag], {
          cwd: probeDir,
          encoding: 'utf8',
          timeout: 60_000,
        });
        expect(
          out.trim(),
          `${dir} ${format} bin printed the wrong version for ${flag}; packages/${dir}/package.json ` +
            `says ${version}. A stale dist is one cause, so try 'pnpm build' before reading further.`
        ).toBe(version);
      }
    });
    return;
  }

  it.each(['esm', 'cjs'] as const)('loads from the %s build and exports something', (format) => {
    requireBuilt(dir, entry[format], format === 'esm' || entry.cjsDeclared);
    const result = load(dir, entriesOf(dir))[entry.subpath][format];
    expect(result.error, `${dir} ${entry.subpath} failed to load as ${format}`).toBeUndefined();
    expect(
      Object.keys(result.exports ?? {}).length,
      `${dir} ${entry.subpath} loaded as ${format} and exported nothing`
    ).toBeGreaterThan(0);
  });

  it('exports the same names, with the same types, from both builds', () => {
    const result = load(dir, entriesOf(dir))[entry.subpath];
    // A load failure on either side would show up here as an unhelpful "undefined", so it is
    // named instead; the test above is the one that owns that failure.
    for (const format of ['esm', 'cjs'] as const) {
      expect(
        result[format].error,
        `${dir} ${entry.subpath} did not load as ${format}, so there is nothing to compare`
      ).toBeUndefined();
    }
    // Both sides at once, so a diff names the entry rather than reporting two unrelated failures.
    expect(result.cjs.exports).toEqual(result.esm.exports);
  });
});

/**
 * The same CommonJS files, on the Node the packages say they run on.
 *
 * `engines.node` names a floor below 22.12 in all twelve manifests: eleven say `">=18.17.0"` and
 * `@drzl/cli` says `">=22"`, which still predates it. That is asserted further up rather than
 * left as a sentence here. `require()` of an ES module did not exist before 22.12, and ten of
 * these thirteen entries need it, so on the advertised floor they throw `ERR_REQUIRE_ESM`. The
 * block above cannot see that, because the Node running the tests is 22.13 or newer: pnpm 11
 * declares that floor and the workspace cannot be installed below it.
 *
 * `--no-experimental-require-module` turns the newer behaviour off, which is the closest a modern
 * Node gets to the old one for this question.
 *
 * The cause is one line repeated: every failing bundle does `require("@drzl/<sibling>")`, and
 * every DRZL package is `"type": "module"` with an ESM `main`, so the CommonJS build of one
 * package can only reach another through an ESM file. The three that survive are exactly the
 * three whose CommonJS bundle requires no `@drzl` sibling at all.
 *
 * This pins the measurement rather than endorsing it. It fails if the set grows, which is a new
 * package inheriting the defect, and it fails if the set shrinks, which is the defect being fixed
 * and this table needing to say so. It is not a passing grade for the CommonJS builds.
 *
 * Measured 2026-08-03 on Node 22.22.0.
 */
const ON_THE_ADVERTISED_ENGINE_FLOOR: Record<string, 'loads' | 'ERR_REQUIRE_ESM'> = {
  'analyzer .': 'loads',
  'cli .': 'ERR_REQUIRE_ESM',
  'cli ./config': 'ERR_REQUIRE_ESM',
  'generator-arktype .': 'ERR_REQUIRE_ESM',
  'generator-json-schema .': 'ERR_REQUIRE_ESM',
  'generator-orpc .': 'ERR_REQUIRE_ESM',
  'generator-service .': 'ERR_REQUIRE_ESM',
  'generator-typebox .': 'ERR_REQUIRE_ESM',
  'generator-valibot .': 'ERR_REQUIRE_ESM',
  'generator-zod .': 'ERR_REQUIRE_ESM',
  'template-orpc-service .': 'ERR_REQUIRE_ESM',
  'template-standard .': 'loads',
  'validation-core .': 'loads',
};

const NO_REQUIRE_ESM = '--no-experimental-require-module';
/** Node below 22.12 has no such flag and refuses to start, and on those versions the block above
 *  measures this anyway, because there `require()` of an ES module is simply not available. */
const flagAccepted = (() => {
  try {
    execFileSync(process.execPath, [NO_REQUIRE_ESM, '-e', ''], { stdio: 'pipe', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(flagAccepted)('the CommonJS builds, on Node without require(esm)', () => {
  it('still fail exactly where they are known to fail, and nowhere else', () => {
    const measured: Record<string, string> = {};
    for (const { dir, entry } of cases) {
      const abs = path.join(packagesDir, dir, entry.cjs);
      // `-e` with the path interpolated as a JSON literal, so nothing has to be escaped by hand.
      // The error code is printed rather than thrown, so a bin that starts and then exits on its
      // own argv cannot be mistaken for a load failure.
      const src = `try { require(${JSON.stringify(abs)}); } catch (e) { process.stderr.write('DRZL_LOAD_ERROR:' + (e.code || e.name)); }`;
      // spawnSync rather than execFileSync: the child reports the load failure on stderr and then
      // exits 0, so execFileSync would return without ever handing the stderr over.
      const run = spawnSync(process.execPath, [NO_REQUIRE_ESM, '-e', src], {
        cwd: probeDir,
        encoding: 'utf8',
        timeout: 60_000,
      });
      const marker = String(run.stderr ?? '').match(/DRZL_LOAD_ERROR:(\w+)/);
      measured[`${dir} ${entry.subpath}`] = marker ? marker[1] : 'loads';
    }
    expect(
      measured,
      'a + row is a package that has newly inherited this defect; a - row is one that no longer ' +
        'has it, so update ON_THE_ADVERTISED_ENGINE_FLOOR and say which change fixed it'
    ).toEqual(ON_THE_ADVERTISED_ENGINE_FLOOR);
  });
});
