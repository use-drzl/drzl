/**
 * Every entry point a published package names has to load, in both module formats, from a plain
 * Node process running against `dist`.
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
 * `--format esm,cjs` and `files: ["dist"]` publishes it. A file that ships is a file a consumer
 * can reach.
 *
 * The CLI's own entry is a bin: it calls `program.parseAsync(process.argv)` at module scope, so
 * importing it runs the program. It is exercised the way a consumer reaches it instead, by being
 * run, which is the only form in which a CommonJS bundle that cannot start would show up.
 *
 * This asserts on the build, so the build has to have happened. `pnpm build` first.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const packagesDir = path.join(repoRoot, 'packages');

interface Manifest {
  name: string;
  private?: boolean;
  main?: string;
  bin?: Record<string, string>;
  exports?: Record<string, string | Record<string, string>>;
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
  entryPoints(manifest).map((entry) => ({ dir, name: manifest.name, entry }))
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

const entriesOf = (dir: string) => entryPoints(publishable.find((p) => p.dir === dir)!.manifest);

describe.each(cases)('$name $entry.subpath', ({ dir, entry }) => {
  it('emits both an ESM entry and its CommonJS twin', () => {
    requireBuilt(dir, entry.esm, true);
    requireBuilt(dir, entry.cjs, entry.cjsDeclared);
  });

  if (entry.isBin) {
    it.each(['esm', 'cjs'] as const)('runs as a program from the %s build', (format) => {
      const abs = requireBuilt(dir, entry[format], format === 'esm' || entry.cjsDeclared);
      // A bin cannot be imported for its exports: this one parses argv at module scope. Running
      // it is what a consumer does and is the only thing that catches a bundle that cannot start.
      const out = execFileSync(process.execPath, [abs, '--version'], {
        cwd: probeDir,
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(
        out.trim().length,
        `${dir} ${format} bin printed nothing for --version`
      ).toBeGreaterThan(0);
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
