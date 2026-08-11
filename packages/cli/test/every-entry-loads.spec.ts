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
 * `packages/validation-core/test/no-bundled-formatter.spec.ts`; this covers the other twelve.
 *
 * Hence a child process, plain Node, absolute paths into `dist`: `require()` for the CommonJS
 * twin and `import()` for the ESM entry, with the two export surfaces then compared, because a
 * format that loads and exports a different shape is the same defect one step later.
 *
 * The CommonJS twin is checked even where no `exports` map names it, because tsup emits it under
 * `--format esm,cjs` and `files: ["dist"]` publishes it. `@drzl/cli` is the only package left in
 * that position, for `./config`.
 *
 * Everything here loads a file by absolute path, which is deliberate and is also this file's
 * blind spot: it says nothing about whether `require('@drzl/generator-zod')` reaches that file.
 * For ten packages it did not, for their whole published life. That half is in
 * `packages/validation-core/test/require-entry.spec.ts`, which resolves by package name through a
 * real node_modules tree.
 *
 * The CLI's own entry is a bin: it calls `program.parseAsync(process.argv)` at module scope, so
 * importing it runs the program. It is exercised the way a consumer reaches it instead, by being
 * run, which is the only form in which a CommonJS bundle that cannot start would show up.
 *
 * **What this does and does not prove.** The child inherits the Node running the tests, which in
 * this repo is 22.13 or newer, because pnpm 11 declares that floor and the workspace cannot be
 * installed below it. From Node 22.12 onwards `require()` of an ES module is allowed, so a green
 * run in this block can be carried by a feature the packages do not advertise: twelve manifests
 * say `engines.node: ">=18.17.0"` and `@drzl/cli` says `">=22"`, and every one of those floors
 * predates 22.12. That last sentence is checked rather than trusted, by the first test below,
 * because the previous version of this paragraph asserted a number that was wrong for one of the
 * set. So a green run here means the bundles load on the Node this repo develops on, and says
 * nothing about the floor the packages claim. The gap is measured rather than left to a comment,
 * at the bottom of this file.
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

/** A node in an `exports` map: a path, or further conditions nested to any depth. */
type Conditions = string | { [condition: string]: Conditions };

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  main?: string;
  bin?: Record<string, string>;
  exports?: Record<string, Conditions>;
  engines?: { node?: string };
}

const rel = (p: string) => p.replace(/^\.\//, '');

/**
 * The file a condition leads to, following `exports` down as far as it nests.
 *
 * Reading `conditions.import` as a path was enough while every map here was one level deep. It
 * stopped being enough when the manifests grew a `types` inside each condition, which is what
 * `moduleResolution: node16` needs in order to hand a CommonJS consumer a `.d.cts`, and the
 * one-level read then found an object where it expected a string.
 *
 * `types` is never followed: it names a declaration file, and the point of this file is loading
 * something in a child process.
 */
function pick(node: Conditions | undefined, want: 'import' | 'require'): string | undefined {
  if (node === undefined) return undefined;
  if (typeof node === 'string') return node;
  for (const key of [want, 'default']) {
    const found = pick(node[key], want);
    if (found) return found;
  }
  return undefined;
}

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
 * the thirteen packages: they publish a `.cjs` that no condition names.
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
      add(subpath, pick(conditions, 'import'), pick(conditions, 'require'));
    }
  } else {
    add('.', m.main, undefined);
  }
  return [...found.values()];
}

/**
 * Loads both formats of every entry and reports what each exported, or how it failed.
 *
 * One child per package: `execFileSync` is synchronous and thirteen processes cost less than
 * twenty-six. Written to a temp directory rather than into the package, because resolution for
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
    'generator-ai',
    'generator-arktype',
    'generator-effect',
    'generator-effect-http',
    'generator-elysia',
    'generator-express',
    'generator-fastify',
    'generator-graphql',
    'generator-h3',
    'generator-hono',
    'generator-json-schema',
    'generator-mcp',
    'generator-nestjs',
    'generator-next',
    'generator-orpc',
    'generator-seed',
    'generator-service',
    'generator-tanstack-start',
    'generator-trpc',
    'generator-ts-rest',
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
  // are not uniform: twelve manifests say 18.17.0 and @drzl/cli says 22, and a comment that said
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
 * `engines.node` names a floor below 22.12 in all thirteen manifests: twelve say `">=18.17.0"` and
 * `@drzl/cli` says `">=22"`, which still predates it. That is asserted further up rather than
 * left as a sentence here. `require()` of an ES module did not exist before 22.12, so a bundle
 * that needs it throws `ERR_REQUIRE_ESM` on the advertised floor. The block above cannot see that,
 * because the Node running the tests is 22.13 or newer: pnpm 11 declares that floor and the
 * workspace cannot be installed below it.
 *
 * `--no-experimental-require-module` turns the newer behaviour off, which is the closest a modern
 * Node gets to the old one for this question.
 *
 * Ten of these entries used to fail here, all for one reason: each CommonJS bundle did
 * `require("@drzl/<sibling>")` and every DRZL package was `"type": "module"` with an ESM `main`
 * and no `exports` map, so the only file a sibling `require` could reach was an ES module. The
 * twelve library manifests now carry an `exports` map whose `require` condition names the `.cjs`
 * beside the `.js`, and the chain resolves to CommonJS the whole way down.
 *
 * One entry still fails, and not for a reason DRZL owns: `@drzl/cli`'s own bundle requires
 * `chalk@6`, which is ESM only (`"type": "module"`, one unconditional `exports` target, and its
 * own `engines.node` of `">=22"`). No manifest change here can make that requireable. It is also
 * the one entry no consumer reaches by `require`: it is the bin, run as a program.
 *
 * A `+` row is a package that has newly inherited the defect. A `-` row is one that no longer has
 * it, which means this table has to say what fixed it.
 *
 * Measured 2026-08-05 on Node 22.22.0, and confirmed against node:18.20.8, node:20.18, node:20.19
 * and node:22.11 in docker with the packed tarballs installed by npm.
 */
const ON_THE_ADVERTISED_ENGINE_FLOOR: Record<string, 'loads' | 'ERR_REQUIRE_ESM'> = {
  'analyzer .': 'loads',
  // chalk@6 is ESM only. Every other entry here is CommonJS all the way down.
  'cli .': 'ERR_REQUIRE_ESM',
  'cli ./config': 'loads',
  'generator-ai .': 'loads',
  'generator-arktype .': 'loads',
  'generator-effect .': 'loads',
  'generator-effect-http .': 'loads',
  'generator-elysia .': 'loads',
  'generator-express .': 'loads',
  'generator-fastify .': 'loads',
  'generator-graphql .': 'loads',
  'generator-h3 .': 'loads',
  'generator-hono .': 'loads',
  'generator-json-schema .': 'loads',
  'generator-mcp .': 'loads',
  'generator-nestjs .': 'loads',
  'generator-next .': 'loads',
  'generator-orpc .': 'loads',
  'generator-seed .': 'loads',
  'generator-service .': 'loads',
  'generator-tanstack-start .': 'loads',
  'generator-trpc .': 'loads',
  'generator-ts-rest .': 'loads',
  'generator-typebox .': 'loads',
  'generator-valibot .': 'loads',
  'generator-zod .': 'loads',
  'template-orpc-service .': 'loads',
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
