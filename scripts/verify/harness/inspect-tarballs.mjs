import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const strip = (p) => String(p).replace(/^\.\//, '');

/**
 * Things a consumer has no use for, and which reach a tarball only by a `files` entry that is too
 * wide or by a build writing outside `dist`. Sources are the expensive one: they are the bulk of
 * a package by size and they let a consumer's bundler resolve past the built entry into
 * unpublished code.
 */
const BANNED = [
  [/^src\//, 'source'],
  [/^(test|tests|__tests__)\//, 'tests'],
  [/^node_modules\//, 'an installed dependency tree'],
  [/(^|\/)tsconfig[^/]*\.json$/, 'compiler configuration'],
  [/\.tsbuildinfo$/, 'an incremental build cache'],
  [/(^|\/)(vitest|eslint|tsup|prettier)\.config\./, 'tooling configuration'],
  [/\.(spec|test)\.[cm]?[jt]sx?$/, 'a test file'],
  [/^\.(npmrc|env)/, 'local machine configuration'],
];

let bad = 0;
const tarballs = fs.readdirSync(dir).filter((f) => f.endsWith('.tgz')).sort();
if (!tarballs.length) {
  console.error('FAIL: no tarballs to inspect.');
  process.exit(1);
}

for (const file of tarballs) {
  const tgz = path.join(dir, file);
  const listed = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' })
    .split('\n')
    .map(strip)
    .filter((l) => l && !l.endsWith('/'));
  // Every path in an npm tarball is under `package/`; the manifest's paths are relative to it.
  const shipped = new Set(listed.map((l) => l.replace(/^package\//, '')));
  const raw = execFileSync('tar', ['-xzOf', tgz, 'package/package.json'], { encoding: 'utf8' });
  const pkg = JSON.parse(raw);

  const problems = [];

  // Every path the manifest names, wherever it names it. `exports` is walked to any depth rather
  // than read at a fixed one, because conditions nest and a subpath added later would otherwise
  // be checked by nothing.
  const referenced = new Map();
  const note = (where, value) => {
    if (typeof value === 'string' && value) referenced.set(strip(value), where);
  };
  note('main', pkg.main);
  note('types', pkg.types);
  note('module', pkg.module);
  for (const [name, target] of Object.entries(pkg.bin ?? {})) note(`bin.${name}`, target);
  const walk = (node, at) => {
    if (typeof node === 'string') return note(at, node);
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, `${at}[${k}]`);
    }
  };
  walk(pkg.exports, 'exports');

  for (const [target, where] of referenced) {
    if (!shipped.has(target)) {
      problems.push(`${where} names ${target}, which is not in the tarball`);
    }
  }

  // Every ESM entry's CommonJS twin. The builds all pass --format esm,cjs and `files: ["dist"]`
  // publishes the result, so the twin is part of the artefact whether or not a condition names
  // it, and @drzl/validation-core's twin was broken for its whole life with nothing looking at it.
  for (const [target, where] of referenced) {
    if (!target.endsWith('.js')) continue;
    const twin = target.replace(/\.js$/, '.cjs');
    if (!shipped.has(twin)) {
      problems.push(`${where} ships ${target} but no ${twin} beside it`);
    }
  }

  for (const entry of shipped) {
    for (const [pattern, what] of BANNED) {
      if (pattern.test(entry)) problems.push(`ships ${entry}, which is ${what}`);
    }
  }

  // A `workspace:` range that survived packing installs for nobody. pnpm rewrites them on the way
  // into the tarball, so one surviving here means this artefact was not produced by `pnpm pack`.
  if (/"workspace:/.test(raw)) {
    problems.push('its manifest still carries a workspace: range, which npm cannot resolve');
  }

  if (problems.length) {
    bad++;
    console.error(`FAIL: ${pkg.name}`);
    for (const p of problems) console.error(`      ${p}`);
  } else {
    console.log(`    ${pkg.name.padEnd(30)} ${shipped.size} files, every entry point present`);
  }
}

if (bad) {
  console.error(`      ${bad} tarball(s) do not contain what their manifest promises.`);
  process.exit(1);
}
