#!/usr/bin/env bash
#
# Verify the artefact a consumer actually installs, rather than the workspace.
#
# Every package here is published from a tarball filtered by `files`, installed into a tree that
# has none of this repo's node_modules, and consumed by a tsc whose moduleResolution we do not
# control. None of that is exercised by `pnpm -r test`, which imports from source. Across eleven
# sibling repositories, essentially every serious defect lived in exactly that gap: a `files` rule
# that omitted a required file, a build that silently emitted nothing, a generated import specifier
# that did not resolve under the consumer's compiler.
#
# So this packs every publishable package, checks each tarball holds what its manifest promises,
# installs them into an empty project, runs the README's headline command, and typechecks the
# emitted tree under every moduleResolution TypeScript still supports.
# The last part is the point: DRZL emits `.js` specifiers precisely so the output compiles under
# node16 and nodenext, and nothing else in CI would notice if that regressed.
#
# Run locally with: pnpm verify:packed
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

TARS="$WORK/tars"
APP="$WORK/consumer"
mkdir -p "$TARS" "$APP/src/db"

# ---------------------------------------------------------------------------------------------
# Prose in this file that writes down a quantity a declaration in this file already holds.
#
# The whole design here is that quantities are asserted against a run or printed by one, and the
# file has still collected sentences restating a ledger size, a rejection count or the length of
# the pool. They go stale as a group rather than one at a time: adding a handful of pool values
# falsified more than a dozen of them in a single edit, and each of the two rounds that swept them
# out wrote a fresh one into the very paragraph doing the sweeping.
#
# A warning and not a gate, and that is measured rather than preferred. The broad formulation, a
# cardinal standing next to a ledger noun, flags dozens of comment blocks in this file with the
# sweep already done, almost all of them ordinary prose, and it still misses the survivors that
# read "the counts printed below are N of M" and "N ALLOWED entries", because neither puts a
# cardinal next to a noun such a pattern knows. A gate at that hit rate is waived into a no-op
# within a week. This file already carries one warning that cries wolf, on columns the analyzer
# cannot name, and it is filed as a defect rather than trusted.
#
# So what runs is the closed set of idioms these sentences are actually written in, and it is
# deliberately not exhaustive. The form "the six columns in that state" is outside it, and was
# left outside rather than covered at the cost of flagging every paragraph containing a number
# word. Each hit is printed with its line range and the words that matched, so a reader settles it
# rather than counts it, and nothing here is waivable: an idiom nobody wants flagged is a sentence
# to rewrite, not an exemption to declare.
#
# Both directions were run rather than argued, and both are recorded in the round-4 section of
# `.superpowers/sdd/2026-08-03-top-100/task-9-report.md`: a planted sentence of the species is
# named inside the block it was planted in, and on the file as it stands this prints a short list
# rather than nothing, with a verdict recorded there for every entry on it.
# ---------------------------------------------------------------------------------------------
echo "==> prose that writes down a number a declaration already holds"
cat > "$WORK/prose-counts.mjs" <<'PROSE_COUNTS'
import { readFileSync } from 'node:fs';

/**
 * Paragraphs of adjacent whole-line comments, not lines.
 *
 * Every stale count this was built from wrapped across a line break, so a line-scoped grep sees
 * the sameness idiom on one line and the number it governs on the next and matches neither half.
 * Consecutive comment lines are joined into one string and matched as a paragraph; a blank
 * comment line or a line of code ends the paragraph, which is where a claim ends too.
 *
 * Whole-line comments only. Both of the comment syntaxes in this file are read, since it is a
 * shell script whose payload is a stack of TypeScript heredocs, and the species has appeared in
 * both.
 */
const payload = (line) => {
  if (/^\s*#!/.test(line)) return null;
  let m;
  if ((m = /^\s*\/\/\s?(.*)$/.exec(line))) return m[1];
  if ((m = /^\s*#\s?(.*)$/.exec(line))) return m[1];
  if ((m = /^\s*\/\*\*?\s?(.*)$/.exec(line))) return m[1].replace(/\s*\*\/\s*$/, '');
  if (/^\s*\*\/\s*$/.test(line)) return '';
  if ((m = /^\s*\*\s?(.*)$/.exec(line))) return m[1].replace(/\s*\*\/\s*$/, '');
  return null;
};

const CARD =
  '(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|' +
  'fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|' +
  'ninety)';
const LEDGERS =
  'ALLOWED|CROSS_ALLOWED|PRESENCE|PRESENCE_ALLOWED|PRESENCE_BARREN|DEFECTS|THREW|UNNAMED|' +
  'KNOWN_UNNAMED|SELECT_OPTIONAL|POOL';

/**
 * The closed set, each entry a shape one of the removed sentences was written in.
 *
 * Widening any of these is how the check turns into the broad formulation that was measured and
 * rejected above. Narrowing one to quieten a hit is worse: the hit is the finding.
 */
const IDIOMS = [
  ['a span', new RegExp(`\\b${CARD} to ${CARD}\\b`, 'i')],
  ['a ratio', new RegExp(`\\b${CARD} of ${CARD}\\b`, 'i')],
  ['an unchanged quantity', new RegExp(`\\bat the same (?:count|${CARD})\\b`, 'i')],
  ['a rejection count', new RegExp(`\\bfrom ${CARD} rejections\\b`, 'i')],
  ['a level', new RegExp(`\\bare at ${CARD}\\b`, 'i')],
  ['a per-mode count', new RegExp(`\\b${CARD} in all three modes\\b`, 'i')],
  ['a ledger size', new RegExp(`\\b${CARD} (?:${LEDGERS}) entr(?:y|ies)\\b`)],
];

const file = process.argv[2];
const lines = readFileSync(file, 'utf8').split('\n');
const blocks = [];
let cur = null;
for (let i = 0; i < lines.length; i++) {
  const p = payload(lines[i]);
  if (p === null || p.trim() === '') {
    cur = null;
    continue;
  }
  if (!cur) blocks.push((cur = { start: i + 1, end: i + 1, text: p.trim() }));
  else {
    cur.end = i + 1;
    cur.text += ` ${p.trim()}`;
  }
}

const hits = [];
for (const b of blocks) {
  const matched = IDIOMS.map(([name, re]) => [name, re.exec(b.text)]).filter(([, m]) => m);
  if (matched.length) hits.push({ b, matched });
}

const rel = file.replace(/^.*\/(scripts\/.*)$/, '$1');
if (!hits.length) {
  // Not a pass. The check cannot tell a clean file from a pattern that has stopped matching, and
  // this line says which claim is being made.
  console.log(`    no comment block in ${rel} matches the idioms a restated count is written in`);
} else {
  console.log(
    `    WARN: ${hits.length} comment block(s) in ${rel} of ${blocks.length} state a quantity in ` +
      'the idiom a restated one is written in. Not a gate, and not all of them are wrong: read'
  );
  console.log(
    '          each one and check it against the declaration or printed line that holds the same'
  );
  console.log('          quantity, then delete the number or leave a verdict in the task report.');
  for (const { b, matched } of hits) {
    console.log(`      ${rel}:${b.start}-${b.end}  [${matched.map(([n]) => n).join(', ')}]`);
    // The whole block, not a window around the match. Two blocks were cleared as false positives
    // by reading a 55-character excerpt while a stale count sat elsewhere in the same comment:
    // "The other ten are new" three words outside one window, and a byte figure the run had
    // moved on from outside the other. The idiom is what finds a block; it is not what makes the
    // block wrong, so an excerpt is the wrong unit to adjudicate on.
    for (const line of b.text.match(/.{1,96}(?:\s|$)/g) ?? [b.text]) {
      console.log(`          ${line.trimEnd()}`);
    }
  }
}
PROSE_COUNTS
# Never a gate, including when node itself fails: a warning that can abort the run is a gate with
# an undeclared failure mode, and this one runs before anything has been built.
node "$WORK/prose-counts.mjs" "$ROOT/scripts/verify-packed.sh" || true

echo "==> building"
# A file in every dist that no build produces, checked for afterwards.
#
# `files: ["dist"]` packs whatever is in the directory, and tsup does not clean it unless told to,
# so anything a previous build left behind is published. That is not theoretical: @drzl/cli's dist
# held 46 files totalling 950 KB where a clean build produces 16 and 417 KB, 30 stale
# content-hashed chunks from three different dates, and validation-core held two full generations
# of prettier's parser chunks. CI checks out fresh and never sees it; a maintainer running
# `pnpm release` locally publishes it. The size ceiling below cannot catch this, because stale
# chunks are small.
#
# A canary rather than a file-list comparison, because it costs one build instead of two and
# fails for exactly one reason: this package's build does not clean its output.
CANARY='stale-canary.js'
for dir in "$ROOT"/packages/*/; do
  mkdir -p "$dir/dist"
  echo '// seeded by verify-packed; a build that cleans its output removes this' > "$dir/dist/$CANARY"
done

# `build:packages`, not `build`: the workspace also contains the docs site, whose vitepress
# build is slow and cannot affect a tarball. This is the same filtered, topologically sorted
# build the release workflow runs, so what gets packed here is what gets packed there.
(cd "$ROOT" && pnpm build:packages >/dev/null)

stale=""
for dir in "$ROOT"/packages/*/; do
  [ -e "$dir/dist/$CANARY" ] && stale="$stale $(basename "$dir")"
  rm -f "$dir/dist/$CANARY"
done
if [ -n "$stale" ]; then
  echo "FAIL: these builds do not clean their output dir, so stale files from a previous" >&2
  echo "      build get published:$stale" >&2
  echo "      Add --clean to the tsup invocation in each package's build script." >&2
  exit 1
fi
echo "    every build cleans its output dir"

echo "==> packing publishable packages"
count=0
for dir in "$ROOT"/packages/*/; do
  name="$(node -e "
    const p = require('$dir/package.json');
    process.stdout.write(p.private ? '' : p.name);
  " 2>/dev/null || true)"
  [ -z "$name" ] && continue
  (cd "$dir" && pnpm pack --pack-destination "$TARS" >/dev/null)
  count=$((count + 1))
done
echo "    packed $count package(s)"
if [ "$count" -eq 0 ]; then
  echo "FAIL: nothing was packed. A build that emits nothing must not pass silently." >&2
  exit 1
fi

# What each package weighs on the wire, which is the only number a user pays.
#
# Three of these shipped at 2.8 MB packed and 11 MB unpacked, because `await import('prettier')`
# is a specifier tsup can resolve and esbuild inlined the whole formatter behind it. Installing
# @drzl/cli pulled in roughly 32 MB of duplicated prettier parsers. Nothing in the workspace could
# see it: the source was right, the tests passed, and only the artefact was wrong.
#
# The ceiling is per tarball and deliberately far above the real figures, which are tens of
# kilobytes. It is a tripwire for a dependency that got bundled, not a byte budget. Raising it is
# not how you fix a build that started inlining one.
TARBALL_CEILING=1000000
size_over=0
for tgz in "$TARS"/*.tgz; do
  bytes=$(wc -c < "$tgz")
  if [ "$bytes" -gt "$TARBALL_CEILING" ]; then
    echo "FAIL: $(basename "$tgz") is $bytes bytes packed, over the ${TARBALL_CEILING} ceiling." >&2
    echo "      Something is being bundled that should be external." >&2
    size_over=1
  fi
done
[ "$size_over" = 0 ] || exit 1

# ---------------------------------------------------------------------------------------------
# What is inside each tarball, against what its own manifest promises is there.
#
# `files` is a list of directories, not of entry points, so the two are only ever connected by
# hand. A `types` field naming a file the build never emitted, or an `exports` subpath pointing
# somewhere outside `dist`, both pack cleanly and fail only later: in a consumer's editor, which
# just goes quiet, or at their first import. Nothing in the workspace can see either, because in a
# working tree every one of those paths has `src` sitting next to `dist` to fall back on.
#
# The manifest is read out of the tarball rather than off disk, because the tarball's copy is the
# one npm serves and it is not the same file: pnpm rewrites `workspace:` ranges into it on the way
# past.
# ---------------------------------------------------------------------------------------------
echo "==> what each tarball contains"
cat > "$WORK/inspect-tarballs.mjs" <<'INSPECT'
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
INSPECT
if ! node "$WORK/inspect-tarballs.mjs" "$TARS"; then
  exit 1
fi

echo "==> installing them into an empty project"
# A real foreign key, because the oRPC generator derives relation endpoints from one and a
# schema without any would exercise none of that path.
cat > "$APP/src/db/schema.ts" <<'SCHEMA'
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  email: text('email').notNull(),
  balance: real('balance'),
});

export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  authorId: integer('author_id').references(() => users.id),
});
SCHEMA

# Every kind in the list below, not just zod. Covering one of five is how the published oRPC
# generator came to emit routers that fail `tsc --strict` while this guard stayed green.
#
# "Every generator kind" is what this used to say, and it is not true of the kinds the CLI takes.
# `typebox` and `json-schema` are both in `GeneratorSchema.kind` (packages/cli/src/config.ts) and
# neither is here. Their emitted output is generated by the parity stage further down instead, and
# compiled there under `module nodenext` alone, so neither of them reaches the bundler and node16
# legs of the moduleResolution sweep this config feeds. That is a real gap in this stage's reach,
# named rather than covered over by the word "every".
cat > "$APP/drzl.config.ts" <<'CONFIG'
export default {
  schema: './src/db/schema.ts',
  outDir: './src/generated/api',
  generators: [
    { kind: 'zod', path: './src/generated/zod' },
    { kind: 'valibot', path: './src/generated/valibot' },
    { kind: 'arktype', path: './src/generated/arktype' },
    { kind: 'service', path: './src/generated/services' },
    // template-orpc-service on purpose, not the default. The default template imports nothing
    // that DRZL generated, so running only that one exercised no cross-module specifier and
    // missed the service import being emitted bare and extensionless.
    { kind: 'orpc', template: '@drzl/template-orpc-service', includeRelations: true },
  ],
};
CONFIG

cd "$APP"
npm init -y >/dev/null
# ESM, because arktype and @orpc/server ship ESM only. Under `moduleResolution: node16` a
# CommonJS consumer genuinely cannot import them, and tsc says so with TS1479. That is correct
# behaviour rather than a defect in generated code, so the fixture has to be the kind of project
# these packages can actually be used from.
node -e "
  const fs = require('fs');
  const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  p.type = 'module';
  fs.writeFileSync('package.json', JSON.stringify(p, null, 2));
"
# npm rather than pnpm on purpose: a consumer is unlikely to share this repo's package manager,
# and npm's flat layout is the harsher test of whether `dependencies` are actually declared.
# valibot, arktype and @orpc/server are peers of the generators, so the generated tree cannot
# typecheck without them present, exactly as in a consumer's project.
#
# prettier is here because it is now an *optional* peer of @drzl/validation-core rather than
# something bundled into it, and npm does not install optional peers. Naming it is what a
# consumer who wants formatted output does, and it makes this run cover the peer resolving from
# a real install. The stage further down removes it again to cover the other case.
npm install --no-audit --no-fund --loglevel=error \
  "$TARS"/*.tgz drizzle-orm zod valibot arktype @orpc/server typescript tsx prettier >/dev/null

if [ ! -e node_modules/.bin/drzl ]; then
  echo "FAIL: the drzl bin did not resolve after a real install." >&2
  exit 1
fi

echo "==> running the README's headline command"
npx drzl generate >/dev/null

BARREL="src/generated/zod/index.ts"
[ -f "$BARREL" ] || { echo "FAIL: no barrel emitted at $BARREL" >&2; exit 1; }
for f in src/generated/zod/users.zod.ts src/generated/zod/posts.zod.ts; do
  [ -f "$f" ] || { echo "FAIL: expected emitted file missing: $f" >&2; exit 1; }
done

# One representative file per generator kind, so a kind that silently emitted nothing is caught
# here rather than by the typecheck passing over an empty directory.
for f in src/generated/valibot/index.ts src/generated/arktype/index.ts \
         src/generated/services/postService.ts src/generated/api/posts.ts; do
  [ -f "$f" ] || { echo "FAIL: expected emitted file missing: $f" >&2; exit 1; }
done

# The relation endpoint the foreign key above should have produced.
grep -q 'listByAuthorId' src/generated/api/posts.ts || {
  echo "FAIL: includeRelations did not emit a lookup for the authorId foreign key." >&2
  exit 1
}

# The generated routers have to import each other without deadlocking on module initialisation.
# Cross-table lookups reference another router's schema, which is circular the moment both
# directions exist, and an eager reference throws "Cannot access X before initialization" at
# import time while typechecking perfectly. Only loading the graph catches it.
echo "==> loading the generated router graph"
cat > load-probe.mjs <<'PROBE'
const { router } = await import('./src/generated/api/index.ts');
const names = Object.keys(router);
if (!names.length) {
  console.error('FAIL: the generated router barrel exports nothing.');
  process.exit(1);
}
console.log('    loaded ' + names.length + ' routers: ' + names.sort().join(', '));
PROBE
if ! npx tsx load-probe.mjs; then
  echo "FAIL: the generated routers could not be imported. A circular reference between them" >&2
  echo "      is evaluated at module scope rather than deferred." >&2
  exit 1
fi
rm -f load-probe.mjs

# Exit code alone is not enough: a generator that writes an empty barrel still exits 0.
#
# Double quotes deliberately, and they are load-bearing twice over. The generator emits single
# quotes; the double ones are prettier's defaults rewriting them, so this line is also the only
# end-to-end proof in the whole run that formatting actually happened through a real install of
# the optional peer. Nothing else here would notice formatting silently stopping, which is not
# hypothetical: the CJS bundle formatted nothing at all for as long as it existed and every gate
# stayed green. The single-quoted form is asserted further down, with prettier hidden.
grep -q 'export \* from "./users.zod.js";' "$BARREL" || {
  echo "FAIL: the barrel is not what a consumer with prettier installed should get. Either the" >&2
  echo "      .js specifier is missing, so the output will not resolve under moduleResolution" >&2
  echo "      node16 or nodenext, or the optional peer stopped being used and nothing was" >&2
  echo "      formatted. Barrel was:" >&2
  cat "$BARREL" >&2
  exit 1
}

echo "==> typechecking the emitted tree under every supported moduleResolution"
# TypeScript 7 removed node10, leaving these three. `.js` specifiers are the only form that
# resolves under all of them without a compiler flag, which is why the generator emits them.
for mr in bundler node16 nodenext; do
  mod="$mr"
  [ "$mr" = "bundler" ] && mod="esnext"
  cat > tsconfig.probe.json <<EOF
{
  "compilerOptions": {
    "strict": true, "noEmit": true, "target": "es2022",
    "module": "$mod", "moduleResolution": "$mr", "skipLibCheck": true
  },
  "include": ["src/generated/**/*.ts", "src/db/**/*.ts"]
}
EOF
  if ! npx tsc -p tsconfig.probe.json; then
    echo "FAIL: emitted output does not typecheck under moduleResolution=$mr" >&2
    exit 1
  fi
  echo "    $mr ok"
done


# ---------------------------------------------------------------------------------------------
# Every dialect, not just SQLite.
#
# The analyzer claims sqlite, postgres, mysql, singlestore and gel, and this guard exercised one
# of them. Each dialect stores its foreign keys under a differently named symbol and has its own
# column classes, so a change that works for SQLite can silently produce nothing for Postgres.
# ---------------------------------------------------------------------------------------------
echo "==> generating from every dialect"
for dialect in pg mysql; do
  mkdir -p "src/dia-$dialect"
  case "$dialect" in
    pg)
      cat > "src/dia-$dialect/schema.ts" <<'SCHEMA'
import { pgTable, integer, serial, text } from 'drizzle-orm/pg-core';
export const authors = pgTable('authors', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
});
export const books = pgTable('books', {
  isbn: text('isbn').primaryKey(),
  authorId: integer('author_id').references(() => authors.id),
});
SCHEMA
      ;;
    mysql)
      cat > "src/dia-$dialect/schema.ts" <<'SCHEMA'
import { mysqlTable, int, varchar } from 'drizzle-orm/mysql-core';
export const authors = mysqlTable('authors', {
  id: int('id').primaryKey().autoincrement(),
  name: varchar('name', { length: 120 }).notNull(),
});
export const books = mysqlTable('books', {
  isbn: varchar('isbn', { length: 20 }).primaryKey(),
  authorId: int('author_id').references(() => authors.id),
});
SCHEMA
      ;;
  esac

  cat > drzl.config.ts <<CONFIG
export default {
  schema: './src/dia-$dialect/schema.ts',
  outDir: './src/dia-$dialect/api',
  generators: [
    { kind: 'zod', path: './src/dia-$dialect/zod' },
    { kind: 'orpc', includeRelations: true },
  ],
};
CONFIG
  npx drzl generate >/dev/null

  # A natural primary key must survive into the insert schema, and a foreign key must produce a
  # lookup. Both were broken for every dialect at some point without this guard noticing.
  grep -q 'isbn' "src/dia-$dialect/zod/books.zod.ts" || {
    echo "FAIL [$dialect]: the natural primary key 'isbn' is missing from the emitted schemas." >&2
    exit 1
  }
  grep -q 'listByAuthorId' "src/dia-$dialect/api/books.ts" || {
    echo "FAIL [$dialect]: no relation lookup emitted for the authorId foreign key." >&2
    exit 1
  }

  cat > "tsconfig.$dialect.json" <<EOF
{
  "compilerOptions": {
    "strict": true, "noEmit": true, "target": "es2022",
    "module": "nodenext", "moduleResolution": "nodenext", "skipLibCheck": true
  },
  "include": ["src/dia-$dialect/**/*.ts"]
}
EOF
  if ! npx tsc -p "tsconfig.$dialect.json"; then
    echo "FAIL [$dialect]: emitted output does not typecheck." >&2
    exit 1
  fi
  echo "    $dialect ok"
done

# ---------------------------------------------------------------------------------------------
# The consumer who has no formatter at all.
#
# prettier used to be bundled into three packages, 11 MB each, so formatting could not fail to be
# available. It is an optional peer now, which makes "no formatter installed" an ordinary and
# supported state rather than a broken install. The whole run happens after every file has been
# rendered, so an unhandled rejection there would lose a completed generation at the last step.
#
# Hidden rather than uninstalled, because npm would take the tarballs with it.
# ---------------------------------------------------------------------------------------------
echo "==> generating with no formatter installed"
mv node_modules/prettier node_modules/.prettier-hidden
cat > drzl.config.ts <<'CONFIG'
export default {
  schema: './src/db/schema.ts',
  outDir: './src/unformatted/api',
  generators: [
    { kind: 'zod', path: './src/unformatted/zod' },
    { kind: 'service', path: './src/unformatted/services' },
    { kind: 'orpc' },
  ],
};
CONFIG
if ! npx drzl generate >/dev/null; then
  mv node_modules/.prettier-hidden node_modules/prettier
  echo "FAIL: drzl generate does not survive prettier being absent. It is an optional peer," >&2
  echo "      so this is a normal install, and the failure would come after every file was" >&2
  echo "      already rendered." >&2
  exit 1
fi
mv node_modules/.prettier-hidden node_modules/prettier

# Unformatted has to still mean complete and valid. Single quotes are what the generator emits
# before a formatter sees it, so this also confirms nothing formatted the file behind our backs
# and made the check vacuous.
grep -q "export \* from './users.zod.js';" src/unformatted/zod/index.ts || {
  echo "FAIL: the unformatted barrel is not what the generator emits. Was:" >&2
  cat src/unformatted/zod/index.ts >&2
  exit 1
}
cat > tsconfig.unformatted.json <<'EOF'
{
  "compilerOptions": {
    "strict": true, "noEmit": true, "target": "es2022",
    "module": "nodenext", "moduleResolution": "nodenext", "skipLibCheck": true
  },
  "include": ["src/unformatted/**/*.ts", "src/db/**/*.ts"]
}
EOF
if ! npx tsc -p tsconfig.unformatted.json; then
  echo "FAIL: output emitted without a formatter does not typecheck. Formatting is cosmetic," >&2
  echo "      so anything broken here was broken before prettier tidied it." >&2
  exit 1
fi
echo "    unformatted output is complete and typechecks"

# ---------------------------------------------------------------------------------------------
# Every config the documentation tells a reader to write.
#
# Two rounds of defects were "the docs show a config that does not work", both found by hand:
# the getting-started guide emitted three imports resolving to nothing, and validation-mix.md
# had the same shape. Anything a reader can copy is run here instead.
# ---------------------------------------------------------------------------------------------
echo "==> running every documented config"
node "$ROOT/scripts/extract-doc-configs.mjs" "$ROOT/docs" > /tmp/doc-configs.json
doc_total="$(node -e "process.stdout.write(String(require('/tmp/doc-configs.json').length))")"
[ "$doc_total" -gt 0 ] || { echo "FAIL: no runnable configs found in docs; the extractor is broken." >&2; exit 1; }

doc_failed=0
for i in $(seq 0 $((doc_total - 1))); do
  label="$(node -e "const c=require('/tmp/doc-configs.json')[$i]; process.stdout.write(c.file+':'+c.line)")"
  schema="$(node -e "process.stdout.write(require('/tmp/doc-configs.json')[$i].schema)")"
  outdir="$(node -e "process.stdout.write(require('/tmp/doc-configs.json')[$i].outDir)")"

  rm -rf docs-probe && mkdir -p "docs-probe/$(dirname "$schema")" docs-probe/src/db
  # A schema exercising the cases these configs care about: a generated key, a natural key, a
  # nullable column and a foreign key.
  cat > "docs-probe/$schema" <<'SCHEMA'
import { pgTable, integer, serial, text } from 'drizzle-orm/pg-core';
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
  nickname: text('nickname'),
});
export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull(),
  authorId: integer('author_id').references(() => users.id),
});
SCHEMA
  # Some configs point `dbImportPath` at a connection module. That is the reader's own file, so
  # the fixture supplies one rather than the config being wrong for naming it.
  echo 'export const db = {} as any;' > docs-probe/src/db/connection.ts

  node -e "
    const fs = require('fs');
    const c = require('/tmp/doc-configs.json')[$i];
    let body = c.config;
    // Docs elide the import on short snippets. That is a snippet convention rather than a
    // defect in the configuration, and the point here is whether the config works, so it is
    // supplied when missing.
    if (body.includes('defineConfig') && !/from '@drzl\/cli\/config'/.test(body)) {
      body = \"import { defineConfig } from '@drzl/cli/config';\n\" + body;
    }
    fs.writeFileSync('docs-probe/drzl.config.ts', body);
  "
  # A custom template the docs reference by path would not exist here; that is a documentation
  # example about authoring one, not a config to run.
  if grep -qE "template:\s*'\./" docs-probe/drzl.config.ts; then
    echo "    $label  skipped (references a local template file)"
    continue
  fi

  if ! (cd docs-probe && npx drzl generate >/dev/null 2>&1); then
    echo "    $label  GENERATE FAILED"
    doc_failed=$((doc_failed + 1))
    continue
  fi

  cat > docs-probe/tsconfig.json <<EOF
{
  "compilerOptions": {
    "strict": true, "noEmit": true, "target": "es2022",
    "module": "nodenext", "moduleResolution": "nodenext", "skipLibCheck": true
  },
  "include": ["**/*.ts"]
}
EOF
  if (cd docs-probe && npx tsc -p tsconfig.json > /tmp/doc-tsc.log 2>&1); then
    echo "    $label  ok"
  else
    echo "    $label  DOES NOT TYPECHECK"
    sed 's/^/        /' /tmp/doc-tsc.log | head -5
    doc_failed=$((doc_failed + 1))
  fi
done
rm -rf docs-probe

if [ "$doc_failed" -ne 0 ]; then
  echo "FAIL: $doc_failed of $doc_total documented configs do not work as written." >&2
  echo "      A config a reader can copy has to produce code that compiles." >&2
  exit 1
fi
echo "    all $doc_total documented configs generate and typecheck"

echo "==> differential parity against the official drizzle-orm validators"
# What DRZL claims is that every difference between its generated schemas and the first-party
# `drizzle-orm/{zod,valibot,arktype,typebox}` modules is known and named. Not that it is at least as
# strict: this comment said that for a long time and it was never true, since Postgres takes three
# emoji into a `char(3)` and a Uint8Array into a `bytea` and official refuses both. Where the two
# disagree the database decides which is right, and the answer goes in ALLOWED with its
# measurement.
#
# That is a claim about behaviour, so it is measured by behaviour: generate for the same table,
# then push the same pool of values through both schemas column by column and compare the verdicts.
# Reading the emitted source cannot do this, because a schema that parses and a schema that
# validates look identical as text.
#
# Three dialects and all three modes, because the gaps cluster in the corners: MySQL owns the
# narrow integer widths and the text/blob caps, SQLite owns the blob modes, and insert and update
# own optionality and the generated-column rules.
#
# It runs here, against the packed tarballs, rather than as a unit test, because it needs
# drizzle-orm v1 and the workspace is still on 0.4x. Installing v1 into this throwaway tree keeps
# it out of the repo's own dependency graph.
PARITY="$WORK/parity"
mkdir -p "$PARITY/src"
cd "$PARITY"
echo '{ "name": "parity", "private": true, "type": "module" }' > package.json

cat > src/schema.ts <<'PARITY_PG'
import {
  pgTable, pgEnum, text, varchar, char, uuid, integer, smallint, bigint, serial,
  boolean, real, doublePrecision, numeric, decimal, json, jsonb, date, timestamp,
  time, interval, bytea, inet, cidr, macaddr, point, line, geometry, bit, vector,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const moodEnum = pgEnum('mood', ['happy', 'sad', 'neutral']);

export const matrix = pgTable('matrix', {
  // --- text family ---
  c_text: text().notNull(),
  c_varchar: varchar({ length: 255 }).notNull(),
  c_char: char({ length: 4 }).notNull(),
  c_uuid: uuid().notNull(),
  c_text_enum: text({ enum: ['a', 'b', 'c'] }).notNull(),
  c_varchar_enum: varchar({ length: 10, enum: ['x', 'y'] }).notNull(),

  // --- numeric family ---
  c_int: integer().notNull(),
  c_smallint: smallint().notNull(),
  c_bigint_n: bigint({ mode: 'number' }).notNull(),
  c_bigint_b: bigint({ mode: 'bigint' }).notNull(),
  c_serial: serial().notNull(),
  c_real: real().notNull(),
  c_double: doublePrecision().notNull(),
  c_numeric: numeric({ precision: 10, scale: 2 }).notNull(),
  c_numeric_n: numeric({ precision: 10, scale: 2, mode: 'number' }).notNull(),
  c_decimal: decimal().notNull(),

  // --- boolean ---
  c_bool: boolean().notNull(),

  // --- enum ---
  c_enum: moodEnum().notNull(),

  // --- json ---
  c_json: json().notNull(),
  c_jsonb: jsonb().notNull(),
  c_jsonb_typed: jsonb().$type<{ a: string }>().notNull(),

  // --- temporal ---
  c_date_d: date({ mode: 'date' }).notNull(),
  c_date_s: date({ mode: 'string' }).notNull(),
  c_ts_d: timestamp({ mode: 'date' }).notNull(),
  c_ts_s: timestamp({ mode: 'string' }).notNull(),
  c_time: time().notNull(),
  c_interval: interval().notNull(),

  // --- arrays ---
  c_text_arr: text().array().notNull(),
  // A capped element inside an array. Without one, dropping the element's cap looked identical to
  // keeping it: every array in this fixture held an uncapped type.
  c_varchar_arr: varchar({ length: 10 }).array().notNull(),
  c_int_arr: integer().array().notNull(),
  c_enum_arr: moodEnum().array().notNull(),

  // --- binary / network / geometry / vector ---
  // Deleted from the 0.4x fixture by a line match on this column's name. No comment near it may
  // name the type without that prefix: such a line survives the delete and fails the check.
  c_bytea: bytea().notNull(),
  c_inet: inet().notNull(),
  c_cidr: cidr().notNull(),
  c_macaddr: macaddr().notNull(),
  c_point: point().notNull(),
  c_line: line().notNull(),
  c_geometry: geometry().notNull(),
  c_bit: bit({ dimensions: 3 }).notNull(),
  c_vector: vector({ dimensions: 3 }).notNull(),
});

// Literal column defaults, which `applyDefaults` claims to reproduce in the insert schema. The
// falsy ones are the point: 0, false and '' are what a truthiness test drops, and a dropped
// default is invisible until a row arrives with a different value than the database would have
// written.
export const defaulted = pgTable('defaulted', {
  d_int: integer().default(42),
  d_zero: integer().default(0),
  d_neg: integer().default(-1),
  d_text: text().default('hello'),
  d_empty: text().default(''),
  d_bool_true: boolean().default(true),
  d_bool_false: boolean().default(false),
  d_real: doublePrecision().default(1.5),
  d_enum: moodEnum().default('sad'),
});

/**
 * Nullable arrays, which every array in `matrix` being `notNull` meant nothing had ever emitted.
 *
 * A nullable array renders differently enough to break code that assumed `T[]`: the arktype
 * generator recovered an array's element by stripping a trailing `[]`, and `(T[] | null)` has
 * none, so the whole union became the element and `.array()` wrapped it. That output refused
 * `null` and `['ab']`, accepted `[['ab']]`, and for the bigint one did not compile at all. A
 * capped or bounded element is what makes the shape reachable: an unconstrained column emits a
 * plain DSL string and never goes near that code.
 *
 * Its own table rather than two more columns on `matrix`, because the arktype output for a
 * 40-column table of narrowed fields is already at the edge of TS2589, and two more tipped it
 * over. That defect is reported; provoking it here would only hide these columns behind it.
 */
export const arrays = pgTable('arrays', {
  a_varchar_arr_null: varchar({ length: 10 }).array(),
  a_bigint_arr_null: bigint({ mode: 'bigint' }).array(),
});

/**
 * The nullable path, which is what most real schemas are made of and which no differential
 * comparison had ever looked at: every column of `matrix` is `notNull`, so neither pass compared
 * a single nullable column on any of the three dialects. The zero is the whole claim, and the
 * widths this sentence used to write beside it were the v1 pass's alone: the 0.4x pass deletes
 * from this fixture and from the MySQL one every column whose type 0.4x has no export for, so it
 * is narrower on two of the three dialects. Stated as a zero on both passes now, which is the
 * part that is true of both. (No type name here: a comment in this file naming one that the 0.4x
 * stage strips survives the strip and fails its check, which is what happened to this sentence.)
 *
 * Every generator emits a different construction for a nullable column, and each of them is a
 * place a constraint can be lost: zod appends `.nullable()` after the refinement, valibot wraps
 * in `v.nullable`, arktype builds a `(T | null)` union whose narrow has to guard the null itself,
 * and TypeBox emits `Type.Union([T, Type.Null()])`. None of those had been compared with the
 * first-party module for any column.
 *
 * Its own table rather than more columns on `matrix`, for the reason `arrays` above has one: the
 * arktype output for a 40-column table of narrowed fields is already at the edge of TS2589.
 *
 * The combinations are chosen rather than sampled. A default and a CHECK, because both attach to
 * the column and both have to survive being wrapped; an array and an enum, because both are
 * rebuilt rather than wrapped; and one column of each `shape` the analyzer distinguishes. Four of
 * the five are here, which is `json`, `tuple`, `numberVector` and, on v1 alone, `buffer`; the
 * SQLite table carries `buffer` on both majors and carries the fifth, `custom`.
 *
 * `n_geometry` and `n_bit` are the Postgres classes the 0.4x class-name path still cannot name,
 * and `n_vector` was a third until the pgvector arms landed. That is not incidental to the nullable
 * path: an unnamed column emits an unknown, and a *nullable* unknown is the one construction whose
 * key TypeBox lets go missing. The `notNull` twins sit in `matrix` and do not have that property.
 * `n_vector` stays in the fixture, because a column that is named now is still worth comparing.
 */
export const nullable = pgTable('nullable', {
  n_text: text(),
  n_varchar: varchar({ length: 10 }),
  n_int: integer(),
  n_real: real(),
  n_bigint: bigint({ mode: 'bigint' }),
  n_bool: boolean(),
  n_enum: moodEnum(),
  n_json: jsonb(),
  n_ts: timestamp({ mode: 'date' }),
  n_point: point(),
  n_geometry: geometry(),
  n_bit: bit({ dimensions: 3 }),
  n_vector: vector({ dimensions: 3 }),
  // Named for c_bytea so the 0.4x stage's edit takes both, on both of these lines.
  c_bytea_null: bytea(),
  n_text_arr: text().array(),
  n_enum_arr: moodEnum().array(),
  n_default: integer().default(7),
  n_check: integer(),
}, (t) => [check('n_check_c', sql`${t.n_check} BETWEEN 18 AND 100`)]);

// Every CHECK form the shared parser claims to understand, so Postgres can be asked whether the
// emitted constraint means the same thing. CHECK support is DRZL's main advantage over the
// first-party validators and until now it was verified only against its own emitted strings.
// Every column is nullable, so that each probe can insert one column and leave the rest out.
//
// This note sat above `defaulted` rather than above the table it describes, and it claimed the
// columns were "nullable on purpose, like the matrix table" when every column of `matrix` is
// notNull. Both halves are gone.
export const checked = pgTable('checked', {
  k_min: integer(),
  k_max: integer(),
  k_lo: integer(),
  k_hi: integer(),
  k_between: integer(),
  k_eq: integer(),
  k_in_s: text(),
  k_in_n: integer(),
  k_len: text(),
  k_len_max: text(),
  k_card: text().array(),
  k_pair_a: integer(),
  k_pair_b: integer(),
}, (t) => [
  check('k_min_c', sql`${t.k_min} >= 18`),
  check('k_max_c', sql`${t.k_max} <= 100`),
  check('k_lo_c', sql`${t.k_lo} > 0`),
  check('k_hi_c', sql`${t.k_hi} < 10`),
  check('k_between_c', sql`${t.k_between} BETWEEN 5 AND 15`),
  check('k_eq_c', sql`${t.k_eq} = 7`),
  check('k_in_s_c', sql`${t.k_in_s} IN ('a', 'b', 'c')`),
  check('k_in_n_c', sql`${t.k_in_n} IN (1, 2, 3)`),
  check('k_len_c', sql`length(${t.k_len}) >= 3`),
  check('k_len_max_c', sql`char_length(${t.k_len_max}) <= 5`),
  check('k_card_c', sql`cardinality(${t.k_card}) >= 2`),
  check('k_pair_c', sql`${t.k_pair_a} < ${t.k_pair_b}`),
]);
PARITY_PG
cat > src/schema-mysql.ts <<'PARITY_MYSQL'
import {
  mysqlTable, mysqlEnum, text, varchar, char, int, tinyint, smallint, mediumint,
  bigint, serial, boolean, real, double, float, decimal, json, date, datetime,
  timestamp, time, year, binary, varbinary, blob, tinytext, mediumtext, longtext,
  check,
} from 'drizzle-orm/mysql-core';
import { sql } from 'drizzle-orm';

export const matrix = mysqlTable('matrix', {
  m_text: text().notNull(),
  m_tinytext: tinytext().notNull(),
  m_mediumtext: mediumtext().notNull(),
  m_longtext: longtext().notNull(),
  m_varchar: varchar({ length: 255 }).notNull(),
  m_char: char({ length: 4 }).notNull(),
  m_enum: mysqlEnum(['a', 'b', 'c']).notNull(),

  m_tinyint: tinyint().notNull(),
  m_smallint: smallint().notNull(),
  m_mediumint: mediumint().notNull(),
  m_int: int().notNull(),
  m_bigint_n: bigint({ mode: 'number' }).notNull(),
  m_bigint_b: bigint({ mode: 'bigint' }).notNull(),
  m_serial: serial().notNull(),
  m_real: real().notNull(),
  m_double: double().notNull(),
  m_float: float().notNull(),
  m_decimal: decimal({ precision: 10, scale: 2 }).notNull(),

  m_bool: boolean().notNull(),
  m_json: json().notNull(),

  m_date: date({ mode: 'date' }).notNull(),
  m_date_s: date({ mode: 'string' }).notNull(),
  m_datetime: datetime({ mode: 'date' }).notNull(),
  m_ts: timestamp({ mode: 'date' }).notNull(),
  m_time: time().notNull(),
  m_year: year().notNull(),

  m_binary: binary({ length: 4 }).notNull(),
  m_varbinary: varbinary({ length: 16 }).notNull(),
  m_blob: blob().notNull(),
});

// The nullable path on MySQL. Same reasoning as the Postgres `nullable` table above, minus the
// arrays and the two Postgres-only shapes: MySQL has no array type, no point and no vector.
// `m_n_tinytext` is here because a byte cap and a NULL meet on it, which is the pairing the
// wrapping order can lose.
export const nullable = mysqlTable('nullable', {
  m_n_text: text(),
  m_n_varchar: varchar({ length: 10 }),
  m_n_tinytext: tinytext(),
  m_n_int: int(),
  m_n_float: float(),
  m_n_bigint: bigint({ mode: 'bigint' }),
  m_n_bool: boolean(),
  m_n_enum: mysqlEnum(['a', 'b', 'c']),
  m_n_json: json(),
  m_n_datetime: datetime({ mode: 'date' }),
  m_n_default: int().default(7),
  m_n_check: int(),
}, (t) => [check('m_n_check_c', sql`${t.m_n_check} BETWEEN 18 AND 100`)]);

// Every CHECK form the parser reads, in MySQL's spelling. No cardinality(): MySQL has no arrays.
export const checked = mysqlTable('checked', {
  k_min: int(),
  k_max: int(),
  k_lo: int(),
  k_between: int(),
  k_eq: int(),
  k_in_s: varchar({ length: 20 }),
  k_in_n: int(),
  k_len: varchar({ length: 50 }),
  k_pair_a: int(),
  k_pair_b: int(),
}, (t) => [
  check('k_min_c', sql`${t.k_min} >= 18`),
  check('k_max_c', sql`${t.k_max} <= 100`),
  check('k_lo_c', sql`${t.k_lo} > 0`),
  check('k_between_c', sql`${t.k_between} BETWEEN 5 AND 15`),
  check('k_eq_c', sql`${t.k_eq} = 7`),
  check('k_in_s_c', sql`${t.k_in_s} IN ('a', 'b', 'c')`),
  check('k_in_n_c', sql`${t.k_in_n} IN (1, 2, 3)`),
  check('k_len_c', sql`char_length(${t.k_len}) >= 3`),
  check('k_pair_c', sql`${t.k_pair_a} < ${t.k_pair_b}`),
]);

// The one question only a real MySQL settles: varchar(n) is n characters, and the TEXT family is
// a byte budget. Nothing in the schema says which, so it is measured rather than reasoned about.
export const limits = mysqlTable('limits', {
  l_varchar: varchar({ length: 10 }),
  l_tinytext: tinytext(),
  l_text: text(),
});
PARITY_MYSQL

cat > src/schema-sqlite.ts <<'PARITY_SQLITE'
import { sqliteTable, text, integer, real, numeric, blob, check, customType } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const matrix = sqliteTable('matrix', {
  s_text: text().notNull(),
  s_text_len: text({ length: 50 }).notNull(),
  s_text_enum: text({ enum: ['a', 'b'] }).notNull(),
  s_text_json: text({ mode: 'json' }).notNull(),

  s_int: integer().notNull(),
  s_int_bool: integer({ mode: 'boolean' }).notNull(),
  s_int_ts: integer({ mode: 'timestamp' }).notNull(),
  s_int_ts_ms: integer({ mode: 'timestamp_ms' }).notNull(),

  s_real: real().notNull(),
  s_numeric: numeric().notNull(),

  s_blob: blob().notNull(),
  s_blob_buf: blob({ mode: 'buffer' }).notNull(),
  s_blob_json: blob({ mode: 'json' }).notNull(),
  s_blob_bigint: blob({ mode: 'bigint' }).notNull(),
});

// The fifth `shape` the analyzer distinguishes, and the only one a fixture can carry on both
// majors: a customType's JavaScript type exists at compile time and nowhere else, so the analyzer
// names it `custom` and every generator emits an unknown for it. That is what makes it worth
// carrying, because an unknown is the construction the key-presence axis is about.
const opaque = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'text';
  },
});

// The nullable path on SQLite. `s_n_blob` is the buffer shape, `s_n_json` the json one and
// `s_n_custom` the custom one; SQLite has no array, no tuple and no vector, and its enum is a text
// column carrying a member list. The `nullable` table on Postgres carries the other two shapes,
// and it carries the buffer one on v1 alone, since `c_bytea_null` leaves the 0.4x fixture with
// `c_bytea`.
export const nullable = sqliteTable('nullable', {
  s_n_text: text(),
  s_n_text_enum: text({ enum: ['a', 'b'] }),
  s_n_json: text({ mode: 'json' }),
  s_n_int: integer(),
  s_n_bool: integer({ mode: 'boolean' }),
  s_n_ts: integer({ mode: 'timestamp' }),
  s_n_real: real(),
  s_n_blob: blob({ mode: 'buffer' }),
  s_n_ts_ms: integer({ mode: 'timestamp_ms' }),
  s_n_custom: opaque(),
  s_n_bigint: blob({ mode: 'bigint' }),
  s_n_default: integer().default(7),
  s_n_check: integer(),
}, (t) => [check('s_n_check_c', sql`${t.s_n_check} BETWEEN 18 AND 100`)]);

// The same CHECK forms as the Postgres fixture, minus the ones SQLite has no equivalent for:
// no arrays and so no `cardinality()`, and no `char_length()`. SQLite enforces a CHECK exactly
// as strictly as Postgres does, whatever its type affinity does elsewhere, so it is a real second
// authority for this subsystem rather than a permissive one.
export const checked = sqliteTable('checked', {
  k_min: integer(),
  k_max: integer(),
  k_lo: integer(),
  k_between: integer(),
  k_eq: integer(),
  k_in_s: text(),
  k_in_n: integer(),
  k_len: text(),
  k_pair_a: integer(),
  k_pair_b: integer(),
}, (t) => [
  check('k_min_c', sql`${t.k_min} >= 18`),
  check('k_max_c', sql`${t.k_max} <= 100`),
  check('k_lo_c', sql`${t.k_lo} > 0`),
  check('k_between_c', sql`${t.k_between} BETWEEN 5 AND 15`),
  check('k_eq_c', sql`${t.k_eq} = 7`),
  check('k_in_s_c', sql`${t.k_in_s} IN ('a', 'b', 'c')`),
  check('k_in_n_c', sql`${t.k_in_n} IN (1, 2, 3)`),
  check('k_len_c', sql`length(${t.k_len}) >= 3`),
  check('k_pair_c', sql`${t.k_pair_a} < ${t.k_pair_b}`),
]);
PARITY_SQLITE

# The value pool and the per-library accessors, in a file of their own because two trees push the
# same values now: this one, pinned to drizzle-orm v1, and the 0.4x tree near the end of this
# script. Copied rather than shared through a path, since the two trees have separate
# node_modules and one of them is CommonJS.
#
# Written once so the two passes cannot drift. A pool value added for one major has to be answered
# by the other, and the point of the 0.4x pass is that a difference between the two is a defect
# rather than a difference in what was asked.
cat > "$WORK/parity-pool.ts" <<'PARITY_POOL'
import * as v from 'valibot';
import { type } from 'arktype';
import { Value } from '@sinclair/typebox/value';

export const POOL: [string, unknown][] = [
  ['null', null], ['undefined', undefined], ['""', ''], ["'hello'", 'hello'],
  ['300-char', 'x'.repeat(300)], ['70k-char', 'x'.repeat(70000)], ['5-char', 'xxxxx'],
  // Astral-plane characters, where a code-point count and a UTF-16 `.length` disagree. Without
  // them the pool cannot see the difference, which is exactly how the `varchar(n)` bug survived:
  // Postgres counts characters for `varchar(n)`, so a 3-emoji string fits in a varchar(5) that
  // every library's `.max(5)` refuses.
  //
  // Both of these were once listed twice, under two comments saying that in two ways. See the
  // duplicate check below the pool.
  ['3 emoji', '\u{1F44D}\u{1F44D}\u{1F44D}'],
  ['5 emoji', '\u{1F44D}\u{1F44D}\u{1F44D}\u{1F44D}\u{1F44D}'],
  ["'not-a-uuid'", 'not-a-uuid'], ['uuid', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
  ["'zzz'", 'zzz'], ["'a'", 'a'], ["'happy'", 'happy'],
  // A member of the `varchar({ enum: ['x', 'y'] })` fixture column. Without it the pool held no
  // value that column accepts, so both sides rejected all of it and the comparison agreed while
  // measuring nothing. The vacuity check in each pass is what found it.
  ["'x'", 'x'],
  ['0', 0], ['1', 1], ['1.5', 1.5], ['-1', -1], ['200', 200], ['40000', 40000],
  ['9000000', 9000000], ['2147483648', 2147483648], ['9007199254740993', 9007199254740993],
  // What a Postgres `real` at full magnitude comes back as over the text protocol, and the reason
  // the two 4 byte float columns below no longer carry the same bound.
  //
  // Every other number here is orders of magnitude away from a float4 edge, so nothing in this
  // pool could tell a bound at the largest float32 from one at the largest double Postgres
  // accepts. Those are different numbers: Postgres takes 268435456 representable doubles past the
  // float32 and stores the float32 for all of them, and this is one of them. A select schema
  // bounded at the float32 refused the row a `real` column had just handed back, which is the
  // defect this branch exists to remove, and it survived a green run of both parity passes and
  // 1400 ground-truth probes because no probe was within 30 orders of magnitude of the edge.
  //
  // It separates the two dialects as well as the two bounds: `pg/c_real` accepts it and
  // `mysql/m_float` does not, because a real MySQL 8.4 refuses it with
  // `Out of range value for column`.
  ['3.4028235e38', 3.4028235e38],
  // 1900 and 2500 sit either side of MySQL's YEAR range and nothing sat inside it, so `m_year`
  // was the same vacuous agreement as the enum above: rejected by both, proving nothing.
  ['1900', 1900], ['2000', 2000], ['2500', 2500], ['NaN', NaN], ['Infinity', Infinity],
  ['1n', 1n], ['2n**70n', 2n ** 70n], ['true', true], ['false', false],
  ['Date', new Date('2020-01-01T00:00:00Z')], ["'2020-01-01'", '2020-01-01'],
  ["'2020-01-01T00:00:00Z'", '2020-01-01T00:00:00Z'], ["'12:00:00'", '12:00:00'],
  ["'25:99:99'", '25:99:99'],
  ['{}', {}], ["{a:'s'}", { a: 's' }], ['[]', []], ["['a']", ['a']], ['[1,2]', [1, 2]],
  ["['happy']", ['happy']], ['[1,2,3]', [1, 2, 3]],
  // An array holding a value past its element's cap. Every array probe above holds something
  // short, so dropping an element's constraint looked identical to keeping it: two generators
  // stopped capping array elements and nothing here could tell.
  ['["11-char"]', ['x'.repeat(11)]], ['["3 emoji"]', ['\u{1F44D}\u{1F44D}\u{1F44D}']],
  // Two strings that separate a byte budget from a UTF-16 count, and the rule for when one exists.
  //
  // A probe separates a cap of N bytes from a cap of N UTF-16 units only if it is over N bytes and
  // not over N units. UTF-8 spends at most 3 bytes per UTF-16 unit, exhaustively: 1 byte for
  // U+0000..U+007F and 2 for U+0080..U+07FF, both one unit; 3 for U+0800..U+FFFF, one unit; 4 for
  // U+10000..U+10FFFF, which is two units and so 2 bytes per unit; and a lone surrogate encodes as
  // U+FFFD, 3 bytes for one unit. Checked over every code point rather than argued: the maximum
  // ratio is 3. So a separating probe needs more than N/3 units, and it has to be built out of
  // three-byte characters to be anywhere near that.
  //
  // 100 emoji is 200 units and 400 bytes, which separates 255. 22000 CJK is 22000 units and 66000
  // bytes, which separates 65535. Those are `tinytext` and `text`. `mediumtext` needs 5592406
  // units, a 10.7 MiB string that is far too heavy to push through every column of every pairing,
  // and the byte-cap stage in the 0.4x tree measures that one on its own instead. `longtext` needs
  // 1431655766 units against a maximum JS string of 536870888 on this V8, measured by bisection,
  // so no probe for it can exist at all.
  //
  // The sentence this replaced said a string long enough to cross those caps in bytes crosses them
  // in units too. That was generalised from the emoji, where bytes are twice units, and it is false
  // for every three-byte BMP character. It left two filed fields under a green line.
  //
  // A real MySQL 8 on a utf8mb4 client settles which count is the database's: `tinytext` refuses
  // the emoji string ("Data too long"), and `varchar(255)` takes it and reports `length` 400 with
  // `char_length` 100. So TINYTEXT's 255 is bytes and VARCHAR's 255 is characters, in one table.
  ['100 emoji', '\u{1F44D}'.repeat(100)],
  ['22000 cjk', '\u4E00'.repeat(22000)],
  ['Buffer', Buffer.from('ab')], ['Uint8Array', new Uint8Array([1, 2])],
  ["'999.999.999.999'", '999.999.999.999'], ["'10.0.0.1'", '10.0.0.1'],
  ['{x:1,y:2}', { x: 1, y: 2 }], ["'12.5'", '12.5'], ["'0101'", '0101'], ["'010'", '010'],
  // Five integers placed around the `nullable` fixture's `CHECK (col BETWEEN 18 AND 100)`: one
  // inside, one on each boundary, and one just outside each end.
  //
  // Without them a CHECK waiver is a signature no wrong bound can move. Measured rather than
  // feared: with the pool as it was, moving the emitted bound on the Postgres zod `n_check` column
  // from `.gte(18).lte(100)` to `.gte(1000000000).lte(2000000000)`, a range that column could never
  // hold, left the whole script at exit 0 with zero findings. Every other numeric member of this
  // pool is outside both ranges, so DRZL's accept set over the pool did not move.
  //
  // They are appended rather than filed with the other numbers so that adding them reorders no
  // existing signature: every list here is built in pool order.
  ['17', 17], ['18', 18], ['50', 50], ['100', 100], ['101', 101],
];

/**
 * The pool holds each probe once, enforced rather than asserted.
 *
 * `3 emoji` and `5 emoji` were each listed twice, added under two comments that say the same thing
 * two ways, so `POOL.length` read 59 over 57 distinct values. Nothing failed and nothing could:
 * two entries carrying the same value get the same verdict from every schema on every side, so a
 * duplicate cannot produce a disagreement. What it does instead is inflate the counts a ledger
 * declares, each of which is the length of a list built by walking this pool, and put a label into
 * an `L:` or `T:` list twice, where that reads as two different probes.
 *
 * Measured by removing the two and re-running both passes against the declarations they had:
 * 168 declared-against-measured mismatches on the 0.4x pass over 17 entries, 102 on the v1 pass
 * over 12, every one of them a count two lower or a list with a repeat gone. No verdict moved and
 * no summary count moved on either pass.
 *
 * Both halves are checked. A duplicate label makes two entries indistinguishable in a printed
 * signature even when their values differ, and a duplicate value is the inflation above even when
 * the labels differ.
 */
const poolKey = (x: unknown): string => {
  if (typeof x === 'bigint') return `bigint:${x}`;
  if (typeof x === 'number') return `number:${Object.is(x, -0) ? '-0' : String(x)}`;
  if (typeof x === 'string') return `string:${x}`;
  if (x instanceof Date) return `date:${x.getTime()}`;
  if (ArrayBuffer.isView(x)) return `bytes:${Array.from(x as Uint8Array).join(',')}`;
  return `${typeof x}:${JSON.stringify(x) ?? String(x)}`;
};
const repeated = (keys: string[]): string[] => [
  ...new Set(keys.filter((k, i) => keys.indexOf(k) !== i)),
];
{
  const labels = repeated(POOL.map(([label]) => label));
  const values = repeated(POOL.map(([, value]) => poolKey(value)));
  if (labels.length > 0 || values.length > 0) {
    throw new Error(
      `POOL holds duplicate entries, so every count taken off it is inflated. ` +
        `Repeated label(s): ${labels.join(', ') || 'none'}. ` +
        `Repeated value(s): ${values.map((k) => k.slice(0, 40)).join(', ') || 'none'}.`,
    );
  }
}

export type Lib = { field: (s: any, k: string) => any; ok: (f: any, x: unknown) => boolean };

/**
 * How each library's schema is taken apart into one field per column, and checked.
 *
 * Both passes compare a column by extracting its field from each side and pushing the pool through
 * it, so anything a library keeps on the parent object rather than on the field is invisible here.
 * One such thing is known and it is TypeBox's optionality. Measured on official's 0.4x update
 * schema for `matrix`:
 *
 *   the property carries Symbol(TypeBox.Kind) and Symbol(TypeBox.Optional)
 *   Value.Check(objectSchema, {}) with the key omitted   true
 *   Value.Check(property, undefined)                     false
 *   deleting Symbol(TypeBox.Optional) from the property  changes no pool verdict at all
 *
 * So on TypeBox, and only on TypeBox, a required field and an optional one compare identically on
 * every probe. That is not a fear, it is a demonstrated exploit, run both ways: stripping every
 * `Type.Optional(` from `UpdatematrixSchema` in all three generated modules of both passes, 164
 * of them, left the whole script at exit 0. The same edit now exits 1 naming 82 columns, one for
 * every column of the three `matrix` tables the presence axis can read.
 *
 * `askPresence` below is what closes it, for all four libraries rather than for the one that had
 * the hole. It asks the *object* whether the key may be missing, which is a different question
 * from whether the field takes `undefined`: zod's `.optional()` answers yes to both, TypeBox's
 * `Type.Optional` answers yes only to the first, and a field typed `T | undefined` on a required
 * key answers yes only to the second.
 */
export const LIBS: Record<string, Lib> = {
  zod: { field: (s, k) => s.shape[k], ok: (f, x) => f.safeParse(x).success },
  valibot: { field: (s, k) => s.entries[k], ok: (f, x) => v.safeParse(f, x).success },
  arktype: { field: (s, k) => s.get(k), ok: (f, x) => !(f(x) instanceof type.errors) },
  typebox: { field: (s, k) => s.properties[k], ok: (f, x) => Value.Check(f, x) },
};

/**
 * What one schema said about one value. `threw` is not a verdict and neither pass may treat it as
 * one.
 *
 * This used to be a `catch { return false }`, which scored an exception as a rejection. Every one
 * of them comes from the same place, and the set is provable rather than sampled: official's
 * TypeBox module emits `{ type: 'RegExp', source, maxLength }` for a few columns, and TypeBox's
 * `maxLength` check reads `value.length` with no type guard, so `null` and `undefined` crash it
 * instead of failing it. Enumerated on both majors, the set of crashing columns and the set of
 * `type: 'RegExp'` columns are the same set, nine pairings on v1 and three on 0.4x:
 *
 *   v1     pg/c_bit, mysql/m_binary, mysql/m_varbinary, in all three modes
 *   0.4x   pg/c_bit alone, because that module emits a bare string for the binary columns
 *
 * So it is one upstream defect present on both majors rather than a difference between them. Zero
 * crashes come from arktype, which the sentence that used to stand here named, and zero from
 * anything DRZL emits on either major.
 *
 * Scoring those as rejections is not harmless: they fed the `looser` counts the ledger entries are
 * asserted against, so a swallowed crash was being reported as evidence.
 */
export type Verdict = 'accept' | 'reject' | 'threw';

export const probe = (lib: Lib, f: any, x: unknown): Verdict => {
  try {
    return lib.ok(f, x) ? 'accept' : 'reject';
  } catch {
    return 'threw';
  }
};

/** Whether an object schema lets a key be missing altogether. Not a verdict about a value. */
export type Presence = 'optional' | 'required';

/**
 * Does this schema require each key, asked of the object rather than of the extracted field?
 *
 * The field comparison above cannot ask it. A field carries the column's value rules; requiredness
 * lives on the parent, and on TypeBox it lives there exclusively, which is the hole this closes:
 * `Value.Check(property, undefined)` is false whether or not the property carries
 * `Symbol(TypeBox.Optional)`, so a TypeBox schema that got optionality wrong in either direction
 * gave every pool probe the same answer as a correct one.
 *
 * **An absence is asked as an absence.** The key is deleted from the object, not set to
 * `undefined`. Measured on TypeBox, where the two differ:
 * `Value.Check(Type.Object({ a: Type.Optional(Type.String()), b: Type.String() }), { b: 'x' })` is
 * true and so is the same object carrying `a: undefined`, while the field-level
 * `Value.Check(properties.a, undefined)` is false. Setting `undefined` would therefore be asking
 * the value question in the place the absence question belongs.
 *
 * The object is built from values this side accepts one at a time, and each side builds its own.
 * That is deliberate: two schemas can disagree so completely about a column's *type* that no pool
 * value satisfies both, which is the state `mysql/m_binary` is in on 0.4x, where DRZL wants a
 * Uint8Array and the official module wants a string. A shared object would then be refused by one
 * side for every key and the whole pairing would read as "requires everything" on both. The
 * question here is about the key, not about the value, so each side is asked with an object it
 * agrees is otherwise valid, and the control below is what says it agrees.
 *
 * Nothing here is ever skipped quietly. A column this side accepts no pool value for, and an object
 * this side refuses despite being built from its own accepted values, are both reported: the caller
 * fails on them rather than comparing an absence with an absence.
 *
 * A crash is not an answer here either, and it happens: official's TypeBox module emits
 * `{ type: 'RegExp', maxLength }` for a few columns, and its length check reads `value.length` with
 * no type guard, so the object check throws when the key is missing rather than reporting it
 * missing. Measured on `drizzle-typebox` 0.3.3 for `bit({ dimensions: 3 }).notNull()`: the full
 * object is accepted, and the same object with the key omitted throws
 * `Cannot read properties of undefined (reading 'length')`. Those columns come back in `crashed`
 * and the caller holds them to the same THREW ledger the value pool's crashes go to.
 *
 * `barren` is the other way this can fail to be readable, and it is a real state rather than a
 * hypothetical: official's TypeBox schema for a `uuid` column is `Type.String({ format: 'uuid' })`,
 * and TypeBox fails a format it has no entry for, so that field accepts nothing at all. No object
 * satisfying it exists, and where the column is also required no key of that object can be asked
 * about. The caller declares those and counts what they cost rather than reporting the pairing as
 * agreement.
 */
export type PresenceReading = {
  verdicts: Map<string, Presence>;
  /** Columns where this side crashed on the omission instead of answering. */
  crashed: string[];
  /** Columns this side accepts no pool value for, so no object satisfying it can be built. */
  barren: string[];
  /** Empty when the object built from this side's own accepted values was accepted. */
  control: string;
};

export const askPresence = (lib: Lib, schema: any, cols: string[]): PresenceReading => {
  const crashed: string[] = [];
  const barren: string[] = [];
  const verdicts = new Map<string, Presence>();
  const base: Record<string, unknown> = {};
  for (const k of cols) {
    let f: unknown;
    try {
      f = lib.field(schema, k);
    } catch {
      f = undefined;
    }
    if (!f) {
      barren.push(k);
      continue;
    }
    const hit = POOL.find(([, x]) => x !== undefined && probe(lib, f, x) === 'accept');
    if (!hit) {
      barren.push(k);
      continue;
    }
    base[k] = hit[1];
  }
  const control = probe(lib, schema, base);
  if (control !== 'accept') {
    return {
      verdicts,
      crashed,
      barren,
      control:
        `answers ${control} to an object built entirely from values it accepts one at a time, so ` +
        'removing a key from that object measures nothing',
    };
  }
  for (const k of cols) {
    if (!(k in base)) continue;
    const without = { ...base };
    delete without[k];
    const got = probe(lib, schema, without);
    if (got === 'threw') {
      crashed.push(k);
      continue;
    }
    verdicts.set(k, got === 'accept' ? 'optional' : 'required');
  }
  return { verdicts, crashed, barren, control: '' };
};

/**
 * A real Postgres, asked directly whether a column takes a value, and whether it takes that column
 * being left out of the insert altogether.
 *
 * Here because of the hole a crash left. A probe official crashes on cannot be compared, and it
 * used to be dropped, so DRZL's verdict on it was measured by nothing: making the v1 typebox
 * Insert and Update schemas for `c_bit` accept `null` on a `bit(3) NOT NULL` column left that
 * whole run byte identical to green. Pinning DRZL's verdict closes the hole; this is what settles
 * whether the pinned verdict is the right one, on the dialect that has an engine in this process.
 *
 * The DDL comes from the fixture's own column object rather than being written down here, so a
 * column that changes type changes what the database is asked about it.
 *
 * **A value and an absence are different questions and are asked differently.** A value is bound
 * as a parameter. An absence is a statement that never names the column, which is what an absent
 * field is; binding a JS `undefined` in its place asks the value question instead, because the
 * driver turns it into a NULL on the way to the server: a bound `undefined` comes back 23502, the
 * same answer as `null`. That was measured when this was written and is **not** re-measured on
 * every run, because the harness never binds `undefined`. It omits the column instead, which is the
 * question it wants asked. Both passes used to declare that no database could be handed an absence
 * at all, which was that one measurement about the driver written up as a fact about databases.
 *
 * Three tables per column, differing only in the constraint and the default. Each answer is read
 * only once its own control holds:
 *
 *   `probe_nn_N`    `c T not null`                 the subject
 *   `probe_null_N`  `c T`                          has to take a NULL and to take an omission
 *   `probe_def_N`   `c T not null default <lit>`   has to take an omission and still refuse a NULL
 *
 * Without the nullable twin, a refusal could as easily be a missing relation and would be scored as
 * a verdict about the value. Without the twin carrying a default, an omission and a NULL could not
 * be told apart at all: on `bit(3) not null` they give the same SQLSTATE, so the run would be
 * reporting the NULL answer under the absence's name. Measured, not supposed:
 *
 *   an insert into a table that does not exist        42P01
 *   NULL into bit(3) not null                         23502
 *   the column omitted, bit(3) not null               23502
 *   a bit string of the wrong width                   22026
 *   NULL into the nullable twin                       accepted
 *   the column omitted on the nullable twin           accepted
 *   the column omitted on the twin with a default     accepted, and the default is what is stored
 *   NULL into the twin with a default                 23502
 *
 * So a refusal carries its SQLSTATE rather than being a boolean, "refused by the constraint" is a
 * different answer from "refused by the type", and "refused because nothing supplied it" is a
 * different answer from both, on the same column type.
 *
 * The default is not written down either. The first pool value the type accepts is read back
 * through `quote_literal(c::text)` and cast to the column's own type, so a column no pool value
 * fits reports that it has no twin carrying a default rather than quietly losing the control.
 *
 * `engine` is the engine's own answer to `select version()`. A caller that declares a probe
 * unarbitrable for want of an engine then has something independent of its own branch to check
 * that reason against.
 */
export type DbProbe = { key: string; sqlType: string; notNull: boolean; label: string; absent: boolean; value: unknown };
export type DbAnswer = { verdict: 'accept' | 'refuse'; code: string; control: string };
export type DbReply = { engine: string; answers: Map<string, DbAnswer> };

export const askPostgres = async (probes: DbProbe[]): Promise<DbReply> => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  const answers = new Map<string, DbAnswer>();
  let engine = 'unknown';
  try {
    const version = (await db.query<{ version: string }>('select version()')).rows[0]?.version ?? '';
    engine = /^PostgreSQL\b/.test(version) ? 'pg' : `not a Postgres: ${version.split(' ')[0] || 'unnamed'}`;
    const send = async (sql: string, params: unknown[]): Promise<{ verdict: 'accept' | 'refuse'; code: string }> => {
      try {
        await db.query(sql, params);
        return { verdict: 'accept', code: '' };
      } catch (e: unknown) {
        // A refusal with no SQLSTATE did not come from Postgres, so it is not reported as one.
        const code = (e as { code?: unknown } | null)?.code;
        return { verdict: 'refuse', code: typeof code === 'string' && code ? code : 'no SQLSTATE' };
      }
    };
    const withValue = (table: string, value: unknown) => send(`insert into ${table} (c, k) values ($1, 1)`, [value]);
    // The column is not named at all, which is the whole reason `k` is there: an insert has to
    // still be an insert once `c` is left out of it.
    const omitting = (table: string) => send(`insert into ${table} (k) values (1)`, []);

    const tables = new Map<string, { nn: string; nullable: string; dflt: string; noDflt: string }>();
    for (const p of probes) {
      if (tables.has(p.key)) continue;
      const n = tables.size;
      const t = { nn: `probe_nn_${n}`, nullable: `probe_null_${n}`, dflt: `probe_def_${n}`, noDflt: '' };
      // The subject carries the fixture column's own `notNull`, not a fixed `not null`. Every crash
      // site was on a `notNull` column until a nullable one arrived, and a nullable subject asked
      // about as a NOT NULL one answers 23502 to a NULL the column really does take, which reads as
      // "postgres refuses it and DRZL accepts it" for a schema that is right. The twins below stay
      // as they are: they are controls on the constraint, not on the column.
      await db.exec(
        `create table ${t.nn} (c ${p.sqlType}${p.notNull ? ' not null' : ''}, k int); ` +
          `create table ${t.nullable} (c ${p.sqlType}, k int)`
      );
      let lit: string | null = null;
      for (const [, x] of POOL) {
        if (x === null || x === undefined) continue;
        if ((await send(`insert into ${t.nullable} (c, k) values ($1, 0)`, [x])).verdict !== 'accept') continue;
        const q = await db.query<{ q: string | null }>(`select quote_literal(c::text) as q from ${t.nullable} where k = 0`);
        lit = q.rows[0]?.q ?? null;
        await db.exec(`delete from ${t.nullable}`);
        break;
      }
      if (lit === null) {
        t.noDflt =
          `no pool value is a ${p.sqlType}, so no twin carrying a default could be built and an ` +
          'omission cannot be told apart from a NULL here';
      } else {
        const built = await send(`create table ${t.dflt} (c ${p.sqlType} not null default ${lit}::${p.sqlType}, k int)`, []);
        if (built.verdict !== 'accept') {
          t.noDflt =
            `${p.sqlType} would not take ${lit} as a default (${built.code}), so an omission cannot ` +
            'be told apart from a NULL here';
        }
      }
      tables.set(p.key, t);
    }
    for (const p of probes) {
      const t = tables.get(p.key)!;
      if (p.absent) {
        const twinOmit = await omitting(t.nullable);
        const dfltOmit = t.noDflt ? null : await omitting(t.dflt);
        const dfltNull = t.noDflt ? null : await withValue(t.dflt, null);
        const got = await omitting(t.nn);
        answers.set(`${p.key}/${p.label}`, {
          verdict: got.verdict,
          code: got.code,
          control: twinOmit.verdict !== 'accept'
            ? `the nullable twin of ${p.sqlType} refused an insert that never names the column (${twinOmit.code}), so this table cannot isolate the constraint`
            : t.noDflt
              ? t.noDflt
              : dfltOmit!.verdict !== 'accept'
                ? `the twin of ${p.sqlType} carrying a default refused the same omission (${dfltOmit!.code}), so an omission is not reaching a default here`
                : dfltNull!.verdict !== 'refuse'
                  ? `the twin of ${p.sqlType} carrying a default took an explicit NULL, so this run cannot tell an omission apart from a NULL`
                  : '',
        });
        continue;
      }
      const control = await withValue(t.nullable, null);
      const got = await withValue(t.nn, p.value);
      answers.set(`${p.key}/${p.label}`, {
        verdict: got.verdict,
        code: got.code,
        control:
          control.verdict === 'accept'
            ? ''
            : `the nullable twin of ${p.sqlType} refused a NULL (${control.code}), so this table cannot isolate the constraint`,
      });
    }
  } finally {
    await db.close();
  }
  return { engine, answers };
};
PARITY_POOL
cp "$WORK/parity-pool.ts" src/pool.ts

cat > src/parity.ts <<'PARITY_HARNESS'
/**
 * Differential parity for DRZL's validator generators.
 *
 * Pass 1 compares DRZL against `drizzle-orm/{zod,valibot,arktype}` for every column of every
 * table, across three dialects and all three schema modes, by pushing the same pool of values
 * through both and comparing verdicts. Reading the emitted source cannot do this: a schema that
 * validates and one that merely parses look identical as text.
 *
 * Pass 2 cross-checks DRZL's own four generators against each other, which catches a generator
 * drifting from its siblings on something all four should agree about.
 *
 * Both passes here measure drizzle-orm v1, which is what this tree pins. The same comparison
 * against the first-party modules for 0.45.2 runs near the end of this script, in the 0.4x tree,
 * and reads its pool of values out of the same `pool.ts` this file does.
 *
 * All four are compared against official. `drizzle-orm/typebox` targets the newer `typebox`
 * package and throws `Class extends value undefined` on import against the released one, but
 * `drizzle-orm/typebox-legacy` is the same module built for `@sinclair/typebox`, which is what
 * this generator emits for.
 */
import { createSelectSchema, createInsertSchema, createUpdateSchema } from 'drizzle-orm/zod';
import {
  createSelectSchema as vSelect,
  createInsertSchema as vInsert,
  createUpdateSchema as vUpdate,
} from 'drizzle-orm/valibot';
import {
  createSelectSchema as aSelect,
  createInsertSchema as aInsert,
  createUpdateSchema as aUpdate,
} from 'drizzle-orm/arktype';
import {
  createSelectSchema as tSelect,
  createInsertSchema as tInsert,
  createUpdateSchema as tUpdate,
} from 'drizzle-orm/typebox-legacy';
// The pool and the accessors come from a file the 0.4x pass reads as well, so both majors are
// asked the same question with the same values.
import { readFileSync } from 'node:fs';
import { constants } from 'node:buffer';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  POOL,
  LIBS,
  probe,
  askPostgres,
  askPresence,
  type DbProbe,
  type Lib,
  type Presence,
  type Verdict,
} from './pool.js';

import { matrix as pgTable, nullable as pgNullable } from './schema.js';
import { matrix as myTable, nullable as myNullable } from './schema-mysql.js';
import { matrix as sqTable, nullable as sqNullable } from './schema-sqlite.js';

const OFFICIAL: Record<string, Record<string, (t: any) => any>> = {
  zod: { select: createSelectSchema, insert: createInsertSchema, update: createUpdateSchema },
  valibot: { select: vSelect, insert: vInsert, update: vUpdate },
  arktype: { select: aSelect, insert: aInsert, update: aUpdate },
  // `drizzle-orm/typebox` targets the `typebox` package and throws on import against the released
  // one, but `typebox-legacy` is the same module built for `@sinclair/typebox`, which is what
  // this generator emits for. So typebox is compared against official like the other three
  // rather than only cross-checked.
  typebox: { select: tSelect, insert: tInsert, update: tUpdate },
};

const safeField = (lib: Lib, s: any, k: string) => {
  try {
    return lib.field(s, k);
  } catch {
    return undefined;
  }
};

/**
 * Probes where one side crashes instead of answering, which is not a verdict and is not compared
 * as one. Declared exactly, and asserted in both directions like every other list here: an
 * undeclared crash fails this script, and a declared one that no longer happens fails it too.
 *
 * A crash used to end the story for that value: it was dropped from the comparison, so nothing
 * measured DRZL on it at all. That made a crashing official module a licence for DRZL to do
 * anything. Demonstrated rather than feared: making the typebox Insert and Update schemas for
 * `c_bit` accept `null`, on a `bit(3).notNull()` column, left this whole run byte identical to
 * green. Doing it to the Select arm as well is caught at once, by the cross-generator pass below
 * printing `c_bit on null: typebox accept, zod/valibot/arktype reject`, and that is the whole of
 * the old coverage: that pass reads `SelectmatrixSchema` and nothing else.
 *
 * So two more fields, and both are asserted:
 *
 *   `drzl`     what DRZL answers on the crashed value, keyed `<mode-or-*>/<value>`. Every crashed
 *              probe has to be claimed by exactly one declaration and match it, and every
 *              declaration has to claim at least one probe. This is the part that fails when
 *              DRZL's answer moves.
 *   `arbiter`  who settles that DRZL's answer is the right one, keyed by value, and computed by
 *              the run rather than believed: a real Postgres through PGlite wherever one runs for
 *              that dialect, and the reason it cannot be otherwise. A value the database refuses
 *              and DRZL accepts is a finding unless a waiver names the column dialect-wide, as
 *              `<dialect>/<column>`. A library-scoped waiver such as `pg/typebox/c_uuid` does not
 *              suppress it, which is the fail-closed direction: the database's answer does not
 *              depend on which library was asked, so a waiver about one library is not a reason to
 *              accept a row the server will reject.
 *
 * Keyed `<dialect>/<library>/<column>`.
 */
type Crash = {
  side: string;
  modes: string[];
  values: string[];
  why: string;
  /** What DRZL answers where official crashed, keyed `<mode-or-*>/<value>`. */
  drzl: Record<string, string>;
  /** What settles that answer, keyed by value. Computed by the run and compared with this. */
  arbiter: Record<string, string>;
  /**
   * The modes in which the same side crashes on the *object* with this key omitted, rather than
   * reporting the key missing. Empty where that does not happen, and asserted in both directions
   * like everything else here, so a crash the presence axis meets is either declared or a failure.
   */
  absentModes: string[];
};
const THREW: Record<string, Crash> = {
  // Three columns, one cause, and the set is derived rather than collected: official's TypeBox
  // module emits `{ type: 'RegExp', maxLength }` for exactly these three on this major, and
  // TypeBox's length check reads `value.length` with no type guard. Enumerating the `type: RegExp`
  // columns and the crashing columns across all three dialects and all three modes gives the same
  // nine pairings. `drizzle-typebox 0.3.3` on 0.45.2 has the same defect on `c_bit`, and emits a
  // bare string for the two binary columns, so the 0.4x pass declares one site and not three.
  // Nothing DRZL emits crashes on any probe, on either major.
  'pg/typebox/c_bit': {
    side: 'official',
    modes: ['select', 'insert', 'update'],
    values: ['null', 'undefined'],
    why: 'official Type.RegExp with maxLength reads .length of a null value',
    drzl: { '*/null': 'reject', '*/undefined': 'reject' },
    arbiter: {
      // A real Postgres, built from this column's own `getSQLType()`, refuses a NULL into
      // `bit(3) not null` with a not-null violation, and its nullable twin takes one.
      null: 'postgres refuses it (SQLSTATE 23502)',
      // An absence is handed to a database by leaving the column out of the insert, so this is
      // asked rather than declared unaskable. What used to stand here said no database could be
      // handed an absence, on the evidence that a bound `undefined` comes back 23502; that is a
      // fact about the driver's parameter binding, and it was written up as one about databases.
      // Measured on this column's own `bit(3) not null`: the insert that never names `c` is
      // refused 23502, while the same omission against a twin of the same type carrying a default
      // is accepted and stores the default, and that twin still refuses an explicit NULL. Three
      // questions, three answers, and this entry is the answer to the middle one.
      undefined: 'postgres refuses the column omitted from the insert (SQLSTATE 23502)',
    },
    // No omission ever reaches this column: `c_uuid` on the same object accepts nothing, so
    // official's Postgres TypeBox schema has no satisfiable object for the presence axis to take a
    // key out of. See PRESENCE_BARREN.
    absentModes: [],
  },
  // The nullable twin of the site above, and the reason the crash-site arbitration now reads the
  // fixture column's own `notNull`. Everything about it is the same defect: official emits
  // `type: 'RegExp'` with a `maxLength` whose check reads `value.length`. What differs is the right
  // answer, and it differs because the column differs: `n_bit` is nullable, so accepting a NULL is
  // correct, and Postgres says so on a table built from this column rather than from `c_bit`'s.
  'pg/typebox/n_bit': {
    side: 'official',
    modes: ['select', 'insert', 'update'],
    values: ['null', 'undefined'],
    why: 'as pg/typebox/c_bit',
    // `reject` on `undefined` in every mode, insert and update included, because a TypeBox field
    // extracted from the parent never takes `undefined` whether or not it is optional. That is the
    // same inertness the key-presence axis exists for, seen from the value side.
    drzl: { '*/null': 'accept', '*/undefined': 'reject' },
    arbiter: {
      null: 'postgres accepts it',
      undefined: 'postgres accepts the column omitted from the insert',
    },
    // Select alone, where `c_bit` above is select and insert. A nullable column is optional on
    // insert and update, so TypeBox skips the property when the key is missing and never reaches
    // the length check that crashes.
    absentModes: ['select'],
  },
  'mysql/typebox/m_binary': {
    side: 'official',
    modes: ['select', 'insert', 'update'],
    values: ['null', 'undefined'],
    why: 'as pg/typebox/c_bit',
    drzl: { '*/null': 'reject', '*/undefined': 'reject' },
    arbiter: {
      // PGlite is a Postgres and cannot answer for a MySQL column, and there is no MySQL that runs
      // in this process. Asked out of band, a real MySQL 8.4.11 refuses a NULL into
      // `binary(4) not null` and into `varbinary(16) not null` with ERROR 1048 "Column cannot be
      // null", while the same insert carrying values stores 4 and 2 bytes. That is not this run's
      // evidence, so it is not this run's claim, and the pinned verdict is what gates here.
      //
      // The absence is unarbitrated for the same reason and not for a different one: there is a
      // way to ask it, which is to leave the column out of the insert, and no MySQL here to ask.
      // The reason is checked against the engine's own `select version()` rather than only being
      // computed by the branch that produces it.
      null: 'no in-process mysql engine',
      undefined: 'no in-process mysql engine',
    },
    absentModes: ['select', 'insert'],
  },
  'mysql/typebox/m_varbinary': {
    side: 'official',
    modes: ['select', 'insert', 'update'],
    values: ['null', 'undefined'],
    why: 'as pg/typebox/c_bit',
    drzl: { '*/null': 'reject', '*/undefined': 'reject' },
    arbiter: {
      null: 'no in-process mysql engine',
      undefined: 'no in-process mysql engine',
    },
    absentModes: ['select', 'insert'],
  },
};
// `at` is every `<side>/<mode>/<value>` that crashed, so the printed figure is a count rather than
// a cross product that happens to equal one while the pattern is a rectangle.
const threwSeen = new Map<string, { sides: Set<string>; modes: Set<string>; values: Set<string>; at: Set<string> }>();
// DRZL's own verdict on a value official crashed on, keyed by crash site then `<mode>/<value>`.
// The comparison cannot use it, which is not the same thing as nobody looking at it.
const crashVerdict = new Map<string, Map<string, string>>();
const recordCrashVerdict = (key: string, mode: string, label: string, verdict: Verdict) => {
  const seen = crashVerdict.get(key) ?? new Map<string, string>();
  seen.set(`${mode}/${label}`, verdict);
  crashVerdict.set(key, seen);
};
const recordThrow = (key: string, side: string, mode: string, value: string) => {
  const seen =
    threwSeen.get(key) ?? { sides: new Set<string>(), modes: new Set<string>(), values: new Set<string>(), at: new Set<string>() };
  seen.sides.add(side);
  seen.modes.add(mode);
  seen.values.add(value);
  seen.at.add(`${side}/${mode}/${value}`);
  threwSeen.set(key, seen);
};

/**
 * A waiver pins the exact divergence it covers, not a shape.
 *
 * `divergence` is keyed `<modes>/<libraries>`, `*` for all of them, and each value is the exact
 * signature measured for those pairings: `L: <labels DRZL accepts and official refuses> | T: <the
 * other way>`, in pool order. Three signatures are stated from the other end rather than as a
 * list: `every probe official rejects (N of them), and official accepts only: <labels>` says DRZL
 * took the whole pool, how many official refused and exactly which ones it did not, and the two
 * `has it, omits it` strings say one side produced no field at all. That first one carries both a
 * count and a complement because each without the other is a shape: with neither, official
 * narrowing its rejections to two left the signature unmoved; with the count alone, official
 * swapping which probes it refuses left it unmoved at an unchanged count. Both holes were measured
 * on the 0.4x pass, where the columns in that state live. All three are what the run produces in
 * those states, and no waiver declares any of them today, since no waived column on this major is
 * untyped or missing on one side. They are the shape a future one would take, not a claim about
 * the current list.
 *
 * Until this existed a waiver asserted only that it suppressed something, and a real regression
 * walked through it: stripping every length cap from `m_tinytext` in all four generated modules
 * left this pass green, because the column still differed, just on different values. The 0.4x
 * stage named the identical break. Two gates side by side, one absorbing regressions and one not,
 * is worse than the churn of pinning both.
 *
 * The churn is the trade and it is the right way round. A pool value that any waived column treats
 * differently from official re-opens that waiver, because the alternative is a waiver quietly
 * covering a divergence nobody has looked at.
 */
type Waiver = {
  /** The libraries this waiver covers, asserted exactly against what it suppressed. */
  libs: string[];
  /** The modes it covers, asserted the same way. */
  modes: string[];
  /** Why the divergence is deliberate. */
  why: string;
  /** The exact divergence, keyed `<modes>/<libraries>`. */
  divergence: Record<string, string>;
  /**
   * Pairings inside `libs` x `modes` that genuinely do not diverge, named one at a time.
   *
   * The product is asserted exactly, which is what stops a waiver covering four pairings while
   * claiming twelve. A real divergence that misses one cell of the product therefore has nowhere
   * to go, and the alternatives are both worse: widening `libs` or `modes` until the product fits
   * understates which pairings are waived, and splitting the column across two keys is not
   * possible since the key is the column.
   *
   * Asserted in the fail-closed direction. A pairing named here that *does* diverge fails the run,
   * so this can only ever shrink what the waiver claims, never quietly absorb a new difference.
   */
  except?: string[];
};

const LIB_NAMES = ['zod', 'valibot', 'arktype', 'typebox'];
const MODE_NAMES = ['select', 'insert', 'update'];
const WRITE = ['insert', 'update'];

// A signature for a column DRZL accepts every probe of, stated as the count of official's
// rejections plus the exact set it accepts instead. The complement is what makes it a set rather
// than a shape, and it is a handful of labels where the list it replaces is nearly the whole pool.
// See the fuller note on the same constant in the 0.4x pass below, which is where the columns in
// that state live.
//
// How many columns use it is printed by each run rather than written down here. Sentences in this
// file used to carry that number, and others carried the length of the list it replaces; adding
// five pool values made every one of them wrong in a single edit, which is the argument for
// deriving it. The sentence that stood here counted both groups and got the second group wrong,
// which is this species reproducing inside its own cure for the second time in one branch.
const allProbes = (n: number, accepted: string[]) =>
  `every probe official rejects (${n} of them), and official accepts only: ` +
  (accepted.length ? accepted.join(', ') : 'nothing in the pool');

/**
 * Does a declaration key such as `select,insert/zod` cover the pairing `select/zod`? A declaration
 * that covers no pairing, and two that cover the same one, both fail rather than being resolved by
 * precedence.
 */
const pairingMatches = (decl: string, pairing: string) => {
  const [dModes, dLibs] = decl.split('/');
  const [mode, lib] = pairing.split('/');
  const covers = (spec: string, x: string) => spec === '*' || spec.split(',').includes(x);
  return covers(dModes, mode) && covers(dLibs, lib);
};

/**
 * Divergences that are deliberate and reasoned. Anything not named here is a finding, so a new
 * disagreement fails this script rather than quietly widening the list.
 *
 * Keyed `<dialect>/<library>/<column>`; `<dialect>/<column>` applies to every library on that
 * dialect. The dialect is part of the key because this file compared all four libraries on
 * Postgres alone for most of its life, and a waiver keyed on a column name would have started
 * covering a same-named column on MySQL or SQLite the moment those dialects were widened. The
 * fixtures use distinct `c_`/`m_`/`s_` prefixes, which makes the dialect redundant today and
 * load-bearing the day someone adds a column without one.
 */
const ALLOWED: Record<string, Waiver> = {
  // Binary payloads are typed as Uint8Array rather than Buffer. A Buffer is a Uint8Array, so
  // nothing official accepts is turned away. The wider check needs no `@types/node`, survives a
  // runtime where `Buffer` is undefined, and makes bytea and blob validate the same way.
  'pg/c_bytea': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'Uint8Array accepted where official demands a Buffer', divergence: { '*/*': `L: Uint8Array | T: ` } },
  'sqlite/s_blob_buf': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as pg/c_bytea', divergence: { '*/*': `L: Uint8Array | T: ` } },
  // `coerceDates` defaults to coercing on insert and update, which is a documented DRZL option
  // and is what `coerceDates: 'none'` turns off to match official exactly. Only strings and
  // numbers are coerced: null, booleans and arrays are rejected, which `z.coerce.date()` accepts.
  //
  // The two arms differ on more than a value and the reason is worth stating, because this waiver
  // previously read as one thing while excusing another. zod also takes an epoch number, since it
  // is the only arm with a number branch at all; the other three never had one. That is a
  // cross-generator inconsistency rather than a defect against the database, filed and not fixed
  // here. What both arms now agree on is that a string has to parse to a real date (BA): the
  // signature used to carry `'hello'`, `'zzz'` and 22000 CJK characters under a `why` that said
  // "a date string or epoch number", which described neither of them.
  'pg/c_date_d': {
    libs: LIB_NAMES,
    modes: WRITE,
    why: 'coerceDates accepts a parseable date string on write, and an epoch number in the zod arm',
    divergence: {
      '*/zod': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101 | T: `,
      '*/valibot,arktype,typebox': `L: '2020-01-01', '2020-01-01T00:00:00Z' | T: `,
    },
  },
  'pg/c_ts_d': {
    libs: LIB_NAMES,
    modes: WRITE,
    why: 'as pg/c_date_d',
    divergence: {
      '*/zod': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101 | T: `,
      '*/valibot,arktype,typebox': `L: '2020-01-01', '2020-01-01T00:00:00Z' | T: `,
    },
  },
  'mysql/m_date': {
    libs: LIB_NAMES,
    modes: WRITE,
    why: 'as pg/c_date_d',
    divergence: {
      '*/zod': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101 | T: `,
      '*/valibot,arktype,typebox': `L: '2020-01-01', '2020-01-01T00:00:00Z' | T: `,
    },
  },
  'mysql/m_datetime': {
    libs: LIB_NAMES,
    modes: WRITE,
    why: 'as pg/c_date_d',
    divergence: {
      '*/zod': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101 | T: `,
      '*/valibot,arktype,typebox': `L: '2020-01-01', '2020-01-01T00:00:00Z' | T: `,
    },
  },
  'mysql/m_ts': {
    libs: LIB_NAMES,
    modes: WRITE,
    why: 'as pg/c_date_d',
    divergence: {
      '*/zod': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101 | T: `,
      '*/valibot,arktype,typebox': `L: '2020-01-01', '2020-01-01T00:00:00Z' | T: `,
    },
  },
  'sqlite/s_int_ts': {
    libs: LIB_NAMES,
    modes: WRITE,
    why: 'as pg/c_date_d',
    divergence: {
      '*/zod': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101 | T: `,
      '*/valibot,arktype,typebox': `L: '2020-01-01', '2020-01-01T00:00:00Z' | T: `,
    },
  },
  'sqlite/s_int_ts_ms': {
    libs: LIB_NAMES,
    modes: WRITE,
    why: 'as pg/c_date_d',
    divergence: {
      '*/zod': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101 | T: `,
      '*/valibot,arktype,typebox': `L: '2020-01-01', '2020-01-01T00:00:00Z' | T: `,
    },
  },
  // Official emits `Type.String({ format: 'uuid' })`, and TypeBox fails a format it has no entry
  // for rather than ignoring it, so that schema rejects every valid uuid in any project that has
  // not populated `FormatRegistry` first. This generator emits a pattern, which needs no setup.
  'pg/typebox/c_uuid': { libs: ['typebox'], modes: MODE_NAMES, why: 'official uses an unregistered `format`, which rejects every uuid', divergence: { '*/*': `L: uuid | T: ` } },
  // A character limit counts *characters*; official counts `.length`, which is UTF-16 units, so
  // it refuses three emoji in a `char(4)` the database accepts. Measured against Postgres: three
  // emoji insert into a `char(4)` and read back as four code points, which are seven UTF-16 units.
  'pg/c_char': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'character limit counts code points; official counts UTF-16 units', divergence: { '*/*': `L: 3 emoji | T: ` } },
  'mysql/m_char': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as pg/c_char', divergence: { '*/*': `L: 3 emoji | T: ` } },
  // MySQL's TEXT family is capped in bytes and official caps it in UTF-16 units, so official takes
  // a 100 emoji string that is 200 units and 400 bytes into a `tinytext` whose budget is 255. DRZL
  // emits the byte check and refuses it. A real MySQL 8 on a utf8mb4 client is the authority and
  // agrees with DRZL: that insert fails with "Data too long", while the same string goes into a
  // `varchar(255)` and reports `length` 400 with `char_length` 100.
  //
  // Which columns the pool reaches is arithmetic, not luck. A separating probe is over the cap in
  // bytes and not over it in UTF-16 units, and UTF-8 spends at most 3 bytes per unit, so it needs
  // more than cap/3 units. That is 86 for `tinytext` and 21846 for `text` and `blob`, all three in
  // the pool, against 5592406 for `mediumtext` and 1431655766 for `longtext`, which are not.
  //
  // Which of them anything measures is not stated here at all any more, because both previous
  // attempts at that sentence were false and the second was written by the fix for the first. It is
  // computed per column and asserted in CAP_COVERAGE further down this file, so a claim about
  // coverage fails when it stops being true instead of being re-read as true.
  'mysql/m_tinytext': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'MySQL caps TEXT in bytes; official caps it in UTF-16 units, and takes 400 bytes into a 255 byte column', divergence: { '*/*': `L:  | T: 100 emoji` } },
  'mysql/m_text': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as mysql/m_tinytext, 66000 bytes against a 65535 byte budget', divergence: { '*/*': `L:  | T: 22000 cjk` } },
  // The blob half of the same table, which only this pass reaches: 0.4x's mysql-core has no `blob`
  // export at all, so the 0.4x fixture drops the column. MySQL 8.4 answers the same way for it as
  // for `text`: both refuse the 22000 CJK string with "Data too long", and `mediumtext` in the same
  // table takes it and stores 66000 bytes, which is what shows the probe is measuring the cap.
  'mysql/m_blob': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as mysql/m_tinytext, on a BLOB whose budget is also 65535 bytes', divergence: { '*/*': `L:  | T: 22000 cjk` } },
  // Stricter than official, and verified against Postgres itself through PGlite: a `numeric`
  // column is a string, and a bare string schema accepts 'hello' where the database rejects it.
  // Official accepts all of these; the database does not.
  'pg/c_numeric': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'numeric format enforced; official accepts any string, Postgres does not', divergence: { '*/*': `L:  | T: "", 'hello', 300-char, 70k-char, 5-char, 3 emoji, 5 emoji, 'not-a-uuid', uuid, 'zzz', 'a', 'happy', 'x', '2020-01-01', '2020-01-01T00:00:00Z', '12:00:00', '25:99:99', 100 emoji, 22000 cjk, '999.999.999.999', '10.0.0.1'` } },
  'pg/c_decimal': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as pg/c_numeric', divergence: { '*/*': `L:  | T: "", 'hello', 300-char, 70k-char, 5-char, 3 emoji, 5 emoji, 'not-a-uuid', uuid, 'zzz', 'a', 'happy', 'x', '2020-01-01', '2020-01-01T00:00:00Z', '12:00:00', '25:99:99', 100 emoji, 22000 cjk, '999.999.999.999', '10.0.0.1'` } },
  'mysql/m_decimal': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as pg/c_numeric', divergence: { '*/*': `L:  | T: "", 'hello', 300-char, 70k-char, 5-char, 3 emoji, 5 emoji, 'not-a-uuid', uuid, 'zzz', 'a', 'happy', 'x', '2020-01-01', '2020-01-01T00:00:00Z', '12:00:00', '25:99:99', 100 emoji, 22000 cjk, '999.999.999.999', '10.0.0.1'` } },
  // Stricter than official, in DRZL's favour.
  'pg/valibot/c_json': { libs: ['valibot'], modes: MODE_NAMES, why: 'DRZL rejects Infinity and non-plain objects; official accepts both', divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` } },
  'pg/valibot/c_jsonb': { libs: ['valibot'], modes: MODE_NAMES, why: 'as pg/valibot/c_json', divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` } },
  'pg/valibot/c_jsonb_typed': { libs: ['valibot'], modes: MODE_NAMES, why: 'as pg/valibot/c_json', divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` } },
  'mysql/valibot/m_json': { libs: ['valibot'], modes: MODE_NAMES, why: 'as pg/valibot/c_json', divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` } },
  'sqlite/valibot/s_text_json': { libs: ['valibot'], modes: MODE_NAMES, why: 'as pg/valibot/c_json', divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` } },
  'sqlite/valibot/s_blob_json': { libs: ['valibot'], modes: MODE_NAMES, why: 'as pg/valibot/c_json', divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` } },
  // A `blob()` with no mode is Drizzle's json mode, not its buffer mode, so this is the same
  // column shape as s_blob_json and gets the same reasoning. `s_blob_buf` above is the buffer one.
  'sqlite/valibot/s_blob': { libs: ['valibot'], modes: MODE_NAMES, why: 'as pg/valibot/c_json; a bare blob() is Drizzle json mode', divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` } },
  'pg/valibot/c_point': { libs: ['valibot'], modes: MODE_NAMES, why: 'v.strictTuple rejects a third element; official v.tuple ignores extras', divergence: { '*/*': `L:  | T: [1,2,3]` } },
  'pg/valibot/c_geometry': { libs: ['valibot'], modes: MODE_NAMES, why: 'as pg/valibot/c_point', divergence: { '*/*': `L:  | T: [1,2,3]` } },
  // Looser than official on purpose. An earlier version of this sentence called these the only
  // entries in either pass that run that way, and the map around it refutes that: the run prints
  // how many waivers have DRZL accepting something official refuses, and it is most of them.
  // `pg/c_char` takes three emoji into a `char(3)`, `pg/c_bytea` takes a Uint8Array, and
  // `pg/typebox/c_uuid` takes a uuid TypeBox refuses until a FormatRegistry is populated. Postgres
  // accepts all three. The uuid one is keyed by library because only TypeBox has it.
  //
  // What is unusual about these six is narrower and worth reading for: they are looser on a
  // *numeric range*, which is the kind of divergence this gate was built to catch, and they got
  // that way by moving off the first-party module's numbers rather than by never having had any.
  // The database is the arbiter here, not the first-party module, and it was asked directly
  // through PGlite on each column's own SQL type.
  //
  // `real` / float4. Official bounds it at +/-8388607, and the column stores 8388608, 9000000,
  // 1e9 and 2147483648 and returns every one of them unchanged, and holds every integer exactly
  // to 16777216. So official's bound refuses rows the column hands back, and a select schema that
  // did the same refused its own rows. DRZL bounds it where the database does instead, bisected
  // over the raw bit pattern of a double: 3.4028235677973366e38 is accepted and the next double
  // up answers `... is out of range for type real`. That is why 9007199254740993 and
  // 3.4028235e38 are in the signature and 1e300 is not.
  //
  // `pg/c_real` and `mysql/m_float` are the same width and do not have the same bound, which is
  // why they no longer share a signature. Postgres takes 268435456 representable doubles past the
  // largest float32 and stores the float32 for each; MySQL 8.4 refuses the very next double,
  // measured in `STRICT_ALL_TABLES` and again under the stock MySQL 8 `sql_mode`. The probe that
  // separates them is `3.4028235e38`, which is what a full-magnitude float4 looks like coming
  // back over the text protocol.
  //
  // `double precision` / float8 and everything else backed by an 8 byte float. No bound at all,
  // because there is no finite one that is true: float8 is the JavaScript number's own format and
  // Postgres accepted every finite JS number into one, measured to Number.MAX_VALUE and returned
  // identical. Official bounds it at +/-140737488355327, which refuses 1.75e15, an ordinary
  // microsecond epoch.
  //
  // DRZL was on official's numbers for one release and this is the correction. The failure text
  // this gate prints for an unwaived difference used to gloss "looser than the first-party module"
  // as "accepts rows the database will reject", which is exactly the equivalence that does not hold
  // for these six: the database accepts every value in these signatures except the ones noted
  // below. That sentence has been rewritten rather than caveated, because it was already false of
  // five waived columns before these six arrived.
  //
  // Two values in these signatures the database is not on DRZL's side about:
  //   9007199254740993   the JS literal is 9007199254740992, which a float8 holds exactly and a
  //                      float4 rounds. Postgres stores it in both. It is here because no bound
  //                      excludes it, not because a bound was chosen to admit it.
  //   Infinity           Postgres stores and returns it in both types, so accepting it is right;
  //                      only valibot and arktype do, because `z.number()` and `Type.Number()`
  //                      refuse it with no bound at all. Filed: describing that column honestly
  //                      needs a union in every generator rather than a range.
  // The arktype update arm gains `Infinity` alone rather than `NaN, Infinity`. Not a gap in the
  // fix: official `drizzle-orm/arktype` already accepts NaN in its union-shaped arms, so NaN was
  // never a divergence there and still is not. Measured directly: `{x:'number'}` rejects NaN,
  // `{x:'(bound | null)'}` accepts it.
  'pg/c_real': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'bounded where Postgres stops accepting rather than at drizzle-zod +/-8388607, which refuses rows the column returns. Non-finite values were added on top: Postgres stores NaN and both infinities in a float column and returns them, and a Select schema refusing what the database hands back fails on real rows (AW).', divergence: { 'select,insert/*': `L: 9000000, 2147483648, 9007199254740993, 3.4028235e38, NaN, Infinity | T: `, 'update/zod,valibot,typebox': `L: 9000000, 2147483648, 9007199254740993, 3.4028235e38, NaN, Infinity | T: `, 'update/arktype': `L: 9000000, 2147483648, 9007199254740993, 3.4028235e38, Infinity | T: ` } },
  'mysql/m_float': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as pg/c_real, but at MySQL edge: a real MySQL 8.4 refuses 3.4028235e38 where Postgres takes it', divergence: { '*/*': `L: 9000000, 2147483648, 9007199254740993 | T: ` } },
  // All four libraries now carry the same signature, where zod and typebox used to differ from
  // valibot and arktype on the infinities. That convergence is the fix: the two that refused a
  // non-finite number no longer do.
  // NaN and not the infinities, and the asymmetry is the point. Postgres takes NaN into a numeric
  // whether or not it carries a precision, and takes an infinity only when it does not: a
  // `numeric(10,2)` answers `22003 numeric field overflow`. The analyzer does not read precision
  // or scale at all, so it cannot tell the two declarations apart, and accepting would make the
  // schema admit what the server refuses for the commoner one. Narrower on purpose (AW).
  //
  // arktype on update is excepted because official already accepts NaN there, so there is nothing
  // to waive. It is the one cell of the twelve that reports parity.
  'pg/c_numeric_n': { libs: LIB_NAMES, modes: MODE_NAMES, except: ['update/arktype'], why: 'Postgres stores NaN in a numeric column and returns it; official refuses the value the database hands back', divergence: { '*/*': `L: NaN | T: ` } },
  'pg/c_double': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'no finite bound is true of an 8 byte float, which holds every finite JS number. Non-finite values were added on top: Postgres stores NaN and both infinities in a float column and returns them, and a Select schema refusing what the database hands back fails on real rows (AW).', divergence: { 'select,insert/*': `L: 9007199254740993, 3.4028235e38, NaN, Infinity | T: `, 'update/zod,valibot,typebox': `L: 9007199254740993, 3.4028235e38, NaN, Infinity | T: `, 'update/arktype': `L: 9007199254740993, 3.4028235e38, Infinity | T: ` } },
  'mysql/m_real': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as pg/c_double; MySQL REAL is a synonym for DOUBLE', divergence: { '*/zod,typebox': `L: 9007199254740993, 3.4028235e38 | T: `, '*/valibot,arktype': `L: 9007199254740993, 3.4028235e38, Infinity | T: ` } },
  'mysql/m_double': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as pg/c_double', divergence: { '*/zod,typebox': `L: 9007199254740993, 3.4028235e38 | T: `, '*/valibot,arktype': `L: 9007199254740993, 3.4028235e38, Infinity | T: ` } },
  'sqlite/s_real': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as pg/c_double; SQLite REAL is an 8 byte IEEE float', divergence: { '*/zod,typebox': `L: 9007199254740993, 3.4028235e38 | T: `, '*/valibot,arktype': `L: 9007199254740993, 3.4028235e38, Infinity | T: ` } },
  // ---- binary and varbinary, where official refuses rows the server returns --------------------
  // Official emits `^[01]*$` capped at n for these columns on v1, which is a bit-string pattern on
  // a column holding arbitrary bytes, so it rejects every ordinary string MySQL hands back. Asked
  // of a live MySQL 8.4 through both majors: mysql2 hands up a Buffer and drizzle hands the
  // CONSUMER a string, value for value identical, with `instanceof Uint8Array` false on all four
  // builders. So DRZL emitting a plain string is the database's answer and official's pattern is
  // the divergence.
  //
  // `T:` stays empty and `L:` carries the load. DRZL is looser here and right, which is the
  // direction this ledger exists to record rather than forbid.
  //
  // Insert and update drop one value each against select, and that is the declared width doing its
  // job rather than noise: '3 emoji' is 12 bytes over a `binary(4)` and '5 emoji' is 20 over a
  // `varbinary(16)`, so DRZL refuses them on the way in and both sides agree.
  //
  // These were two typebox-only entries, because the `L:` half did not exist while DRZL emitted a
  // Uint8Array and refused everything. Widening them to every library is what this change forces.
  //
  // The typebox-only reason SURVIVES, on the `T:` half, and a first draft of this comment claimed
  // it had gone. The stage refuted that in one run: `L:` matched on all twelve pairings and typebox
  // still measured `T: []`. Official emits `Type.RegExp`, whose check runs `RegExp.prototype.test`
  // on the raw value, and `test` stringifies what it is given, so `[]` becomes '' and matches
  // `^[01]*$`. DRZL emits a `string` carrying a `pattern` and refuses a non-string before the
  // pattern is consulted. So typebox carries both halves and the other three carry only `L:`.
  'mysql/m_binary': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    why: 'official emits a bit-string pattern for a byte column and refuses the strings MySQL returns',
    divergence: {
      'select/typebox': `L: 3 emoji, 'zzz', 'a', 'x', '12.5' | T: []`,
      'select/zod,valibot,arktype': `L: 3 emoji, 'zzz', 'a', 'x', '12.5' | T: `,
      'insert,update/typebox': `L: 'zzz', 'a', 'x', '12.5' | T: []`,
      'insert,update/zod,valibot,arktype': `L: 'zzz', 'a', 'x', '12.5' | T: `,
    },
  },
  'mysql/m_varbinary': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    why: 'as mysql/m_binary',
    divergence: {
      'select/typebox': `L: 'hello', 5-char, 3 emoji, 5 emoji, 'not-a-uuid', 'zzz', 'a', 'happy', 'x', '2020-01-01', '12:00:00', '25:99:99', '999.999.999.999', '10.0.0.1', '12.5' | T: []`,
      'select/zod,valibot,arktype': `L: 'hello', 5-char, 3 emoji, 5 emoji, 'not-a-uuid', 'zzz', 'a', 'happy', 'x', '2020-01-01', '12:00:00', '25:99:99', '999.999.999.999', '10.0.0.1', '12.5' | T: `,
      'insert,update/typebox': `L: 'hello', 5-char, 3 emoji, 'not-a-uuid', 'zzz', 'a', 'happy', 'x', '2020-01-01', '12:00:00', '25:99:99', '999.999.999.999', '10.0.0.1', '12.5' | T: []`,
      'insert,update/zod,valibot,arktype': `L: 'hello', 5-char, 3 emoji, 'not-a-uuid', 'zzz', 'a', 'happy', 'x', '2020-01-01', '12:00:00', '25:99:99', '999.999.999.999', '10.0.0.1', '12.5' | T: `,
    },
  },
  // ---- the nullable table ---------------------------------------------------------------------
  // Every divergence below is the one its `notNull` twin in `matrix` already carries, measured
  // again through the wrapper each generator puts round a nullable column. That is the point: the
  // wrapping is where a constraint gets lost, and a signature identical to the twin's is the
  // evidence that nothing was lost. Three have no twin and they are the three CHECK columns,
  // because no column of `matrix` carries a CHECK.
  // Every arktype arm gains `Infinity` alone here, where `c_real` above diverges only on update:
  // the nullable wrapper makes all three modes union shaped, and official accepts NaN in all of
  // them. Same reason, wider reach.
  'pg/n_real': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as pg/c_real, through the nullable wrapper', divergence: { '*/zod,valibot,typebox': `L: 9000000, 2147483648, 9007199254740993, 3.4028235e38, NaN, Infinity | T: `, '*/arktype': `L: 9000000, 2147483648, 9007199254740993, 3.4028235e38, Infinity | T: ` } },
  'pg/c_bytea_null': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as pg/c_bytea, through the nullable wrapper', divergence: { '*/*': `L: Uint8Array | T: ` } },
  'pg/valibot/n_json': { libs: ['valibot'], modes: MODE_NAMES, why: 'as pg/valibot/c_json', divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` } },
  'pg/valibot/n_point': { libs: ['valibot'], modes: MODE_NAMES, why: 'as pg/valibot/c_point', divergence: { '*/*': `L:  | T: [1,2,3]` } },
  'pg/valibot/n_geometry': { libs: ['valibot'], modes: MODE_NAMES, why: 'as pg/valibot/c_geometry', divergence: { '*/*': `L:  | T: [1,2,3]` } },
  'pg/n_ts': {
    libs: LIB_NAMES,
    modes: WRITE,
    why: 'as pg/c_ts_d',
    divergence: {
      '*/zod': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101 | T: `,
      '*/valibot,arktype,typebox': `L: '2020-01-01', '2020-01-01T00:00:00Z' | T: `,
    },
  },
  // The first divergence in either pass that comes from a CHECK, because `matrix` carries none and
  // the `checked` table is not in this comparison. DRZL reads the constraint and emits it; no
  // first-party module reads one at all, so official accepts values the column cannot hold.
  //
  // The database is the arbiter and it has already answered, in this same script: the CHECK
  // ground-truth stage runs 53 probes against a real Postgres over the `checked` table and reports
  // rows Postgres rejects and the validator accepts as DRZL 0, drizzle-orm 22.
  //
  // `BETWEEN 18 AND 100` rather than a one-sided bound, and the reason is the ledger rather than
  // the coverage: on SQLite a one-sided `>= 18` leaves the column's own upper bound in place, and
  // that upper bound is a filed defect on 0.4x, so the column carried a deliberate difference and a
  // defect at once and could not go in one map honestly. A two-sided CHECK replaces both bounds and
  // leaves this entry about the CHECK alone.
  'pg/n_check': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'DRZL enforces the column CHECK; no first-party module reads one', divergence: { '*/*': `L:  | T: 0, 1, -1, 200, 40000, 9000000, 1900, 2000, 2500, 17, 101` } },
  'mysql/m_n_text': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as mysql/m_text', divergence: { '*/*': `L:  | T: 22000 cjk` } },
  'mysql/m_n_tinytext': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as mysql/m_tinytext', divergence: { '*/*': `L:  | T: 100 emoji` } },
  'mysql/m_n_float': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as mysql/m_float', divergence: { '*/*': `L: 9000000, 2147483648, 9007199254740993 | T: ` } },
  'mysql/valibot/m_n_json': { libs: ['valibot'], modes: MODE_NAMES, why: 'as pg/valibot/c_json', divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` } },
  'mysql/m_n_datetime': {
    libs: LIB_NAMES,
    modes: WRITE,
    why: 'as pg/c_date_d',
    divergence: {
      '*/zod': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101 | T: `,
      '*/valibot,arktype,typebox': `L: '2020-01-01', '2020-01-01T00:00:00Z' | T: `,
    },
  },
  'mysql/m_n_check': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as pg/n_check, in MySQL spelling', divergence: { '*/*': `L:  | T: 0, 1, -1, 200, 40000, 9000000, 1900, 2000, 2500, 17, 101` } },
  'sqlite/s_n_real': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as sqlite/s_real', divergence: { '*/zod,typebox': `L: 9007199254740993, 3.4028235e38 | T: `, '*/valibot,arktype': `L: 9007199254740993, 3.4028235e38, Infinity | T: ` } },
  'sqlite/s_n_blob': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as sqlite/s_blob_buf', divergence: { '*/*': `L: Uint8Array | T: ` } },
  'sqlite/valibot/s_n_json': { libs: ['valibot'], modes: MODE_NAMES, why: 'as pg/valibot/c_json', divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` } },
  'sqlite/s_n_ts': {
    libs: LIB_NAMES,
    modes: WRITE,
    why: 'as sqlite/s_int_ts',
    divergence: {
      '*/zod': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101 | T: `,
      '*/valibot,arktype,typebox': `L: '2020-01-01', '2020-01-01T00:00:00Z' | T: `,
    },
  },
  'sqlite/s_n_ts_ms': {
    libs: LIB_NAMES,
    modes: WRITE,
    why: 'as sqlite/s_int_ts_ms',
    divergence: {
      '*/zod': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101 | T: `,
      '*/valibot,arktype,typebox': `L: '2020-01-01', '2020-01-01T00:00:00Z' | T: `,
    },
  },
  'sqlite/s_n_check': { libs: LIB_NAMES, modes: MODE_NAMES, why: "as pg/n_check; the extra label is official's SQLite integer bound being the safe-integer range where its Postgres one is int32", divergence: { '*/*': `L:  | T: 0, 1, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, 17, 101` } },

  // No arktype bigint entry. There were three, reading "ArkType cannot bound a bigint in its
  // string DSL", and only half of that was true: the DSL cannot state the bound, but a narrow can,
  // and this generator already used narrows for every character cap. The generator now bounds
  // bigint columns and all four agree.
  //
  // That trio used to be described here as the one place in this whole gate where DRZL was looser
  // than the first-party module. It never was: the run counts the waivers where DRZL accepts
  // something official refuses and prints the number, and it is most of them. What made those
  // three worth fixing rather than waiving is that no int64 column can hold the value they let
  // through.
};

const usedWaivers = new Set<string>();
// What each waiver actually suppressed, keyed waiver then `<mode>/<library>`, so the declaration
// above can be compared with the run rather than merely counted.
const waived = new Map<string, Map<string, string>>();
const allowed = (dialect: string, lib: string, col: string, mode: string, signature: string) => {
  for (const key of [`${dialect}/${lib}/${col}`, `${dialect}/${col}`]) {
    if (!ALLOWED[key]) continue;
    usedWaivers.add(key);
    const seen = waived.get(key) ?? new Map<string, string>();
    seen.set(`${mode}/${lib}`, signature);
    waived.set(key, seen);
    return ALLOWED[key].why;
  }
  return undefined;
};

/**
 * Presence differences that are deliberate: DRZL and official disagree about whether a key may be
 * missing, and DRZL is right to.
 *
 * A separate map from ALLOWED because it answers a separate question and its signature has a
 * separate shape: `official <optional|required>, DRZL <the same two>`, one per pairing. Keyed and
 * asserted exactly like ALLOWED, in both directions, so an entry that suppresses nothing fails and
 * an entry whose pairings have moved fails with the measured reading printed.
 */
const PRESENCE_ALLOWED: Record<string, Waiver> = {};

/**
 * Where the presence axis cannot read a side at all, because that side's schema for the column
 * accepts nothing in the pool and so no object satisfying it exists.
 *
 * One entry, and it is the same fact `ALLOWED[pg/typebox/c_uuid]` already records from the other
 * end: official emits `Type.String({ format: 'uuid' })`, TypeBox fails a format it has no entry
 * for, and no `FormatRegistry` is populated here. So that field refuses every value including a
 * valid uuid, which is what makes DRZL's pattern the usable one and what makes this pairing
 * unreadable. On select and insert the column is required, so the whole object goes with it; on
 * update it is optional and only that one column is lost.
 *
 * Keyed `<dialect>/<library>/<column>` and asserted in both directions: an undeclared barren column
 * fails, and a declaration that stops being barren fails too.
 */
const PRESENCE_BARREN: Record<string, string> = {
  'pg/typebox/c_uuid': "official's Type.String({ format: 'uuid' }) refuses every value with no FormatRegistry",
};
const usedBarren = new Set<string>();
let presenceUnreadable = 0;

/**
 * The absolute half of the presence axis: on `select`, DRZL's own schema has to require every key.
 *
 * The comparison above is differential and can only see DRZL and official disagreeing. It cannot
 * see them agreeing about something wrong, and on this major that is the only state this defect
 * comes in: for a nullable column the analyzer cannot name, both sides emit
 * `Type.Union([Type.Unknown(), Type.Null()])`, whose key TypeBox lets go missing, so a row that
 * never mentioned the column validates against both. Measured on `drizzle-orm/typebox-legacy`
 * 1.0.0-rc.4 and on DRZL's output for the same column, side by side:
 *
 *   official `s_n_custom`  {"anyOf":[{},{"type":"null"}]}   the key omitted   accepted
 *   DRZL     `s_n_custom`  {"anyOf":[{},{"type":"null"}]}   the key omitted   accepted
 *   either one with `s_n_ts_ms` omitted instead                               refused
 *
 * A select row always carries every column, so an optional key there is wrong however many
 * libraries agree about it. Keyed `<dialect>/<library>/<column>`, asserted in both directions: an
 * undeclared optional select key fails, and a declaration whose key is required now fails too.
 *
 * Only TypeBox reaches it. zod, valibot and arktype all keep the key required for their own
 * nullable unknown, which this run measures rather than assumes, since an entry naming one of them
 * would go dead.
 */
const SELECT_OPTIONAL: Record<string, string> = {
  'sqlite/typebox/s_n_custom': 'a nullable customType is unknown on both majors, and official emits the same union',
};
const usedSelectOptional = new Set<string>();
const selectOptionalProblems: string[] = [];

/**
 * How far the check above actually reached, declared and asserted in both directions.
 *
 * An absolute check has no second side to disagree with it, so a shrinking reach is invisible in
 * its own output: it inspects fewer schemas, finds nothing, and prints the same line. Measured
 * rather than feared. Making DRZL's Postgres TypeBox `SelectmatrixSchema` barren at `c_uuid`, the
 * column `PRESENCE_BARREN` already declares on official's side, drops all 40 of that pairing's keys
 * out of the absolute check, and it hid a `c_text` key made optional in the same edit. Every
 * presence counter and the `N column(s) whose key ...` line were byte identical to a clean run.
 *
 * So the reach is a declaration like any other. `SCHEMAS` is every `<dialect>/<table>/<library>`
 * whose select schema yielded at least one key to inspect, and `KEYS` is how many keys that was.
 * Both are measured by the run and compared with these, so examining fewer fails and examining more
 * fails too.
 */
// 24 is three dialects times two tables times four libraries, and 504 is every column of all six
// tables in each of the four. Nothing is lost to a crash here: the omissions that crash do so on
// official's side, and this check reads DRZL's alone.
const SELECT_REACH = { schemas: 24, keys: 504 };
const selectSchemas = new Set<string>();
let selectKeysInspected = 0;

const usedPresenceWaivers = new Set<string>();
const presenceWaived = new Map<string, Map<string, string>>();
const presenceAllowed = (dialect: string, lib: string, col: string, mode: string, signature: string) => {
  for (const key of [`${dialect}/${lib}/${col}`, `${dialect}/${col}`]) {
    if (!PRESENCE_ALLOWED[key]) continue;
    usedPresenceWaivers.add(key);
    const seen = presenceWaived.get(key) ?? new Map<string, string>();
    seen.set(`${mode}/${lib}`, signature);
    presenceWaived.set(key, seen);
    return PRESENCE_ALLOWED[key].why;
  }
  return undefined;
};

/**
 * Cross-generator gaps that follow from what each library can express, not from a defect in one
 * generator. Keyed `<dialect>/<column>` and carrying its reason, for the same reason ALLOWED is.
 */
/**
 * A difference between DRZL's own four generators that is deliberate.
 *
 * `modes` rather than three keys per column, because the same difference usually holds in all
 * three and a key per mode would say it three times and rot in three places. It is asserted
 * exactly, like every other ledger here: a mode that diverges and is not declared is a finding,
 * and a declared mode that does not diverge fails the run.
 */
type CrossWaiver = { modes: string[]; why: string; divergence: Record<string, string> };

const CROSS_ALLOWED: Record<string, CrossWaiver> = {
  // ArkType's string DSL has no recursive JSON value, so this generator emits
  // `number | object | string | boolean | null`, which takes NaN, Infinity and any object at all.
  // The other three build a real JSON value check. A capability difference between the libraries:
  // official `drizzle-orm/arktype` produces the same widening, which is why this shows up here and
  // not against official.
  //
  // The signature is what each of these actually suppresses, and it is identical on all seven:
  // five values, arktype alone accepting each. Before it was here, `crossAllowed` discarded every
  // row for its column whatever the rows said, so making DRZL's typebox `c_jsonb` reject `{}` was
  // absorbed and the stage still printed that all four generators agree on every column and value.
  'pg/c_json': { modes: ['select', 'insert', 'update'], why: "arktype's string DSL cannot state a recursive JSON value", divergence: { '*': `NaN: arktype accept, zod/valibot/typebox reject; Infinity: arktype accept, zod/valibot/typebox reject; Date: arktype accept, zod/valibot/typebox reject; Buffer: arktype accept, zod/valibot/typebox reject; Uint8Array: arktype accept, zod/valibot/typebox reject` } },
  'pg/c_jsonb': { modes: ['select', 'insert', 'update'], why: 'as pg/c_json', divergence: { '*': `NaN: arktype accept, zod/valibot/typebox reject; Infinity: arktype accept, zod/valibot/typebox reject; Date: arktype accept, zod/valibot/typebox reject; Buffer: arktype accept, zod/valibot/typebox reject; Uint8Array: arktype accept, zod/valibot/typebox reject` } },
  'pg/c_jsonb_typed': { modes: ['select', 'insert', 'update'], why: 'as pg/c_json', divergence: { '*': `NaN: arktype accept, zod/valibot/typebox reject; Infinity: arktype accept, zod/valibot/typebox reject; Date: arktype accept, zod/valibot/typebox reject; Buffer: arktype accept, zod/valibot/typebox reject; Uint8Array: arktype accept, zod/valibot/typebox reject` } },
  'mysql/m_json': { modes: ['select', 'insert', 'update'], why: 'as pg/c_json', divergence: { '*': `NaN: arktype accept, zod/valibot/typebox reject; Infinity: arktype accept, zod/valibot/typebox reject; Date: arktype accept, zod/valibot/typebox reject; Buffer: arktype accept, zod/valibot/typebox reject; Uint8Array: arktype accept, zod/valibot/typebox reject` } },
  'sqlite/s_text_json': { modes: ['select', 'insert', 'update'], why: 'as pg/c_json', divergence: { '*': `NaN: arktype accept, zod/valibot/typebox reject; Infinity: arktype accept, zod/valibot/typebox reject; Date: arktype accept, zod/valibot/typebox reject; Buffer: arktype accept, zod/valibot/typebox reject; Uint8Array: arktype accept, zod/valibot/typebox reject` } },
  'sqlite/s_blob_json': { modes: ['select', 'insert', 'update'], why: 'as pg/c_json', divergence: { '*': `NaN: arktype accept, zod/valibot/typebox reject; Infinity: arktype accept, zod/valibot/typebox reject; Date: arktype accept, zod/valibot/typebox reject; Buffer: arktype accept, zod/valibot/typebox reject; Uint8Array: arktype accept, zod/valibot/typebox reject` } },
  'sqlite/s_blob': { modes: ['select', 'insert', 'update'], why: 'as pg/c_json; a bare blob() is Drizzle json mode', divergence: { '*': `NaN: arktype accept, zod/valibot/typebox reject; Infinity: arktype accept, zod/valibot/typebox reject; Date: arktype accept, zod/valibot/typebox reject; Buffer: arktype accept, zod/valibot/typebox reject; Uint8Array: arktype accept, zod/valibot/typebox reject` } },
  // The four generators split on `Infinity` for every 8 byte float column, and only since those
  // columns stopped carrying a magnitude bound. That is not a difference in what DRZL asked for:
  // all four are handed the same column, with `integer: false` and no range, and `z.number()` and
  // `Type.Number()` refuse a non-finite number on their own while `v.number()` and arktype's
  // `number` accept one. Postgres stores and returns Infinity in `real` and `double precision`
  // alike, so valibot and arktype are the two that agree with the database here.
  //
  // No `real` entry: the float4 bound refuses Infinity in all four, so they agree there for a
  // reason that has nothing to do with the libraries.
  'mysql/m_real': { modes: ['select', 'insert', 'update'], why: 'as pg/c_double', divergence: { 'select': `Infinity: valibot/arktype accept, zod/typebox reject`, 'insert': `Infinity: valibot/arktype accept, zod/typebox reject`, 'update': `NaN: arktype accept, zod/valibot/typebox reject; Infinity: valibot/arktype accept, zod/typebox reject` } },
  'mysql/m_double': { modes: ['select', 'insert', 'update'], why: 'as pg/c_double', divergence: { 'select': `Infinity: valibot/arktype accept, zod/typebox reject`, 'insert': `Infinity: valibot/arktype accept, zod/typebox reject`, 'update': `NaN: arktype accept, zod/valibot/typebox reject; Infinity: valibot/arktype accept, zod/typebox reject` } },
  'sqlite/s_real': { modes: ['select', 'insert', 'update'], why: 'as pg/c_double', divergence: { 'select': `Infinity: valibot/arktype accept, zod/typebox reject`, 'insert': `Infinity: valibot/arktype accept, zod/typebox reject`, 'update': `NaN: arktype accept, zod/valibot/typebox reject; Infinity: valibot/arktype accept, zod/typebox reject` } },
  // The same two splits on the nullable table, which is what says the wrapper each generator puts
  // round a nullable column does not change which library can express what.
  'pg/n_json': { modes: ['select', 'insert', 'update'], why: 'as pg/c_json', divergence: { '*': `NaN: arktype accept, zod/valibot/typebox reject; Infinity: arktype accept, zod/valibot/typebox reject; Date: arktype accept, zod/valibot/typebox reject; Buffer: arktype accept, zod/valibot/typebox reject; Uint8Array: arktype accept, zod/valibot/typebox reject` } },
  'mysql/m_n_json': { modes: ['select', 'insert', 'update'], why: 'as pg/c_json', divergence: { '*': `NaN: arktype accept, zod/valibot/typebox reject; Infinity: arktype accept, zod/valibot/typebox reject; Date: arktype accept, zod/valibot/typebox reject; Buffer: arktype accept, zod/valibot/typebox reject; Uint8Array: arktype accept, zod/valibot/typebox reject` } },
  'sqlite/s_n_json': { modes: ['select', 'insert', 'update'], why: 'as pg/c_json', divergence: { '*': `NaN: arktype accept, zod/valibot/typebox reject; Infinity: arktype accept, zod/valibot/typebox reject; Date: arktype accept, zod/valibot/typebox reject; Buffer: arktype accept, zod/valibot/typebox reject; Uint8Array: arktype accept, zod/valibot/typebox reject` } },
  /**
   * A split that exists on the nullable path and on no other, which is the whole reason this table
   * is here. ArkType's `number` refuses NaN, and `number | null` accepts it. Four measurements,
   * on arktype directly rather than through anything DRZL emits:
   *
   *   type('number')(NaN)                             rejected
   *   type('(number | null)')(NaN)                    accepted
   *   type('-100 <= number <= 100')(NaN)              rejected
   *   type('(-100 <= number <= 100 | null)')(NaN)     accepted
   *
   * So a bound does not hold it back and the union is what admits it. `number.integer | null` still
   * refuses NaN, which is why the nullable integer columns do not split.
   *
   * This is not DRZL asking for something odd, and the parity pass proves it: official's own
   * `drizzle-orm/arktype` produces the same acceptance, so `n_real` reports parity against official
   * on arktype while disagreeing with its three siblings here.
   *
   * The database is on arktype's side. Asked through PGlite: `NaN` inserts into `real` and into
   * `double precision`, and is refused by `integer` with 22P02. So the three that reject it are the
   * strict ones, exactly as with `Infinity` on the 8 byte floats above, and the honest description
   * of a Postgres float column still needs a union in every generator rather than a range.
   */
  'mysql/m_n_float': { modes: ['select', 'insert', 'update'], why: 'as pg/n_real', divergence: { '*': `NaN: arktype accept, zod/valibot/typebox reject` } },
  'sqlite/s_n_real': { modes: ['select', 'insert', 'update'], why: 'as pg/n_real on NaN, and as pg/c_double on Infinity, which no bound holds back here', divergence: { '*': `NaN: arktype accept, zod/valibot/typebox reject; Infinity: valibot/arktype accept, zod/typebox reject` } },
  // No bigint entry either, for the reason given in ALLOWED: arktype now bounds a bigint with a
  // narrow, so the four generators agree about `c_bigint_b`, `m_bigint_b` and `s_blob_bigint`.
  // No `c_char` entry. There was one, reading "zod and valibot count code points; TypeBox and
  // ArkType count UTF-16 units", and it had been dead since arktype and typebox were changed to
  // count code points as well. All four now emit a `[...v].length` predicate and agree on every
  // probe including astral text, so there is nothing to waive. It survived because the waiver was
  // marked used by the column merely existing; see the note at the crossAllowed call site.
};


/**
 * Differences between DRZL's own four generators that are defects rather than choices.
 *
 * Same shape and same both-directions assertion as CROSS_ALLOWED, kept apart from it for the
 * reason the round-trip stage keeps its two ledgers apart: that one says the difference is
 * intended, this one says it is a bug nobody has fixed yet. A pin here that stops firing fails the
 * run, which is how the fix reports itself.
 *
 * Every entry is the same defect. `coerceDates` is documented as accepting a date string or an
 * epoch number on write, and only the zod generator has a number branch at all; the other three
 * never had one. So every date and timestamp column takes an epoch number in one of four
 * generators and refuses it in the other three, on insert and on update alike, and which of your
 * schemas accepts `Date.now()` depends on which validator you chose.
 *
 * Invisible until this pass read the write modes (BB). It was noticed during an unrelated change
 * and confirmed by re-measuring on master rather than deduced from a diff, but nothing in the gate
 * could see it: select mode has no coercion, so all four agreed there. Filed as BC.
 */
const CROSS_DEFECTS: Record<string, CrossWaiver> = {
  // Not the same defect as the rest of this ledger, and not a waiver either. ArkType's optional
  // union arm accepts NaN where its bare `number` refuses one, which is the behaviour the
  // `pg/n_real` waiver already documents for the nullable arm. There it is waived because Postgres
  // stores NaN in a float column, so accepting it is right. Here the database is MySQL, which
  // stores no NaN in any numeric column at all: measured against a real MySQL 8.4, `float` and
  // `double` reject it outright and `decimal` silently writes 0.00. So arktype alone accepts a
  // value the server will refuse, on update only, because that is the only mode whose fields are
  // optional. Filed as BD.
  'mysql/m_float': { modes: ['update'], why: 'arktype accepts NaN through the optional union arm; MySQL stores no NaN in any numeric column', divergence: { '*': `NaN: arktype accept, zod/valibot/typebox reject` } },
  'pg/c_date_d': { modes: ['insert', 'update'], why: 'coerceDates takes an epoch number in the zod arm alone; the other three have no number branch', divergence: { '*': `0: zod accept, valibot/arktype/typebox reject; 1: zod accept, valibot/arktype/typebox reject; 1.5: zod accept, valibot/arktype/typebox reject; -1: zod accept, valibot/arktype/typebox reject; 200: zod accept, valibot/arktype/typebox reject; 40000: zod accept, valibot/arktype/typebox reject; 9000000: zod accept, valibot/arktype/typebox reject; 2147483648: zod accept, valibot/arktype/typebox reject; 1900: zod accept, valibot/arktype/typebox reject; 2000: zod accept, valibot/arktype/typebox reject; 2500: zod accept, valibot/arktype/typebox reject; 17: zod accept, valibot/arktype/typebox reject; 18: zod accept, valibot/arktype/typebox reject; 50: zod accept, valibot/arktype/typebox reject; 100: zod accept, valibot/arktype/typebox reject; 101: zod accept, valibot/arktype/typebox reject` } },
  'mysql/m_date': { modes: ['insert', 'update'], why: 'as pg/c_date_d', divergence: { '*': `0: zod accept, valibot/arktype/typebox reject; 1: zod accept, valibot/arktype/typebox reject; 1.5: zod accept, valibot/arktype/typebox reject; -1: zod accept, valibot/arktype/typebox reject; 200: zod accept, valibot/arktype/typebox reject; 40000: zod accept, valibot/arktype/typebox reject; 9000000: zod accept, valibot/arktype/typebox reject; 2147483648: zod accept, valibot/arktype/typebox reject; 1900: zod accept, valibot/arktype/typebox reject; 2000: zod accept, valibot/arktype/typebox reject; 2500: zod accept, valibot/arktype/typebox reject; 17: zod accept, valibot/arktype/typebox reject; 18: zod accept, valibot/arktype/typebox reject; 50: zod accept, valibot/arktype/typebox reject; 100: zod accept, valibot/arktype/typebox reject; 101: zod accept, valibot/arktype/typebox reject` } },
  'mysql/m_datetime': { modes: ['insert', 'update'], why: 'as pg/c_date_d', divergence: { '*': `0: zod accept, valibot/arktype/typebox reject; 1: zod accept, valibot/arktype/typebox reject; 1.5: zod accept, valibot/arktype/typebox reject; -1: zod accept, valibot/arktype/typebox reject; 200: zod accept, valibot/arktype/typebox reject; 40000: zod accept, valibot/arktype/typebox reject; 9000000: zod accept, valibot/arktype/typebox reject; 2147483648: zod accept, valibot/arktype/typebox reject; 1900: zod accept, valibot/arktype/typebox reject; 2000: zod accept, valibot/arktype/typebox reject; 2500: zod accept, valibot/arktype/typebox reject; 17: zod accept, valibot/arktype/typebox reject; 18: zod accept, valibot/arktype/typebox reject; 50: zod accept, valibot/arktype/typebox reject; 100: zod accept, valibot/arktype/typebox reject; 101: zod accept, valibot/arktype/typebox reject` } },
  'mysql/m_n_datetime': { modes: ['insert', 'update'], why: 'as pg/c_date_d', divergence: { '*': `0: zod accept, valibot/arktype/typebox reject; 1: zod accept, valibot/arktype/typebox reject; 1.5: zod accept, valibot/arktype/typebox reject; -1: zod accept, valibot/arktype/typebox reject; 200: zod accept, valibot/arktype/typebox reject; 40000: zod accept, valibot/arktype/typebox reject; 9000000: zod accept, valibot/arktype/typebox reject; 2147483648: zod accept, valibot/arktype/typebox reject; 1900: zod accept, valibot/arktype/typebox reject; 2000: zod accept, valibot/arktype/typebox reject; 2500: zod accept, valibot/arktype/typebox reject; 17: zod accept, valibot/arktype/typebox reject; 18: zod accept, valibot/arktype/typebox reject; 50: zod accept, valibot/arktype/typebox reject; 100: zod accept, valibot/arktype/typebox reject; 101: zod accept, valibot/arktype/typebox reject` } },
  'mysql/m_ts': { modes: ['insert', 'update'], why: 'as pg/c_date_d', divergence: { '*': `0: zod accept, valibot/arktype/typebox reject; 1: zod accept, valibot/arktype/typebox reject; 1.5: zod accept, valibot/arktype/typebox reject; -1: zod accept, valibot/arktype/typebox reject; 200: zod accept, valibot/arktype/typebox reject; 40000: zod accept, valibot/arktype/typebox reject; 9000000: zod accept, valibot/arktype/typebox reject; 2147483648: zod accept, valibot/arktype/typebox reject; 1900: zod accept, valibot/arktype/typebox reject; 2000: zod accept, valibot/arktype/typebox reject; 2500: zod accept, valibot/arktype/typebox reject; 17: zod accept, valibot/arktype/typebox reject; 18: zod accept, valibot/arktype/typebox reject; 50: zod accept, valibot/arktype/typebox reject; 100: zod accept, valibot/arktype/typebox reject; 101: zod accept, valibot/arktype/typebox reject` } },
  'pg/c_ts_d': { modes: ['insert', 'update'], why: 'as pg/c_date_d', divergence: { '*': `0: zod accept, valibot/arktype/typebox reject; 1: zod accept, valibot/arktype/typebox reject; 1.5: zod accept, valibot/arktype/typebox reject; -1: zod accept, valibot/arktype/typebox reject; 200: zod accept, valibot/arktype/typebox reject; 40000: zod accept, valibot/arktype/typebox reject; 9000000: zod accept, valibot/arktype/typebox reject; 2147483648: zod accept, valibot/arktype/typebox reject; 1900: zod accept, valibot/arktype/typebox reject; 2000: zod accept, valibot/arktype/typebox reject; 2500: zod accept, valibot/arktype/typebox reject; 17: zod accept, valibot/arktype/typebox reject; 18: zod accept, valibot/arktype/typebox reject; 50: zod accept, valibot/arktype/typebox reject; 100: zod accept, valibot/arktype/typebox reject; 101: zod accept, valibot/arktype/typebox reject` } },
  'pg/n_ts': { modes: ['insert', 'update'], why: 'as pg/c_date_d', divergence: { '*': `0: zod accept, valibot/arktype/typebox reject; 1: zod accept, valibot/arktype/typebox reject; 1.5: zod accept, valibot/arktype/typebox reject; -1: zod accept, valibot/arktype/typebox reject; 200: zod accept, valibot/arktype/typebox reject; 40000: zod accept, valibot/arktype/typebox reject; 9000000: zod accept, valibot/arktype/typebox reject; 2147483648: zod accept, valibot/arktype/typebox reject; 1900: zod accept, valibot/arktype/typebox reject; 2000: zod accept, valibot/arktype/typebox reject; 2500: zod accept, valibot/arktype/typebox reject; 17: zod accept, valibot/arktype/typebox reject; 18: zod accept, valibot/arktype/typebox reject; 50: zod accept, valibot/arktype/typebox reject; 100: zod accept, valibot/arktype/typebox reject; 101: zod accept, valibot/arktype/typebox reject` } },
  'sqlite/s_int_ts': { modes: ['insert', 'update'], why: 'as pg/c_date_d', divergence: { '*': `0: zod accept, valibot/arktype/typebox reject; 1: zod accept, valibot/arktype/typebox reject; 1.5: zod accept, valibot/arktype/typebox reject; -1: zod accept, valibot/arktype/typebox reject; 200: zod accept, valibot/arktype/typebox reject; 40000: zod accept, valibot/arktype/typebox reject; 9000000: zod accept, valibot/arktype/typebox reject; 2147483648: zod accept, valibot/arktype/typebox reject; 1900: zod accept, valibot/arktype/typebox reject; 2000: zod accept, valibot/arktype/typebox reject; 2500: zod accept, valibot/arktype/typebox reject; 17: zod accept, valibot/arktype/typebox reject; 18: zod accept, valibot/arktype/typebox reject; 50: zod accept, valibot/arktype/typebox reject; 100: zod accept, valibot/arktype/typebox reject; 101: zod accept, valibot/arktype/typebox reject` } },
  'sqlite/s_int_ts_ms': { modes: ['insert', 'update'], why: 'as pg/c_date_d', divergence: { '*': `0: zod accept, valibot/arktype/typebox reject; 1: zod accept, valibot/arktype/typebox reject; 1.5: zod accept, valibot/arktype/typebox reject; -1: zod accept, valibot/arktype/typebox reject; 200: zod accept, valibot/arktype/typebox reject; 40000: zod accept, valibot/arktype/typebox reject; 9000000: zod accept, valibot/arktype/typebox reject; 2147483648: zod accept, valibot/arktype/typebox reject; 1900: zod accept, valibot/arktype/typebox reject; 2000: zod accept, valibot/arktype/typebox reject; 2500: zod accept, valibot/arktype/typebox reject; 17: zod accept, valibot/arktype/typebox reject; 18: zod accept, valibot/arktype/typebox reject; 50: zod accept, valibot/arktype/typebox reject; 100: zod accept, valibot/arktype/typebox reject; 101: zod accept, valibot/arktype/typebox reject` } },
  'sqlite/s_n_ts': { modes: ['insert', 'update'], why: 'as pg/c_date_d', divergence: { '*': `0: zod accept, valibot/arktype/typebox reject; 1: zod accept, valibot/arktype/typebox reject; 1.5: zod accept, valibot/arktype/typebox reject; -1: zod accept, valibot/arktype/typebox reject; 200: zod accept, valibot/arktype/typebox reject; 40000: zod accept, valibot/arktype/typebox reject; 9000000: zod accept, valibot/arktype/typebox reject; 2147483648: zod accept, valibot/arktype/typebox reject; 1900: zod accept, valibot/arktype/typebox reject; 2000: zod accept, valibot/arktype/typebox reject; 2500: zod accept, valibot/arktype/typebox reject; 17: zod accept, valibot/arktype/typebox reject; 18: zod accept, valibot/arktype/typebox reject; 50: zod accept, valibot/arktype/typebox reject; 100: zod accept, valibot/arktype/typebox reject; 101: zod accept, valibot/arktype/typebox reject` } },
  'sqlite/s_n_ts_ms': { modes: ['insert', 'update'], why: 'as pg/c_date_d', divergence: { '*': `0: zod accept, valibot/arktype/typebox reject; 1: zod accept, valibot/arktype/typebox reject; 1.5: zod accept, valibot/arktype/typebox reject; -1: zod accept, valibot/arktype/typebox reject; 200: zod accept, valibot/arktype/typebox reject; 40000: zod accept, valibot/arktype/typebox reject; 9000000: zod accept, valibot/arktype/typebox reject; 2147483648: zod accept, valibot/arktype/typebox reject; 1900: zod accept, valibot/arktype/typebox reject; 2000: zod accept, valibot/arktype/typebox reject; 2500: zod accept, valibot/arktype/typebox reject; 17: zod accept, valibot/arktype/typebox reject; 18: zod accept, valibot/arktype/typebox reject; 50: zod accept, valibot/arktype/typebox reject; 100: zod accept, valibot/arktype/typebox reject; 101: zod accept, valibot/arktype/typebox reject` } },
};

const usedCrossWaivers = new Set<string>();
// What each cross-generator waiver actually discarded, so the declaration can be compared with the
// run. `crossAllowed` used to return a boolean and the caller threw the rows away unread.
const crossWaived = new Map<string, string>();
const crossAllowed = (dialect: string, mode: string, col: string, rows: string[]) => {
  const key = `${dialect}/${col}`;
  const entry = CROSS_ALLOWED[key] ?? CROSS_DEFECTS[key];
  // A mode the entry does not name is not covered by it. Falling through to a finding is the
  // fail-closed direction: the alternative lets a waiver written for one mode silently absorb a
  // difference in another, which is the shape of the defect that made this pass read all three.
  if (!entry || !entry.modes.includes(mode)) return false;
  usedCrossWaivers.add(key);
  // The column name is stripped so the signature reads as the difference rather than as the row.
  crossWaived.set(`${key}/${mode}`, rows.map((r) => r.trim().replace(`${col} on `, '')).join('; '));
  return true;
};

/**
 * Two tables per dialect, not one.
 *
 * `matrix` holds every column type and every one of them is `notNull`, so for as long as it was the
 * only table here the comparison covered 0 nullable columns of 83. `nullable` is the other half,
 * and it is a separate table for the reason it is a separate table in the fixture: the arktype
 * output for a 40-column table of narrowed fields is at the edge of TS2589.
 */
const DIALECTS = [
  {
    name: 'pg',
    libs: ['zod', 'valibot', 'arktype', 'typebox'],
    tables: [
      {
        name: 'matrix',
        table: pgTable,
        mods: {
          zod: () => import('./gen/pg/zod/matrix.zod.js'),
          valibot: () => import('./gen/pg/valibot/matrix.valibot.js'),
          arktype: () => import('./gen/pg/arktype/matrix.arktype.js'),
          typebox: () => import('./gen/pg/typebox/matrix.typebox.js'),
        } as Record<string, () => Promise<any>>,
      },
      {
        name: 'nullable',
        table: pgNullable,
        mods: {
          zod: () => import('./gen/pg/zod/nullable.zod.js'),
          valibot: () => import('./gen/pg/valibot/nullable.valibot.js'),
          arktype: () => import('./gen/pg/arktype/nullable.arktype.js'),
          typebox: () => import('./gen/pg/typebox/nullable.typebox.js'),
        } as Record<string, () => Promise<any>>,
      },
    ],
  },
  {
    name: 'mysql',
    libs: ['zod', 'valibot', 'arktype', 'typebox'],
    tables: [
      {
        name: 'matrix',
        table: myTable,
        mods: {
          zod: () => import('./gen/mysql/zod/matrix.zod.js'),
          valibot: () => import('./gen/mysql/valibot/matrix.valibot.js'),
          arktype: () => import('./gen/mysql/arktype/matrix.arktype.js'),
          typebox: () => import('./gen/mysql/typebox/matrix.typebox.js'),
        } as Record<string, () => Promise<any>>,
      },
      {
        name: 'nullable',
        table: myNullable,
        mods: {
          zod: () => import('./gen/mysql/zod/nullable.zod.js'),
          valibot: () => import('./gen/mysql/valibot/nullable.valibot.js'),
          arktype: () => import('./gen/mysql/arktype/nullable.arktype.js'),
          typebox: () => import('./gen/mysql/typebox/nullable.typebox.js'),
        } as Record<string, () => Promise<any>>,
      },
    ],
  },
  {
    name: 'sqlite',
    libs: ['zod', 'valibot', 'arktype', 'typebox'],
    tables: [
      {
        name: 'matrix',
        table: sqTable,
        mods: {
          zod: () => import('./gen/sqlite/zod/matrix.zod.js'),
          valibot: () => import('./gen/sqlite/valibot/matrix.valibot.js'),
          arktype: () => import('./gen/sqlite/arktype/matrix.arktype.js'),
          typebox: () => import('./gen/sqlite/typebox/matrix.typebox.js'),
        } as Record<string, () => Promise<any>>,
      },
      {
        name: 'nullable',
        table: sqNullable,
        mods: {
          zod: () => import('./gen/sqlite/zod/nullable.zod.js'),
          valibot: () => import('./gen/sqlite/valibot/nullable.valibot.js'),
          arktype: () => import('./gen/sqlite/arktype/nullable.arktype.js'),
          typebox: () => import('./gen/sqlite/typebox/nullable.typebox.js'),
        } as Record<string, () => Promise<any>>,
      },
    ],
  },
];

const PREFIX = { select: 'Select', insert: 'Insert', update: 'Update' } as const;
let findings = 0;

/**
 * Every column of every fixture, in every library and every mode: 40 + 18 Postgres, 29 + 12 MySQL
 * and 14 + 13 SQLite columns, `matrix` and `nullable`, times four libraries, times three modes.
 *
 * Written out rather than derived from the arrays above, which would make it true by construction
 * and say nothing. The 0.4x stage has carried this since it was written; this pass had only the
 * per-pairing guard, which cannot see a whole dialect quietly dropping out.
 */
const EXPECTED_COMPARISONS = (40 + 18 + 29 + 12 + 14 + 13) * 4 * 3;
let totalCompared = 0;
/**
 * The same denominator for the presence axis, counted separately.
 *
 * Presence is asked of the object and the value pool is asked of the field, so one can go quiet
 * while the other keeps reporting: the two counters are what makes that visible. This one is the
 * whole point of the axis, because the state it guards against is the one that existed before it,
 * where the number of optionality comparisons was zero and every pairing still printed `parity`.
 */
let presenceCompared = 0;
/** Column pairings the presence axis could not read because a side crashed on the omission. */
let presenceCrashed = 0;
const presenceProblems: string[] = [];
// Which sides crashed on an omission, keyed `<dialect>/<library>/<column>`, held to THREW below.
const presenceThrew = new Map<string, { sides: Set<string>; modes: Set<string> }>();
const recordPresenceCrash = (key: string, side: string, mode: string) => {
  const seen = presenceThrew.get(key) ?? { sides: new Set<string>(), modes: new Set<string>() };
  seen.sides.add(side);
  seen.modes.add(mode);
  presenceThrew.set(key, seen);
};

/**
 * Which drizzle-orm this tree actually resolved.
 *
 * Off disk rather than through `require.resolve`, whose `exports` map has no `./package.json`
 * entry. Asserted before a column is touched, for the reason the 0.4x stage asserts its own: the
 * cross-major diff compared 0.45.2 with 0.45.2 for a day and was green throughout, because the
 * version was believed rather than read. This pass pins v1 in its install line and had no check at
 * all, so the same install-line typo would have made it a second 0.4x pass measuring nothing new.
 */
const drizzleVersion = JSON.parse(readFileSync('node_modules/drizzle-orm/package.json', 'utf8')).version;
if (typeof drizzleVersion !== 'string' || drizzleVersion.split('.')[0] !== '1') {
  console.error(`FAIL: this tree resolves drizzle-orm ${JSON.stringify(drizzleVersion)}, not the v1 line.`);
  console.error('      The 0.4x parity stage near the end of this script measures the other major,');
  console.error('      and two passes over the same one would compare it twice and pass.');
  process.exit(1);
}
console.log(`    drizzle-orm ${drizzleVersion}, with its own zod, valibot, arktype and typebox-legacy modules`);

for (const d of DIALECTS) {
  const loaded: Record<string, Record<string, any>> = {};
  for (const t of d.tables) {
    loaded[t.name] = {};
    for (const lib of d.libs) loaded[t.name][lib] = await t.mods[lib]();
  }

  for (const t of d.tables) {
  for (const mode of ['select', 'insert', 'update'] as const) {
    for (const libName of d.libs) {
      const off = OFFICIAL[libName]?.[mode];
      if (!off) continue;
      const lib = LIBS[libName];
      const official = off(t.table as never);
      const mine = loaded[t.name][libName][`${PREFIX[mode]}${t.name}Schema`];
      if (!mine) {
        console.log(`    ${d.name}/${libName}/${mode}: no ${PREFIX[mode]}${t.name}Schema exported`);
        findings++;
        continue;
      }

      // Column names come from the zod schema regardless of library: every generator emits the
      // same set, and zod is the one whose shape is trivially enumerable.
      const oShape = OFFICIAL.zod[mode](t.table as never).shape;
      const rows: string[] = [];
      let waivedCount = 0;
      // Columns where both sides yielded a field and the pool was actually pushed through them.
      // Printing the shape's column count says how many columns *exist*, which is not the same
      // number and stayed reassuring in a run that compared none of them.
      let compared = 0;

      for (const k of Object.keys(oShape)) {
        const o = safeField(lib, official, k);
        const m = safeField(lib, mine, k);
        if (!o && !m) {
          // Never a skip. Both sides absent means this column was measured by nothing, and
          // `safeField` returns undefined for a lookup that threw as well as for one that was
          // missing, so the quiet version of this branch reported parity on an exception.
          rows.push(`        ${k}: neither official nor DRZL yielded a field, so nothing was compared`);
          continue;
        }
        if (!m) {
          if (allowed(d.name, libName, k, mode, 'official has it, DRZL omits it')) { waivedCount++; continue; }
          rows.push(`        ${k}: official has it, DRZL omits it`);
          continue;
        }
        if (!o) {
          if (allowed(d.name, libName, k, mode, 'DRZL has it, official omits it')) { waivedCount++; continue; }
          rows.push(`        ${k}: DRZL has it, official omits it`);
          continue;
        }
        compared++;
        const looser: string[] = [];
        const tighter: string[] = [];
        // What official accepted, in pool order. Only read when DRZL accepted everything, where it
        // is the complement of the divergence and so names it exactly.
        const officialAccepted: string[] = [];
        let officialTook = false;
        let drzlTook = false;
        // Whether DRZL took the whole pool, which is what the derived signature rests on.
        let drzlAll = true;
        for (const [label, x] of POOL) {
          const a: Verdict = probe(lib, o, x);
          const b: Verdict = probe(lib, m, x);
          // A crash is not a verdict, so this value is not compared for this column. It is
          // recorded and held to the THREW list above instead, which is what keeps it from being
          // an absence that reads as agreement.
          if (a === 'threw' || b === 'threw') {
            if (a === 'threw') recordThrow(`${d.name}/${libName}/${k}`, 'official', mode, label);
            if (b === 'threw') recordThrow(`${d.name}/${libName}/${k}`, 'drzl', mode, label);
            // Not compared, and not unmeasured either: DRZL's answer is pinned against the crash
            // entry below and arbitrated against a real database wherever one runs for this
            // dialect. Dropping it here and doing nothing else is what let a null-accepting insert
            // schema on a NOT NULL column sit under a green line.
            recordCrashVerdict(`${d.name}/${libName}/${k}`, mode, label, b);
            continue;
          }
          if (a === 'accept') officialAccepted.push(label);
          officialTook ||= a === 'accept';
          drzlTook ||= b === 'accept';
          if (b !== 'accept') drzlAll = false;
          if (a !== b) (b === 'accept' ? looser : tighter).push(label);
        }
        // A column both sides reject every probe for agrees perfectly and proves nothing: the two
        // schemas could be a correct one and a broken one and this loop could not tell them apart.
        // It is not hypothetical. `c_varchar_enum` accepts only 'x' or 'y' and `m_year` only
        // 1901..2155, and the pool held no member of either, so two columns had been sitting in
        // this comparison contributing a confident nothing. Deliberately outside the waiver check
        // below: a waiver says a difference is fine, not that a column need not be measured.
        if (!officialTook && !drzlTook) {
          rows.push(
            `        ${k}: neither side accepts any pool value, so this column proves nothing.` +
              `\n          Add a value this column accepts to POOL.`
          );
          continue;
        }
        if (!looser.length && !tighter.length) continue;
        const signature = drzlAll
          ? allProbes(looser.length, officialAccepted)
          : `L: ${looser.join(', ')} | T: ${tighter.join(', ')}`;
        if (allowed(d.name, libName, k, mode, signature)) { waivedCount++; continue; }
        rows.push(
          `        ${k}:` +
            (looser.length ? `\n          DRZL accepts, official rejects: ${looser.join(', ')}` : '') +
            (tighter.length ? `\n          DRZL rejects, official accepts: ${tighter.join(', ')}` : '')
        );
      }

      /**
       * The other axis: whether each side lets the key be missing.
       *
       * Kept apart from the pool loop above rather than folded into it as one more probe, because
       * an absence is not a value and the signatures in ALLOWED are lists of values. Folding it in
       * would also move the `every probe official rejects` shorthand on every column that carries
       * it, which describes what the two schemas do with the pool.
       */
      const oPres = askPresence(lib, official, Object.keys(oShape));
      const mPres = askPresence(lib, mine, Object.keys(oShape));
      const readSide = (r: typeof oPres, side: string) => {
        for (const k of r.barren) {
          const key = `${d.name}/${libName}/${k}`;
          if (PRESENCE_BARREN[key]) { usedBarren.add(key); continue; }
          presenceProblems.push(
            `${d.name}/${t.name}/${mode}/${libName} ${side} accepts no pool value for ${k}, so no ` +
              'object satisfying it can be built, and nothing declares that'
          );
        }
        // A control that failed with no barren column behind it is a state nothing here explains.
        if (r.control && !r.barren.length) {
          presenceProblems.push(`${d.name}/${t.name}/${mode}/${libName} ${side} ${r.control}`);
        }
      };
      readSide(oPres, 'official');
      readSide(mPres, 'DRZL');
      for (const k of oPres.crashed) recordPresenceCrash(`${d.name}/${libName}/${k}`, 'official', mode);
      for (const k of mPres.crashed) recordPresenceCrash(`${d.name}/${libName}/${k}`, 'drzl', mode);
      for (const k of Object.keys(oShape)) {
        const a = oPres.verdicts.get(k);
        const b = mPres.verdicts.get(k);
        // The absolute half, read off DRZL's side alone and before the two are compared: a select
        // schema that lets a key go missing is wrong even where official does the same thing, and
        // it is still wrong where official cannot answer at all. `pg/typebox/n_bit` on the 0.4x
        // pass is the second case: official crashes on that omission, so the comparison below has
        // no verdict to differ from and this line is the only thing that sees it.
        if (mode === 'select' && b) {
          // Counted where the check reads, so the two can never describe different sets.
          selectSchemas.add(`${d.name}/${t.name}/${libName}`);
          selectKeysInspected++;
          if (b === 'optional') {
            const key = `${d.name}/${libName}/${k}`;
            if (SELECT_OPTIONAL[key]) usedSelectOptional.add(key);
            else selectOptionalProblems.push(`${key}: DRZL's select schema lets this key be missing, and nothing declares it`);
          }
        }
        // Never a skip, and never silently: every column lands in exactly one of the three
        // counters, and the three have to add up to the pairing count further down.
        if (!a || !b) {
          if (oPres.crashed.includes(k) || mPres.crashed.includes(k)) presenceCrashed++;
          else presenceUnreadable++;
          continue;
        }
        presenceCompared++;
        if (a === b) continue;
        const signature = `official ${a}, DRZL ${b}`;
        if (presenceAllowed(d.name, libName, k, mode, signature)) { waivedCount++; continue; }
        rows.push(`        ${k}: the key is ${a} for official and ${b} for DRZL`);
      }

      totalCompared += compared;
      // A run that compared no column at all would otherwise print `parity` and pass. That is the
      // shape of failure this file has been bitten by most: the stage was green because it had
      // measured nothing, not because there was nothing to find.
      if (compared === 0) {
        rows.push('        no column was compared on both sides, so this pairing measured nothing');
      }

      console.log(
        `    ${d.name.padEnd(7)} ${t.name.padEnd(8)} ${libName.padEnd(8)} ${mode.padEnd(7)} ` +
          `${compared}/${Object.keys(oShape).length} cols compared  ${rows.length ? 'DIFFERS' : 'parity'}` +
          `${waivedCount ? ` (${waivedCount} waived)` : ''}`
      );
      if (rows.length) {
        console.log(rows.join('\n'));
        findings += rows.length;
      }
    }
  }
  }

  // Pass 2, on every dialect that has all four generators, which is now all three.
  //
  // All three modes, and it read `Select` and nothing else until a defect made the cost visible.
  // Three of the four generators accepted `'hello'` on a date column's insert schema while zod
  // refused it, which is precisely the internal inconsistency this pass exists to surface, and it
  // sat here silently because the divergence was write only. The file had even written the
  // limitation down, on the crash ledger, and demonstrated it by making the typebox Insert and
  // Update schemas accept `null` on a NOT NULL column and watching the run stay byte identical to
  // green. The observation was recorded and the consequence was not drawn (BB).
  if (d.libs.length === 4) {
    const disagreements: string[] = [];
    for (const mode of MODE_NAMES) {
    const Mode = mode[0].toUpperCase() + mode.slice(1);
    for (const t of d.tables) {
    // The mode's own column set, not select's. An insert schema drops generated columns, so
    // reading select's keys here would ask four generators about a field none of them emits and
    // report it as missing from all four.
    const oShape = (OFFICIAL.zod as any)[mode](t.table as never).shape;
    for (const k of Object.keys(oShape)) {
      const fields: Record<string, any> = {};
      for (const lib of d.libs) fields[lib] = safeField(LIBS[lib], loaded[t.name][lib][`${Mode}${t.name}Schema`], k);
      const found: string[] = [];
      const absent = Object.entries(fields).filter(([, f]) => !f).map(([n]) => n);
      if (absent.length) {
        found.push(`        ${k}: missing from ${absent.join(', ')}`);
      } else {
        for (const [label, x] of POOL) {
          // `undefined` is not asked here, and skipping it is not a gap: the presence axis above
          // asks the same question properly, of the object rather than of the field.
          //
          // Measured, because it produced 169 findings that were all representation and no
          // behaviour. An optional field is `z.optional(X)` in zod, valibot and arktype, so the
          // extracted field takes `undefined`; TypeBox marks optionality on the parent's property
          // and leaves `X` alone, so the extracted field refuses it. Both objects accept `{}`,
          // which is the fact that matters and the fact they agree on. Probing the field measures
          // where each library records optionality. It never showed on select because every
          // column there is required, so all four refused `undefined` and agreed by accident.
          if (label === 'undefined') continue;
          const verdicts = d.libs.map((n) => [n, probe(LIBS[n], fields[n], x)] as const);
          // A generator that crashed is not one that rejected. Recorded on the DRZL side, where
          // nothing is declared, so any crash out of DRZL's own output fails this script.
          for (const [n, r] of verdicts) {
            if (r === 'threw') recordThrow(`${d.name}/${n}/${k}`, 'drzl', mode, label);
          }
          const yes = verdicts.filter(([, r]) => r === 'accept').map(([n]) => n);
          const no = verdicts.filter(([, r]) => r === 'reject').map(([n]) => n);
          if (yes.length && no.length) {
            found.push(`        ${k} on ${label}: ${yes.join('/')} accept, ${no.join('/')} reject`);
          }
        }
      }
      if (!found.length) continue;
      // The waiver is consulted only once there is something for it to suppress. Asking first
      // marked the key used because the column exists in the fixture, which made the dead-waiver
      // check below true of `ALLOWED` and false of `CROSS_ALLOWED`: a waiver naming a real column
      // the four generators agree about sat there indefinitely, and `pg/c_char` was one.
      if (crossAllowed(d.name, mode, k, found)) continue;
      disagreements.push(...found.map((r) => r.replace(/^ {8}/, `        ${mode} `)));
    }
    }
    }
    // Printed rather than implied, because the line below used to claim universal agreement while
    // seven columns disagreed on five values each and were being discarded unread.
    const crossCols = [...crossWaived.keys()].filter((key) => key.startsWith(`${d.name}/`)).length;
    const crossHere = [...crossWaived.entries()]
      .filter(([key]) => key.startsWith(`${d.name}/`))
      .reduce((n, [, sig]) => n + sig.split('; ').length, 0);
    if (disagreements.length) {
      console.log(`    the four ${d.name} generators disagree with each other:`);
      console.log(disagreements.join('\n'));
      findings += disagreements.length;
    } else {
      console.log(
        `    all four ${d.name} generators agree with each other on every column and value, bar ` +
          `the ${crossHere} documented difference(s) on ${crossCols} column(s)`
      );
    }
  }
}

/**
 * The MySQL byte caps, bracketed rather than stepped past.
 *
 * Same stage as the 0.4x tree carries, and it is here because that one does not cover this pass:
 * it probes `src/gen-0-4x/mysql/*` against `drizzle-zod@0.8.3`, which is a different object twice
 * over. The v1 modules emit a character cap the 0.4x ones do not, and they are compared against
 * `drizzle-orm/zod`. A sentence in ALLOWED above used to say the 0.4x stage covered `mediumtext`
 * for this pass; it never did, and `m_mediumtext` was a live divergence sitting under a green
 * parity line the whole time.
 *
 * Two probes per column, not one. One string over the cap only ever proves the cap is below it, so
 * the single probe this replaced pinned `tinytext` to the interval [36, 257] rather than to 255:
 * 36 is the largest pool string under the cap and 257 is where a probe built out of three-byte
 * characters lands. Measured rather than reasoned, by moving the emitted cap and re-running: 257
 * and 36 both left this pass byte identical to green, 258 and 35 both failed it. The same
 * construction left `text` free over [400, 65537] and `mediumtext` over about 16.7 million values.
 *
 * The pair brackets it. `floor(cap/3)` three-byte characters plus `cap mod 3` ASCII ones is exactly
 * `cap` bytes and roughly a third of that in UTF-16 units, so DRZL has to take it; one more ASCII
 * character is exactly `cap + 1` bytes, so DRZL has to refuse it. Together they pin the byte cap to
 * a single value, and both stay far under any character cap, so neither is answering a question
 * about characters.
 *
 * A real MySQL 8.4.11 on a utf8mb4 client agrees with both halves, which is what makes them the
 * right expectations rather than today's behaviour written down: for `tinytext`, `text`, `blob` and
 * `mediumtext` alike, the at-cap string inserts and `octet_length` reads back exactly the cap,
 * while the one-byte-longer string fails with ERROR 1406 "Data too long".
 *
 * `longtext` has no probe at all, and CAP_COVERAGE below is where that is asserted rather than
 * described.
 *
 * `m_blob` is here and not on the 0.4x side because 0.45.2's mysql-core has no `blob` export, so
 * that fixture cannot carry the column.
 */
// Read off the runtime rather than written down, so a V8 with a different limit is described
// correctly instead of being asserted about.
const MAX_JS_STRING = constants.MAX_STRING_LENGTH;
const TEXT_CAPS: Record<string, number> = {
  m_tinytext: 255,
  m_text: 65535,
  m_mediumtext: 16777215,
  m_longtext: 4294967295,
  m_blob: 65535,
};

/**
 * Where each MySQL text column's byte cap is actually measured.
 *
 * Computed by this run and compared with the declaration in both directions, because a sentence
 * about who measures what is exactly the kind that goes quietly false. Two of them already have on
 * this branch, and the second was introduced by the fix for the first: one said the 0.4x stage
 * measured `mediumtext` for this pass, and its replacement said both pool-unreachable columns were
 * measured by the byte-cap stage. `m_longtext` is measured by nothing at all, and deleting every
 * one of its caps from all four generated modules in all three modes leaves both passes byte
 * identical to green.
 *
 * The two things that measure a cap do not measure the same amount of it, and the printed line used
 * to give each of them one word, so `the pool and the byte-cap stage` read as two measurements of
 * the cap when only one of them is. They are named apart now:
 *
 *   `separated`  the pool holds a string this column's byte cap refuses and its UTF-16 count does
 *                not, which is the only kind of string the parity comparison above can tell the two
 *                counts apart with. It does not pin the cap: moving `m_tinytext`'s emitted cap to
 *                254 or to 256 produces no failure from the pool at all, and its reach on that
 *                column starts at 400, where the 100-emoji probe stops being refused.
 *   `bracketed`  the pair below was built and pushed through, at the cap and one byte over, which
 *                does pin the cap to a single value.
 */
const CAP_COVERAGE: Record<string, string> = {
  m_tinytext: 'bracketed and separated',
  m_text: 'bracketed and separated',
  m_blob: 'bracketed and separated',
  m_mediumtext: 'bracketed only',
  m_longtext: 'neither',
};

const capProblems: string[] = [];
const capMeasured: string[] = [];
const capUnreachable: string[] = [];
{
  // The `matrix` table specifically: `m_tinytext` and its siblings are declared there, and the
  // `nullable` table's `m_n_tinytext` is a different column with its own cap. Named rather than
  // taken as the first table, so this stage cannot start measuring a different one by accident.
  const mysql = DIALECTS.find((d) => d.name === 'mysql');
  const mysqlMatrix = mysql?.tables.find((t) => t.name === 'matrix');
  if (!mysql || !mysqlMatrix) {
    capProblems.push('the MySQL matrix table is not in this pass, so no byte cap was measured');
  } else {
    const loaded: Record<string, any> = {};
    for (const lib of mysql.libs) loaded[lib] = await mysqlMatrix.mods[lib]();
    for (const [col, cap] of Object.entries(TEXT_CAPS)) {
      const wide = Math.floor(cap / 3);
      const rest = cap - wide * 3;
      const units = wide + rest;
      if (units + 1 > MAX_JS_STRING) {
        capUnreachable.push(`${col} (a probe needs ${units + 1} units, over this V8's ${MAX_JS_STRING})`);
        // UTF-8 spends at most 3 bytes per UTF-16 unit, checked over every code point, so no JS
        // string here can carry more than this many bytes. When that is under the cap the cap
        // cannot be exceeded at all, which is a stronger statement than this construction being
        // too long, and it is the one `longtext` is in. Anything else means a different
        // construction might reach the column and this list is hiding it.
        if (MAX_JS_STRING * 3 >= cap) {
          capProblems.push(
            `${col} is listed as unprobeable, but a JS string here can carry ${MAX_JS_STRING * 3} ` +
              `bytes, which is over its ${cap} byte cap. Some construction reaches it and this one does not.`
          );
        }
        continue;
      }
      const atCap = '\u4E00'.repeat(wide) + 'x'.repeat(rest);
      const overCap = `${atCap}x`;
      for (const mode of ['select', 'insert', 'update'] as const) {
        for (const libName of mysql.libs) {
          const lib = LIBS[libName];
          const o = safeField(lib, OFFICIAL[libName][mode](mysqlMatrix.table as never), col);
          const m = safeField(lib, loaded[libName][`${PREFIX[mode]}matrixSchema`], col);
          if (!o || !m) {
            capProblems.push(`${col} has no field on ${mode}/${libName}, so no cap was measured`);
            continue;
          }
          const at = { o: probe(lib, o, atCap), m: probe(lib, m, atCap) };
          const over = { o: probe(lib, o, overCap), m: probe(lib, m, overCap) };
          capMeasured.push(`${col}/${mode}/${libName}/at`, `${col}/${mode}/${libName}/over`);
          // Today's state and the only one that is not a finding, on both halves. Official counts
          // UTF-16 units, so it takes both. DRZL counts bytes, so the cap is where MySQL puts it:
          // `cap` bytes in, `cap + 1` bytes out.
          if (at.o === 'accept' && at.m === 'accept' && over.o === 'accept' && over.m === 'reject') continue;
          capProblems.push(
            `${col} on ${mode}/${libName}: at ${cap} bytes (${units} units) official ${at.o}, ` +
              `DRZL ${at.m}; at ${cap + 1} bytes (${units + 1} units) official ${over.o}, ` +
              `DRZL ${over.m}. Expected both accepted and DRZL alone refusing the second, which is ` +
              'where MySQL 8.4.11 puts the boundary.'
          );
        }
      }
    }
  }
}
if (!capMeasured.length) capProblems.push('no MySQL text column had its byte cap measured');

// The coverage claim, computed rather than asserted in a comment nobody re-runs.
const poolSeparates = (cap: number) =>
  POOL.some(([, x]) => typeof x === 'string' && Buffer.byteLength(x, 'utf8') > cap && x.length <= cap);
const coverageSeen: string[] = [];
for (const [col, cap] of Object.entries(TEXT_CAPS)) {
  const byPool = poolSeparates(cap);
  const byStage = capMeasured.some((probed) => probed.startsWith(`${col}/`));
  const got = byPool && byStage
    ? 'bracketed and separated'
    : byPool
      ? 'separated only'
      : byStage
        ? 'bracketed only'
        : 'neither';
  coverageSeen.push(`${col} ${got}`);
  if (CAP_COVERAGE[col] === got) continue;
  capProblems.push(
    `${col} is declared '${CAP_COVERAGE[col] ?? 'nothing, being absent from CAP_COVERAGE'}'` +
      `, and this run measured '${got}'`
  );
}
for (const col of Object.keys(CAP_COVERAGE)) {
  if (col in TEXT_CAPS) continue;
  capProblems.push(`CAP_COVERAGE names ${col}, which has no cap in TEXT_CAPS, so it describes nothing`);
}

console.log(
  `    ${capMeasured.length} byte-cap probe(s) bracketing ${Object.keys(TEXT_CAPS).length - capUnreachable.length} ` +
    `MySQL text column(s); ${capUnreachable.length} cannot be probed at all: ${capUnreachable.join(', ')}`
);
console.log(
  "    byte caps: 'bracketed' is probed at the cap and one byte over, which pins DRZL's cap to one" +
    " value; 'separated' is the pool holding a string the cap refuses on bytes and takes on" +
    ' characters, which tells the two counts apart without pinning the cap'
);
console.log(`    ${coverageSeen.join('; ')}`);
if (capProblems.length) {
  console.error('FAIL: a MySQL text column no longer separates a byte budget from a character');
  console.error('      count the way it is documented to:');
  for (const c of capProblems) console.error(`      ${c}`);
}

if (totalCompared !== EXPECTED_COMPARISONS) {
  const direction = totalCompared < EXPECTED_COMPARISONS ? 'fewer' : 'more';
  console.error(`FAIL: ${totalCompared} column comparisons, expected ${EXPECTED_COMPARISONS}.`);
  console.error(`      This run compared ${direction} columns than EXPECTED_COMPARISONS says.`);
  if (totalCompared < EXPECTED_COMPARISONS) {
    console.error('      A parity pass that measures fewer columns than it did yesterday is the');
    console.error('      failure this file has been bitten by most, so this is a stop. Find what');
    console.error('      stopped being compared before touching the constant.');
  } else {
    console.error('      A fixture grew. That is fine and it is not automatic: measure the new');
    console.error('      columns, put any difference in ALLOWED with its reason, and then update');
    console.error('      EXPECTED_COMPARISONS in this file to match.');
  }
}
console.log(`    ${totalCompared} column comparisons`);

// The presence axis, held to the same denominator. It is a separate counter because it is a
// separate question asked of a separate object, and because the state it exists to end is one where
// this number was zero and every pairing still printed `parity`.
if (presenceCompared + presenceCrashed + presenceUnreadable !== EXPECTED_COMPARISONS) {
  presenceProblems.push(
    `${presenceCompared} key-presence comparisons plus ${presenceCrashed} crashed and ` +
      `${presenceUnreadable} unreadable, which is not the ${EXPECTED_COMPARISONS} column pairings ` +
      'the value pool is pushed through'
  );
}
for (const key of Object.keys(PRESENCE_BARREN)) {
  if (!usedBarren.has(key)) {
    presenceProblems.push(`PRESENCE_BARREN[${key}] names a column that accepts a pool value now, so delete it`);
  }
}
for (const key of Object.keys(SELECT_OPTIONAL)) {
  if (!usedSelectOptional.has(key)) {
    selectOptionalProblems.push(`SELECT_OPTIONAL[${key}] requires its key on select now, so delete it`);
  }
}
if (selectSchemas.size !== SELECT_REACH.schemas || selectKeysInspected !== SELECT_REACH.keys) {
  selectOptionalProblems.push(
    `the select check read ${selectSchemas.size} schema(s) and ${selectKeysInspected} key(s), ` +
      `declared ${SELECT_REACH.schemas} and ${SELECT_REACH.keys}. It has no second side to ` +
      'disagree with it, so a shrinking reach is silent unless this fails'
  );
}
console.log(
  `    ${selectKeysInspected} select key(s) across ${selectSchemas.size} schema(s) required, bar ` +
    `${Object.keys(SELECT_OPTIONAL).length} declared to let the key go missing: ` +
    Object.keys(SELECT_OPTIONAL).join(', ')
);
console.log(
  `    ${presenceCompared} key-presence comparisons asked of the object rather than the field, ` +
    `${presenceCrashed} where a side crashed on the omission and ${presenceUnreadable} with no ` +
    `object to ask about (${Object.keys(PRESENCE_BARREN).join(', ')})`
);

// The omission crashes, held to THREW from both ends, exactly as the value crashes are.
for (const [key, seen] of presenceThrew) {
  const e = THREW[key];
  if (!e) {
    presenceProblems.push(
      `${key}: ${[...seen.sides].sort().join('/')} crashed on the object with the key omitted in ` +
        `${[...seen.modes].sort().join(', ')}, and is in no list`
    );
    continue;
  }
  const gotSides = [...seen.sides].sort().join(',');
  if (gotSides !== e.side) {
    presenceProblems.push(`THREW[${key}] declares side ${e.side}, and the omission crashed on ${gotSides}`);
  }
  const gotModes = [...seen.modes].sort().join(',');
  const wantModes = [...e.absentModes].sort().join(',');
  if (gotModes !== wantModes) {
    presenceProblems.push(`THREW[${key}] declares absentModes ${wantModes || 'none'}, measured ${gotModes}`);
  }
}
for (const [key, e] of Object.entries(THREW)) {
  if (e.absentModes.length && !presenceThrew.has(key)) {
    presenceProblems.push(`THREW[${key}] declares absentModes ${e.absentModes.join(',')} and no omission crashed there`);
  }
}

/**
 * How many waivers run each way, counted from the map rather than stated in a sentence.
 *
 * `L:` is the half of a signature listing what DRZL accepts and official refuses, so a non-empty
 * one is a waiver where DRZL is the looser side. Comments in this file have claimed a number for
 * that more than once, and the count is printed below instead so a claim about it cannot go
 * stale: the float waivers added when the bounds moved to the database's were described as "the
 * only entries in either pass that run that way", and they are not, on either pass.
 *
 * The sentence that stood here restated the printed counts and the ratio between them, having
 * just said that writing them down was what went stale. The nullable twins on this branch
 * falsified every figure in it in one edit, so it is gone and the printed line is the answer.
 *
 * Being looser than official is not by itself a defect and this line is not a warning. Postgres
 * takes three emoji into a `char(3)`, a Uint8Array into a `bytea` and a uuid into a `uuid`, and
 * official refuses all three. What the gate holds is the sentence at the end of this file.
 */
const looserSide = (e: { divergence: Record<string, string> }) =>
  Object.values(e.divergence).some((s) => s.split('|')[0].replace(/^L:/, '').trim() !== '');
const looserWaivers = Object.values(ALLOWED).filter(looserSide).length;
// How many waivers state their divergence as a rejection count plus a complement rather than as a
// list, read off the declarations. Sentences in this file used to carry that number and the length
// of the list it replaces; adding five pool values made every one of them wrong in a single edit,
// so it is computed here instead. Zero on this pass today, and the line says so rather than a
// comment.
const SHORTHAND = /^every probe official rejects \((\d+) of them\), and official accepts only: (.*)$/;
const shorthandCols = Object.entries(ALLOWED)
  .filter(([, e]) => Object.values(e.divergence).some((d) => SHORTHAND.test(d)))
  .map(([k]) => k);
console.log(
  `    ${Object.keys(ALLOWED).length} documented divergence(s), ${looserWaivers} of them with ` +
    `DRZL accepting something official refuses, ${shorthandCols.length} stated as a rejection ` +
    `count and a complement${shorthandCols.length ? `: ${shorthandCols.join(', ')}` : ''}`
);

// A waiver that suppresses nothing is not harmless. It is a sentence claiming a divergence exists
// and is fine, sitting next to the divergences that really do, and the next person to widen this
// file reads it as covered ground. Every key above has to earn its place on this run or be
// deleted, which is also the only thing standing between this list and being used as a way to
// make a failure go away.
const deadWaivers = [
  ...Object.keys(ALLOWED).filter((k) => !usedWaivers.has(k)).map((k) => `ALLOWED[${k}]`),
  ...Object.keys(CROSS_ALLOWED).filter((k) => !usedCrossWaivers.has(k)).map((k) => `CROSS_ALLOWED[${k}]`),
  ...Object.keys(CROSS_DEFECTS).filter((k) => !usedCrossWaivers.has(k)).map((k) => `CROSS_DEFECTS[${k}]`),
  ...Object.keys(PRESENCE_ALLOWED)
    .filter((k) => !usedPresenceWaivers.has(k))
    .map((k) => `PRESENCE_ALLOWED[${k}]`),
];

// The exact divergence each waiver covers, compared with what it actually suppressed. Every
// pairing has to be claimed by exactly one declaration and match it character for character, and
// every declaration has to claim at least one pairing. This is what "suppressed something" cannot
// say: stripping the length caps off `m_tinytext` still suppresses something, just something else.
const waiverProblems: string[] = [];
// One routine for both maps, so the presence axis cannot end up held to a weaker rule than the
// value axis. The 0.4x pass had exactly that shape for a round: two ledgers side by side, one
// asserted in both directions and one only checked for additions.
const checkWaivers = (map: Record<string, Waiver>, seenAll: Map<string, Map<string, string>>, name: string) => {
for (const [key, seen] of seenAll) {
  const entry = map[key];
  // Which pairings carry the divergence, not only what it looks like. A signature alone is
  // satisfied by any non-empty subset: deleting the `m_tinytext` byte cap on insert and update
  // and leaving select alone left this pass green, four pairings matching where twelve should,
  // while a MySQL TINYTEXT insert schema took 400 bytes the server refuses.
  const gotLibs = [...new Set([...seen.keys()].map((x) => x.split('/')[1]))].sort().join(',');
  const gotModes = [...new Set([...seen.keys()].map((x) => x.split('/')[0]))].sort().join(',');
  const wantLibs = [...entry.libs].sort().join(',');
  const wantModes = [...entry.modes].sort().join(',');
  if (gotLibs !== wantLibs) waiverProblems.push(`${name}[${key}] declares libs ${wantLibs}, measured ${gotLibs}`);
  if (gotModes !== wantModes) waiverProblems.push(`${name}[${key}] declares modes ${wantModes}, measured ${gotModes}`);
  const excepted = entry.except ?? [];
  const wrongly = excepted.filter((x) => seen.has(x));
  if (wrongly.length) {
    waiverProblems.push(
      `${name}[${key}] excepts ${wrongly.join(', ')}, which diverged on this run. ` +
        `Remove the exception or the waiver is understating what it covers.`
    );
  }
  const wantPairings = entry.libs.length * entry.modes.length - excepted.length;
  if (seen.size !== wantPairings) {
    waiverProblems.push(
      `${name}[${key}] declares ${wantPairings} pairings, measured ${seen.size}: ` +
        [...seen.keys()].sort().join(', ')
    );
  }
  const claimed = new Set<string>();
  for (const [pairing, sig] of seen) {
    const hits = Object.keys(entry.divergence).filter((d) => pairingMatches(d, pairing));
    if (hits.length !== 1) {
      waiverProblems.push(
        `${name}[${key}] has ${hits.length} declarations for ${pairing}, needs exactly one. ` +
          `Measured there: ${sig}`
      );
      continue;
    }
    claimed.add(hits[0]);
    const want = entry.divergence[hits[0]];
    if (want === sig) continue;
    waiverProblems.push(
      `${name}[${key}] on ${pairing} declares\n        ${want}\n      and measured\n        ${sig}`
    );
  }
  for (const d of Object.keys(entry.divergence)) {
    if (!claimed.has(d)) waiverProblems.push(`${name}[${key}] declaration '${d}' matched no pairing`);
  }
}
};
checkWaivers(ALLOWED, waived, 'ALLOWED');
checkWaivers(PRESENCE_ALLOWED, presenceWaived, 'PRESENCE_ALLOWED');
if (waiverProblems.length) {
  console.error('FAIL: a waiver no longer covers the divergence it was written for. Re-measure it');
  console.error('      and update the signature, or delete it. A waiver that says only "something');
  console.error('      differs here" absorbs the next regression on the same column:');
  for (const w of waiverProblems) console.error(`      ${w}`);
}

// The crashes, held to the same rule from both ends. An undeclared one is a difference nobody
// looked at; a declared one that stopped happening is a sentence about something nobody can see.
// The cross-generator waivers, held to their signatures the same way. Identical mechanism, and it
// is here because the deferral that left it out last round turned out to be exploitable in exactly
// the way the previous one was.
const crossProblems: string[] = [];
for (const [keyMode, sig] of crossWaived) {
  const i = keyMode.lastIndexOf('/');
  const key = keyMode.slice(0, i);
  const mode = keyMode.slice(i + 1);
  const entry = CROSS_ALLOWED[key] ?? CROSS_DEFECTS[key];
  const want = entry.divergence[mode] ?? entry.divergence['*'];
  if (want === undefined) {
    crossProblems.push(`CROSS_ALLOWED[${key}] names mode ${mode} and declares no divergence for it`);
    continue;
  }
  if (want === sig) continue;
  crossProblems.push(`CROSS_ALLOWED[${key}] on ${mode} declares\n        ${want}\n      and measured\n        ${sig}`);
}
// The other direction: a declared mode that produced nothing to suppress.
for (const [key, entry] of [...Object.entries(CROSS_ALLOWED), ...Object.entries(CROSS_DEFECTS)]) {
  for (const mode of entry.modes) {
    if (!crossWaived.has(`${key}/${mode}`)) {
      crossProblems.push(`CROSS_ALLOWED[${key}] names mode ${mode}, which suppressed nothing on this run`);
    }
  }
}
if (crossProblems.length) {
  console.error('FAIL: a cross-generator waiver no longer covers what it was written for:');
  for (const c of crossProblems) console.error(`      ${c}`);
}

const throwProblems: string[] = [];
for (const [key, seen] of threwSeen) {
  const e = THREW[key];
  if (!e) {
    throwProblems.push(
      `${key}: ${[...seen.sides].join('/')} crashed on ${[...seen.values].sort().join(', ')} ` +
        `in ${[...seen.modes].sort().join(', ')}, and is in no list`
    );
    continue;
  }
  const got = { side: [...seen.sides].sort().join(','), modes: [...seen.modes].sort().join(','), values: [...seen.values].sort().join(',') };
  const want = { side: e.side, modes: [...e.modes].sort().join(','), values: [...e.values].sort().join(',') };
  for (const f of ['side', 'modes', 'values'] as const) {
    if (got[f] !== want[f]) throwProblems.push(`THREW[${key}] declares ${f} ${want[f]}, measured ${got[f]}`);
  }
}
for (const key of Object.keys(THREW)) {
  if (!threwSeen.has(key)) throwProblems.push(`THREW[${key}] saw no crash on this run`);
}

/**
 * What DRZL answered where official could not, held to the declaration in both directions.
 *
 * Without this a crashing official validator is a licence for DRZL to do anything on that value.
 * `pg/typebox/c_bit` is `bit({ dimensions: 3 }).notNull()`, and its Insert and Update schemas were
 * made to accept `null` with this pass staying byte identical to green.
 */
const declMatches = (decl: string, mode: string, label: string) => {
  const cut = decl.indexOf('/');
  return (decl.slice(0, cut) === '*' || decl.slice(0, cut) === mode) && decl.slice(cut + 1) === label;
};
for (const [key, seen] of crashVerdict) {
  const e = THREW[key];
  // An undeclared crash is already a failure above; reporting the same site twice adds nothing.
  if (!e) continue;
  const want = e.modes.length * e.values.length;
  if (seen.size !== want) {
    throwProblems.push(
      `THREW[${key}] declares ${want} crashed probe(s), measured ${seen.size}: ${[...seen.keys()].sort().join(', ')}`
    );
  }
  const claimed = new Set<string>();
  for (const [at, verdict] of seen) {
    const cut = at.indexOf('/');
    const hits = Object.keys(e.drzl).filter((decl) => declMatches(decl, at.slice(0, cut), at.slice(cut + 1)));
    if (hits.length !== 1) {
      throwProblems.push(`THREW[${key}].drzl has ${hits.length} declarations for ${at}, needs exactly one. Measured there: ${verdict}`);
      continue;
    }
    claimed.add(hits[0]);
    if (e.drzl[hits[0]] === verdict) continue;
    throwProblems.push(`THREW[${key}].drzl declares ${e.drzl[hits[0]]} on ${at}, measured ${verdict}`);
  }
  for (const decl of Object.keys(e.drzl)) {
    if (!claimed.has(decl)) throwProblems.push(`THREW[${key}].drzl declaration '${decl}' matched no crashed probe`);
  }
}

/**
 * And who says those answers are the right ones.
 *
 * A pinned verdict stops DRZL's behaviour moving unseen; it does not say the pinned value is
 * correct. A real Postgres does, for everything it can be asked: the table is built from the
 * fixture column's own `getSQLType()`, and its nullable twin has to take a NULL before the NOT NULL
 * twin's refusal counts as anything.
 *
 * An absence is asked as an absence, by leaving the column out of the insert, and not by binding a
 * NULL where it would have gone. It used to be classified unarbitrable on the ground that no
 * database can be handed one, which is false: `pool.ts` has the three-way measurement, and the
 * consequence of the false ground was that the `undefined` probe on every crash site went
 * unarbitrated for a reason that named the wrong obstacle.
 *
 * One reason for not arbitrating survives, and it is now checked against something outside the
 * branch that produces it: PGlite is a Postgres, so it cannot answer for the MySQL columns. The
 * engine reports its own name through `select version()`, so a run where this process did hold an
 * engine for that dialect fails here instead of printing the excuse. That is the one thing this
 * block could not previously do: the reason string and the gate were one expression, so the string
 * was computed and the reason was not checked at all.
 */
const arbiterProblems: string[] = [];
{
  // Every Postgres table in the comparison, not only `matrix`: a crash site on a `nullable` column
  // has to reach the same database this one does, and a lookup over one table would report it as a
  // column no DDL can be built for.
  const pgColumns = [pgTable, pgNullable].flatMap(
    (t) => getTableConfig(t as never).columns as { name: string; notNull: boolean; getSQLType: () => string }[]
  );
  const wanted: { key: string; label: string; value: unknown; dialect: string; column: string }[] = [];
  for (const [key, e] of Object.entries(THREW)) {
    const [dialect, , column] = key.split('/');
    const declared = Object.keys(e.arbiter).sort().join(',');
    const values = [...e.values].sort().join(',');
    if (declared !== values) {
      arbiterProblems.push(`THREW[${key}].arbiter covers ${declared || 'nothing'}, and the crash values are ${values}`);
    }
    for (const label of e.values) {
      const found = POOL.find(([l]) => l === label);
      if (!found) {
        arbiterProblems.push(`THREW[${key}] names the value ${label}, which is not in POOL, so nothing can be asked about it`);
        continue;
      }
      wanted.push({ key, label, value: found[1], dialect, column });
    }
  }
  const probes: DbProbe[] = [];
  for (const w of wanted) {
    if (w.dialect !== 'pg') continue;
    const col = pgColumns.find((c) => c.name === w.column);
    if (!col) {
      arbiterProblems.push(`THREW[${w.key}] names a column the Postgres fixture does not have, so no DDL can be built for it`);
      continue;
    }
    // The pool's `undefined` is an absence, and it is carried to the database as one rather than
    // bound as a value. `absent` is what picks the statement that never names the column.
    probes.push({
      key: w.key,
      sqlType: col.getSQLType(),
      notNull: col.notNull,
      label: w.label,
      absent: w.value === undefined,
      value: w.value,
    });
  }
  const { engine, answers } = await askPostgres(probes);
  // A run where the database answered nothing would otherwise leave every site reading as
  // deliberately unarbitrated.
  if (!probes.length) arbiterProblems.push('no crash site reached a database on this run, so nothing was arbitrated');
  if (engine !== 'pg') {
    arbiterProblems.push(`the in-process engine answers 'select version()' with ${engine}, and every answer below is read as a Postgres one`);
  }
  let arbitrated = 0;
  for (const w of wanted) {
    const e = THREW[w.key];
    const verdicts = [...new Set(
      [...(crashVerdict.get(w.key) ?? new Map<string, string>())]
        .filter(([at]) => at.slice(at.indexOf('/') + 1) === w.label)
        .map(([, v]) => v)
    )].sort();
    let got: string;
    if (w.dialect !== 'pg') {
      got = `no in-process ${w.dialect} engine`;
      // Asserted rather than only computed. The engine names itself, so the excuse is checked
      // against something outside the branch that writes it: wiring a MySQL in here and leaving
      // this declaration alone fails the run instead of reading as deliberate.
      if (engine === w.dialect) {
        arbiterProblems.push(
          `${w.key}/${w.label} is declared unarbitrable for want of a ${w.dialect} engine, and the ` +
            `engine in this process names itself ${engine}`
        );
      }
    } else {
      const a = answers.get(`${w.key}/${w.label}`);
      if (!a) {
        arbiterProblems.push(`${w.key}/${w.label} was sent to the database and came back with no answer`);
        continue;
      }
      if (a.control) {
        arbiterProblems.push(`${w.key}/${w.label}: ${a.control}`);
        continue;
      }
      arbitrated++;
      const asked = w.value === undefined ? 'the column omitted from the insert' : 'it';
      got = a.verdict === 'accept' ? `postgres accepts ${asked}` : `postgres refuses ${asked} (SQLSTATE ${a.code})`;
      // The one rule the declaration cannot talk its way out of. A value the database refuses and
      // DRZL takes is a schema admitting a row the server will not. `ALLOWED` is read dialect-wide
      // here and a library-scoped waiver does not reach it, which is the fail-closed direction.
      if (a.verdict === 'refuse' && verdicts.includes('accept') && !ALLOWED[`${w.dialect}/${w.column}`]) {
        arbiterProblems.push(
          `${w.key}/${w.label}: postgres refuses ${asked} and DRZL accepts it, and no waiver names ` +
            `${w.dialect}/${w.column}`
        );
      }
    }
    if (e.arbiter[w.label] === got) continue;
    arbiterProblems.push(`THREW[${w.key}].arbiter declares '${e.arbiter[w.label]}' for ${w.label}, and this run got '${got}'`);
  }
  console.log(
    `    ${arbitrated} crash probe(s) arbitrated against a real Postgres, of ` +
      `${wanted.length} across ${Object.keys(THREW).length} crash site(s)`
  );
}
if (arbiterProblems.length) {
  console.error('FAIL: a crash site is no longer settled the way it is declared to be. A value');
  console.error('      official crashes on is still a value DRZL answers, and something has to');
  console.error('      say whether that answer is right:');
  for (const a of arbiterProblems) console.error(`      ${a}`);
}
console.log(
  `    ${[...threwSeen.values()].reduce((n, s) => n + s.at.size, 0)} probe(s) crashed ` +
    `instead of returning a verdict, on ${threwSeen.size} column(s) against ` +
    `${Object.keys(THREW).length} declared, with DRZL's own verdict on each pinned above`
);
if (throwProblems.length) {
  console.error('FAIL: a probe crashed where the list above does not say one does. A crash is not');
  console.error('      a verdict and must not be compared as one:');
  for (const t of throwProblems) console.error(`      ${t}`);
}
if (deadWaivers.length) {
  console.error('FAIL: these waivers suppressed nothing on this run, so they describe a');
  console.error('      divergence that no longer happens. Delete them rather than keeping a');
  console.error('      reason for something nobody can observe:');
  for (const k of deadWaivers) console.error(`      ${k}`);
}

if (findings) {
  console.error(`FAIL: ${findings} parity finding(s): a generated schema differs from the`);
  console.error('      first-party module on a value, and no waiver names that difference.');
  console.error('      Looser is not automatically wrong and this sentence used to say it was:');
  console.error('      Postgres takes three emoji into a char(3) and a Uint8Array into a bytea,');
  console.error('      and official refuses both. Ask the database which side is right, then put');
  console.error('      the answer in ALLOWED with its measurement, or fix the generator.');
}

if (selectOptionalProblems.length) {
  console.error("FAIL: a select schema lets a key go missing. A select row carries every column, so");
  console.error('      an optional key there is wrong however many libraries agree about it:');
  for (const p of selectOptionalProblems) console.error(`      ${p}`);
}
if (presenceProblems.length) {
  console.error('FAIL: the key-presence axis could not measure what it claims to. A column no side');
  console.error('      accepts a value for, or an object a side refuses despite being built from');
  console.error('      its own accepted values, is not a reading and must not be compared as one:');
  for (const p of presenceProblems) console.error(`      ${p}`);
}

// Counted separately and exited on together, so one run reports both rather than hiding the
// second behind the first. A dead waiver is not a looser schema and must not be described as one.
if (
  findings ||
  deadWaivers.length ||
  throwProblems.length ||
  arbiterProblems.length ||
  waiverProblems.length ||
  crossProblems.length ||
  capProblems.length ||
  presenceProblems.length ||
  selectOptionalProblems.length ||
  totalCompared !== EXPECTED_COMPARISONS
) {
  process.exit(1);
}
PARITY_HARNESS

# drizzle-orm is pinned: the parity target is a specific release, and a floating one would turn
# an upstream change into a mysterious failure here rather than a deliberate re-measurement.
#
# ajv and ajv-formats are the JSON Schema generator's own declared devDependency ranges, so the
# packed artefact is read by the same validator its unit tests claim it is checked against. They
# are not dependencies of anything DRZL publishes: JSON Schema output is data with no runtime.
#
# typescript, because this tree's generated output is now compiled as well as executed. It was
# only ever run, and a nullable bigint array reached a released generator emitting `>=` against a
# `bigint[]`, which no amount of running it can notice.
#
# @electric-sql/pglite arrives here rather than further down because the parity pass now needs a
# real Postgres of its own: where the official validator crashes on a value there is nothing left
# to compare DRZL against, and a database is what settles whether DRZL's answer is right. The
# ground-truth stage in this same tree used to install it on its own line and now inherits it.
npm install --no-audit --no-fund --loglevel=error \
  "$TARS"/*.tgz drizzle-orm@1.0.0-rc.4 zod valibot arktype @sinclair/typebox tsx typescript \
  ajv@^8.17.1 ajv-formats@^3.0.1 @electric-sql/pglite >/dev/null

for dialect in pg mysql sqlite; do
  case "$dialect" in
    # All four libraries on every dialect. It was four on Postgres and one everywhere else, so
    # valibot, arktype and typebox had never been compared with anything on MySQL or SQLite:
    # eighteen combinations with no differential coverage at all. The official modules take any
    # Drizzle table regardless of dialect, so there was never a structural reason for it. Widening
    # this also turns pass 2, the cross-generator check, on for MySQL and SQLite, which is where it
    # found the arktype json column disagreeing with its three siblings.
    pg)     schema=src/schema.ts;        libs="zod valibot arktype typebox" ;;
    mysql)  schema=src/schema-mysql.ts;  libs="zod valibot arktype typebox" ;;
    sqlite) schema=src/schema-sqlite.ts; libs="zod valibot arktype typebox" ;;
  esac
  gens=""
  for lib in $libs; do gens="$gens    { kind: '$lib', path: 'src/gen/$dialect/$lib' },"$'\n'; done
  # The sixth generator, on the one dialect with a real database behind it.
  #
  # It is deliberately not in `libs`: there is no official JSON Schema module for the parity pass
  # to compare it against, so it takes no part in that pass and is measured against Postgres
  # instead. Until this line existed it appeared in exactly one stage of this file, the
  # documented-configs one, which asks only whether the emitted TypeScript compiles. The generator
  # that emits a published API contract was the only one whose output was never compared with a
  # database, with its siblings, or with a validator of any kind.
  #
  # `components: true` because the OpenAPI document is a second emission with its own rules, and
  # nothing outside the generator's own unit tests had ever produced one.
  if [ "$dialect" = pg ]; then
    gens="$gens    { kind: 'json-schema', path: 'src/gen/$dialect/json-schema', components: true },"$'\n'
  fi
  cat > "drzl.$dialect.config.ts" <<CONFIG
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: '$schema',
  outDir: 'src/gen/$dialect',
  generators: [
$gens  ],
});
CONFIG
  npx drzl generate --config "drzl.$dialect.config.ts" >/dev/null
  # A second pass with `applyDefaults` on. The option had no coverage here at all, so a change
  # that stopped it working would have shipped with a green gate.
  if [ "$dialect" = pg ]; then
    cat > "drzl.$dialect.defaults.config.ts" <<CONFIG
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: '$schema',
  outDir: 'src/gen/${dialect}-defaults',
  generators: [{ kind: 'zod', path: 'src/gen/${dialect}-defaults/zod', applyDefaults: true }],
});
CONFIG
    npx drzl generate --config "drzl.$dialect.defaults.config.ts" >/dev/null
  fi
  for lib in $libs; do
    if [ ! -e "src/gen/$dialect/$lib/matrix.$lib.ts" ]; then
      echo "FAIL: the $lib generator produced no file for the $dialect parity matrix." >&2
      exit 1
    fi
  done
  # Named individually rather than derived, because this generator's file suffix and its extra
  # `components.ts` are not the `<table>.<lib>.ts` shape the loop above assumes, and a kind that
  # emitted nothing at all would otherwise be found only by an import failing much further down.
  if [ "$dialect" = pg ]; then
    for f in matrix.schema.ts nullable.schema.ts checked.schema.ts defaulted.schema.ts components.ts index.ts; do
      if [ ! -e "src/gen/pg/json-schema/$f" ]; then
        echo "FAIL: the json-schema generator produced no src/gen/pg/json-schema/$f." >&2
        exit 1
      fi
    done
  fi
done


# ---------------------------------------------------------------------------------------------
# Does the parity matrix output compile?
#
# The typecheck stage far above runs on a two-table users/posts schema with no arrays, no bigint
# and no capped column, so the only generated code this script ever put through `tsc` was its
# simplest. The 40-column matrix, which exists precisely to hold the awkward types, was generated,
# executed and then thrown away without a compiler ever looking at it.
#
# What that hid: the arktype generator emitted `type("(bigint[] | null)").narrow((v, ctx) => ...
# v >= -9223372036854775808n ...)` for a nullable bigint array, which is TS2365, `>=` cannot be
# applied to `bigint[]`. Every runtime check in this file passed it, because a narrow that throws
# is caught and read as a rejection, and rejection was the answer for most probe values anyway.
# ---------------------------------------------------------------------------------------------
echo "==> typechecking the parity matrix output"
# Three columns are carved out of this stage, not two modules, for one defect that predates the
# branch. Each claim below was measured, after two earlier attempts at this comment asserted
# mechanisms that turned out not to exist.
#
# `c_numeric` and `c_decimal` on Postgres, and `m_decimal` on MySQL, each fail TS2589 on their own,
# in a file holding nothing else. The arktype generator states a numeric format as a bare regex
# literal inside the type expression, and that literal is around 200 characters that ArkType parses
# in the type system. It is the one emitted construct expensive enough to exhaust the instantiation
# budget by itself.
#
# What it is *not*, each checked rather than assumed:
#
#   - Not this branch's doing. Rewriting the emitted pg file back to the exact form the generator
#     produced before the bigint bound and before the array fix reproduces it at the same position.
#   - Not the narrows. Stripping every `.narrow(...)` from the pg matrix, leaving the same 40
#     fields, fails identically at (7,40).
#   - Not the number of fields. Every one of the 40 pg fields compiles alone except those two, and
#     the first 10 compile together with or without their narrows.
#   - Not the table size. sqlite's matrix is clean because it has no numeric-format column, not
#     because it has 14 columns: SQLite `numeric` carries no format and emits a plain `"string"`.
#
# So the repair is to stop putting a 200-character regex in the type expression, not to change how
# a whole-table object is emitted. That is reported separately and not done here.
#
# The carve-out is by column, so the other 38 pg and 28 mysql columns are still compiled: the two
# modules are copied with exactly those field lines dropped, and the copy is what this stage
# checks.
#
# Two things have to stay true of an exclusion, and only the first of them used to be checked:
# that it still covers what it says, and that it is still needed at all. The inline line count
# below is the first. The probes are the second, and they are the reason this is not a waiver that
# outlives its defect: each carved column is put back on its own, and the result has to still fail
# to compile. Simulating the generator fix, by making those three columns emit `"string"`, used to
# leave them silently un-typechecked for ever with the stage printing that everything compiles.
mkdir -p src/gen-tsc src/carve-probe
node - <<'CARVE'
import fs from 'node:fs';
const CARVED = { pg: ['c_numeric', 'c_decimal'], mysql: ['m_decimal'] };
const MODES = 3;
const excludes = [];
let probes = 0;
for (const [dialect, cols] of Object.entries(CARVED)) {
  const from = `src/gen/${dialect}/arktype/matrix.arktype.ts`;
  const lines = fs.readFileSync(from, 'utf8').split('\n');
  const drop = new RegExp(`^\\s*"(${cols.join('|')})\\??":`);
  const kept = lines.filter((l) => !drop.test(l));
  const removed = lines.length - kept.length;
  if (removed !== cols.length * MODES) {
    console.error(
      `FAIL: carving ${cols.join(', ')} out of ${from} removed ${removed} lines, not ` +
        `${cols.length * MODES}. The emitted shape changed, so this exclusion no longer covers ` +
        `what it says it covers and may now be hiding a real error.`
    );
    process.exit(1);
  }
  fs.writeFileSync(`src/gen-tsc/${dialect}-matrix.arktype.ts`, kept.join('\n'));
  // One probe per carved column: the compiled copy with that column, and only that column, put
  // back. Somewhere outside the include below, so the stage's own run does not compile them.
  for (const col of cols) {
    const one = new RegExp(`^\\s*"${col}\\??":`);
    const withCol = lines.filter((l) => !drop.test(l) || one.test(l));
    if (withCol.length !== kept.length + MODES) {
      console.error(`FAIL: restoring ${col} into the ${dialect} copy did not put back ${MODES} lines.`);
      process.exit(1);
    }
    fs.writeFileSync(`src/carve-probe/${dialect}-${col}.ts`, withCol.join('\n'));
    probes++;
  }
  // The exclusions come from the same map as the copies, rather than being written out beside it.
  // Hardcoding them meant the two could disagree, and in exactly one direction: emptying CARVED
  // wrote no stand-in copies while the exclude list went on hiding both original modules, so 40
  // Postgres and 29 MySQL columns were dropped from the typecheck entirely and the stage still
  // said everything compiled. Derived, an empty CARVED excludes nothing and the originals are
  // compiled directly, which fails loudly if the defect is still there.
  excludes.push(
    `src/gen/${dialect}/arktype/matrix.arktype.ts`,
    // The barrel with it: `exclude` only filters the entry list, so an `index.ts` re-exporting the
    // matrix module would pull the original straight back in.
    `src/gen/${dialect}/arktype/index.ts`
  );
}
fs.writeFileSync('carve-manifest.txt', String(probes));
fs.writeFileSync(
  'tsconfig.gen.json',
  JSON.stringify(
    {
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'es2022',
        module: 'nodenext',
        moduleResolution: 'nodenext',
        skipLibCheck: true,
      },
      include: [
        'src/gen/**/*.ts',
        'src/gen-tsc/**/*.ts',
        'src/schema.ts',
        'src/schema-mysql.ts',
        'src/schema-sqlite.ts',
      ],
      exclude: excludes,
    },
    null,
    2
  )
);
CARVE
# The originals are excluded because the copies stand in for them, and their barrels with them.
# Those barrels are four re-export lines on pg and three on mysql, and the copies cover the modules
# they name. What is given up is narrow and worth saying: the barrel is no longer the thing that
# pulls its modules in here, so a barrel line naming a module that does not exist would not be
# caught by this stage.
if ! npx tsc -p tsconfig.gen.json; then
  echo "FAIL: the parity matrix output does not compile under tsc --strict." >&2
  echo "      Generated code that does not typecheck is not usable output, however it behaves" >&2
  echo "      at runtime." >&2
  exit 1
fi
echo "    every generator's matrix output compiles under --strict, module nodenext"

# The other direction: does each carved column still earn its carve?
#
# A count of removed lines says the exclusion still matches the emitted shape. It says nothing
# about whether the defect is still there, so the day the generator stops putting a regex in the
# type expression, these columns would stay out of the typecheck for ever and this stage would go
# on printing that everything compiles. That is the same stale-waiver shape as the cross-generator
# list further up, which had exactly this hole in the opposite direction.
#
# Compiled one at a time because the question is per column and a compilation answers per run. A
# combined run over all three probes gives one exit code for the union of them, which is nonzero
# while any single column still fails, so the one that had been fixed would be masked by the two
# that had not. That is the whole point of the check, so it cannot be run in a form that cannot
# express the answer. It is not about errors going unreported: this compiler names all three.
#
# The number of probes is asserted against what the carve script wrote, and each probe's output has
# to actually contain TS2589. Both because "no news is good news" is how this check would otherwise
# read an empty directory and an unrelated compile error alike: an unexpanded glob makes tsc fail
# on a path that does not exist, and any nonzero exit used to count as proof the carve was earning
# its place, so a genuinely broken column carved out of the main compile was certified by the
# guard meant to police it.
expected_probes=$(cat carve-manifest.txt)
actual_probes=$(find src/carve-probe -name '*.ts' | wc -l)
if [ "$actual_probes" != "$expected_probes" ]; then
  echo "FAIL: $actual_probes carve probe(s) on disk, $expected_probes expected from CARVED." >&2
  echo "      This check cannot report on a column it never compiled." >&2
  exit 1
fi
carve_dead=0
for probe in $(find src/carve-probe -name '*.ts' | sort); do
  out=$(npx tsc --strict --noEmit --target es2022 --module nodenext --moduleResolution nodenext \
      --skipLibCheck "$probe" 2>&1 || true)
  case "$out" in
    *"error TS2589"*) ;;
    '')
      echo "FAIL: $probe compiles, so that column no longer needs carving out of the typecheck." >&2
      echo "      Delete it from CARVED above rather than leaving a column excluded for a defect" >&2
      echo "      that has been fixed." >&2
      carve_dead=1
      ;;
    *)
      echo "FAIL: $probe fails, but not with the TS2589 this carve-out exists for:" >&2
      echo "$out" | head -5 >&2
      echo "      That error is being hidden from the main typecheck by an exclusion written for" >&2
      echo "      a different defect. Fix it, or carve it out deliberately and say so." >&2
      carve_dead=1
      ;;
  esac
done
[ "$carve_dead" = 0 ] || exit 1
echo "    all $expected_probes carved column(s) still fail with TS2589, so the carve-out is earning it"

cat > src/json-schema-valid.ts <<'JSON_SCHEMA_VALID'
/**
 * Every emitted JSON Schema, compiled by a real validator in strict mode.
 *
 * A JSON Schema is data, which makes it very easy to emit something that looks right and means
 * nothing: an unknown keyword is not an error in JSON Schema, it is ignored. `exclusiveMinimum` in
 * the wrong spelling, `prefixItems` in a draft that has no such keyword, `nullable` in a draft that
 * has no such keyword: each produces a document that validates as a schema and then accepts the
 * value the constraint exists to reject. ajv's strict mode refuses an unknown or misspelled
 * keyword instead, which is why the generator's own unit tests work this way.
 *
 * This runs the same check on the packed artefact rather than on `src`, because that is the file a
 * consumer's OpenAPI tooling reads. Five of the six generators go through the packed gate and this
 * one, the one that emits a published API contract, went through none of it.
 */
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { is, Table } from 'drizzle-orm';
import * as pgSchema from './schema.js';
import * as emitted from './gen/pg/json-schema/index.js';

/**
 * What the barrel is expected to hold, derived from the Drizzle schema rather than listed.
 *
 * A listed set stops covering a table the moment the fixture grows one. Deriving it makes the
 * count a positive control: an emission that silently dropped a table, or a barrel that exported
 * nothing, fails here rather than passing over an empty loop.
 */
const tableNames = Object.entries(pgSchema)
  .filter(([, value]) => is(value, Table))
  .map(([name]) => name)
  .sort();
const MODES = ['Insert', 'Update', 'Select'] as const;
const expectedSchemas = tableNames.flatMap((t) => MODES.map((m) => `${m}${t}Schema`)).sort();
const expectedComponents = tableNames.flatMap((t) => MODES.map((m) => `${t}${m}`)).sort();

if (!tableNames.length) {
  console.error('    FAIL: no Drizzle tables found in the fixture, so nothing was measured.');
  process.exit(1);
}

const problems: string[] = [];

const emittedSchemas = Object.entries(emitted)
  .filter(([name]) => name.endsWith('Schema'))
  .sort(([a], [b]) => a.localeCompare(b));
const emittedNames = emittedSchemas.map(([name]) => name);
if (emittedNames.join(',') !== expectedSchemas.join(',')) {
  problems.push(`the barrel exports [${emittedNames.join(', ')}], not [${expectedSchemas.join(', ')}]`);
}

/**
 * One ajv instance for all of them, not one each, so two schemas claiming the same `$id` collide
 * here rather than in a consumer's document. ajv also refuses an `$id` carrying a fragment, which
 * is the mistake the components document below exists to avoid making.
 */
function instance() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv as never);
  return ajv;
}

const perTable = instance();
let compiled = 0;
for (const [name, schema] of emittedSchemas) {
  let validate: (x: unknown) => boolean;
  try {
    validate = perTable.compile(schema as never) as never;
  } catch (err) {
    // Never a skip: a schema ajv refuses is the failure this stage exists to catch.
    problems.push(`${name} does not compile under ajv strict mode: ${(err as Error).message}`);
    continue;
  }
  compiled++;

  // A schema that compiles can still be inert, so every one of them is asked to refuse something.
  //
  // On an update schema this probe is exact rather than indicative: an update requires no key, so
  // `additionalProperties: false` is the only thing in the object that can refuse an unknown one.
  // On insert and select a missing `required` key refuses it too, which makes the same probe a
  // vacuity check there rather than a statement about closedness.
  if (validate({ drzl_not_a_column: 1 })) {
    problems.push(
      name.startsWith('Update')
        ? `${name} accepts a key that is not a column, so it is no longer a closed object`
        : `${name} accepts a key that is not a column and requires nothing, so it constrains nothing`
    );
  }
  // The 2020-12 output declares its dialect. The components document strips that, and stripping it
  // only means anything while it was there to strip.
  const dialect = (schema as Record<string, unknown>).$schema;
  if (dialect !== 'https://json-schema.org/draft/2020-12/schema') {
    problems.push(`${name} declares ${JSON.stringify(dialect)} rather than the 2020-12 dialect it targets`);
  }
}
if (compiled === 0) {
  problems.push('not one emitted schema compiled, so this stage measured nothing');
}

/**
 * The components document, which is the shape an OpenAPI consumer actually reads.
 *
 * Two details are easy to get quietly wrong and both are asserted rather than assumed: a nested
 * `$schema` is read as a dialect switch by OpenAPI 3.1, and a draft 2020-12 `$id` may not contain
 * a fragment, so the obvious `#/components/schemas/<name>` makes ajv refuse the schema outright.
 * The unit tests cover both against `src`; this covers the file that ships.
 */
const components = (emitted as { components?: { schemas?: Record<string, unknown> } }).components;
if (!components?.schemas) {
  problems.push('the barrel exports no components document, so `components: true` emitted nothing');
} else {
  const names = Object.keys(components.schemas).sort();
  if (names.join(',') !== expectedComponents.join(',')) {
    problems.push(`components.schemas holds [${names.join(', ')}], not [${expectedComponents.join(', ')}]`);
  }
  const doc = instance();
  let docCompiled = 0;
  for (const [name, schema] of Object.entries(components.schemas)) {
    const s = schema as Record<string, unknown>;
    if ('$id' in s) {
      problems.push(`components.schemas.${name} carries an $id; the map key is the identity`);
    }
    if ('$schema' in s) {
      problems.push(`components.schemas.${name} carries a $schema, which 3.1 reads as a dialect switch`);
    }
    try {
      const validate = doc.compile(schema as never) as unknown as (x: unknown) => boolean;
      docCompiled++;
      // The same refusal probe the per-table schemas get. `componentsDocument` strips `$schema` and
      // `$id` and copies the rest, so an entry that constrains nothing here means the copy lost
      // more than the two keys it is supposed to lose.
      if (validate({ drzl_not_a_column: 1 })) {
        problems.push(`components.schemas.${name} accepts a key that is not a column`);
      }
    } catch (err) {
      problems.push(`components.schemas.${name} does not compile: ${(err as Error).message}`);
    }
  }
  if (docCompiled === 0) {
    problems.push('not one schema in the components document compiled');
  }
  console.log(
    `    ${compiled} emitted schemas and ${docCompiled} components schemas compile under ajv strict mode`
  );
}

if (problems.length) {
  console.error('\n    FAIL: the emitted JSON Schema output is not what a validator can read:');
  for (const p of problems) console.error(`      ${p}`);
  console.error('\n    An unknown keyword is ignored rather than rejected, so a schema that no');
  console.error('    validator refuses can still mean nothing at all.');
  process.exit(1);
}
JSON_SCHEMA_VALID

echo "==> the emitted JSON Schema compiles as a schema"
if ! npx tsx src/json-schema-valid.ts; then
  echo "FAIL: the emitted JSON Schema output is not something a validator can read." >&2
  exit 1
fi

# ---------------------------------------------------------------------------------------------
# What the output costs.
#
# Generated code lands in the consumer's bundle, and every constraint added this cycle made it
# bigger. Nothing measured that, so a change that doubled the output would have shipped as
# silently as one that halved it.
#
# The budget is per column, not per file, so adding a table to the fixture does not blow it. The
# numbers are ceilings with room above today's figure, chosen to catch a step change rather than
# to police a byte.
# ---------------------------------------------------------------------------------------------
report_size() {
  local dir="$1" lib="$2" budget="$3"
  local bytes cols per
  bytes=$(cat "$dir"/*.ts | wc -c)
  # Every column declaration in the fixture, not just one table's. Counting only the `c_` prefix
  # meant adding a second table grew the numerator and left the denominator alone, so the budget
  # fired on a change that made the output smaller per column, not bigger.
  cols=$(grep -cE '^\s+[a-z][a-z0-9_]*: ' src/schema.ts)
  per=$(( bytes / cols ))
  printf '    %-8s %6d bytes over %2d columns = %4d/column (budget %d)\n' "$lib" "$bytes" "$cols" "$per" "$budget"
  if [ "$per" -gt "$budget" ]; then
    echo "FAIL: the $lib generator emits $per bytes per column, over its $budget budget." >&2
    echo "      Generated code ships in the consumer's bundle. Raise the budget deliberately," >&2
    echo "      in a commit that says what the extra bytes buy." >&2
    return 1
  fi
}

echo "==> generated output size"
size_fail=0
# Roughly 1.35x today's figure: loose enough that adding a constraint to one column type does not
# trip it, tight enough that doubling the output does. A budget with 4x headroom catches nothing,
# which was the first draft of this.
#
# Raised once, when the fixture gained thirteen columns that each carry a CHECK. That is the
# densest output the generators produce, so the per-column average rose without any generator
# emitting more for the same input.
#
# Raised again for arktype only, 240 to 280, when the fixture gained the two-column `arrays`
# table. That raise was measured rather than guessed, because a budget raised to make a number fit
# is worth nothing, and the working is kept below.
#
# The working is arithmetic about one past edit and describes no run since. It was taken at
# `9e75c84`, against the fixture as it stood there, before the `nullable` table this branch added
# widened it, and every figure in it went stale in that one edit. What this run measures is
# printed by the lines below rather than restated here, and if the two disagree the printed ones
# are the live ones.
#
#   as measured at 9e75c84   arktype emitted 223 bytes per column over the 62 columns the fixture
#                            had then, up from 213, and those ten bytes are the bigint bound and
#                            the array element walk, both of them constraints that were missing.
#                            The two new columns cost 1803 bytes of module, about 900 each, four
#                            times the average, because a nullable capped array is the longest
#                            thing this generator emits and it is emitted once per mode. So the
#                            mixed average moved to 244 without any generator emitting more for
#                            the same input, which is the same effect recorded above for the CHECK
#                            columns, and the figures reconciled: 13827 without the table, plus
#                            1803 for the module and the 37-byte barrel line naming it, was the
#                            15667 the script printed at that revision.
report_size src/gen/pg/zod      zod      420  || size_fail=1
report_size src/gen/pg/valibot  valibot  540  || size_fail=1
report_size src/gen/pg/arktype  arktype  280  || size_fail=1
report_size src/gen/pg/typebox  typebox  430  || size_fail=1
[ "$size_fail" = 0 ] || exit 1

if ! npx tsx src/parity.ts; then
  echo "FAIL: DRZL's generated schemas diverge from the official drizzle-orm validators." >&2
  exit 1
fi

echo "==> ground truth: the emitted schemas against a real Postgres"
# Everything above compares DRZL to another library's opinion. Both can be wrong about the same
# column and neither is the authority. PGlite is a real Postgres compiled to wasm, so each probe
# value goes through an actual INSERT and the database answers directly.
#
# What is gated is narrow on purpose: DRZL must never disagree with Postgres where the official
# module agrees. A validator is deliberately stricter than a coercing driver, so most
# disagreements are correct and gating on them would be noise. Disagreeing where official does
# not means DRZL alone is wrong, which is what an over-strict check looks like. Candidate format
# patterns for date, time, macaddr and inet were all discarded because this caught them turning
# away values Postgres accepts.
cat > src/ddl.ts <<'GROUND_DDL'
/**
 * DDL matching src/schema.ts, column for column, asserted against the analysis so it cannot drift.
 *
 * Every column is nullable on purpose. Each probe inserts exactly one column, so a NOT NULL
 * sibling would fail the statement before the value under test was ever considered, and the whole
 * table would look like it rejected everything. Nullability is not what this measures: the
 * question is whether the column's *type* accepts the value.
 */
export const DDL = `
CREATE TYPE mood AS ENUM ('happy','sad','neutral');
CREATE TABLE matrix (
  c_text text,
  c_varchar varchar(255),
  c_char char(4),
  c_uuid uuid,
  c_text_enum text,
  c_varchar_enum varchar(10),
  c_int integer,
  c_smallint smallint,
  c_bigint_n bigint,
  c_bigint_b bigint,
  c_serial integer,
  c_real real,
  c_double double precision,
  c_numeric numeric(10,2),
  c_numeric_n numeric(10,2),
  c_decimal numeric,
  c_bool boolean,
  c_enum mood,
  c_json json,
  c_jsonb jsonb,
  c_jsonb_typed jsonb,
  c_date_d date,
  c_date_s date,
  c_ts_d timestamp,
  c_ts_s timestamp,
  c_time time,
  c_interval interval,
  c_text_arr text[],
  c_varchar_arr varchar(10)[],
  c_int_arr integer[],
  c_enum_arr mood[],
  c_bytea bytea,
  c_inet inet,
  c_cidr cidr,
  c_macaddr macaddr,
  c_point point,
  c_line line,
  c_geometry point,
  c_bit bit(3),
  c_vector real[]
);

CREATE TABLE defaulted (
  d_int integer default 42,
  d_zero integer default 0,
  d_neg integer default -1,
  d_text text default 'hello',
  d_empty text default '',
  d_bool_true boolean default true,
  d_bool_false boolean default false,
  d_real double precision default 1.5,
  d_enum mood default 'sad'
);

CREATE TABLE checked (
  k_min integer CHECK (k_min >= 18),
  k_max integer CHECK (k_max <= 100),
  k_lo integer CHECK (k_lo > 0),
  k_hi integer CHECK (k_hi < 10),
  k_between integer CHECK (k_between BETWEEN 5 AND 15),
  k_eq integer CHECK (k_eq = 7),
  k_in_s text CHECK (k_in_s IN ('a', 'b', 'c')),
  k_in_n integer CHECK (k_in_n IN (1, 2, 3)),
  k_len text CHECK (length(k_len) >= 3),
  k_len_max text CHECK (char_length(k_len_max) <= 5),
  k_card text[] CHECK (cardinality(k_card) >= 2),
  k_pair_a integer,
  k_pair_b integer,
  CONSTRAINT k_pair_c CHECK (k_pair_a < k_pair_b)
);
`;
GROUND_DDL

cat > src/probes.ts <<'PROBES'
/**
 * The probe pools, in one place, because more than one stage asks the database about them.
 *
 * The zod ground-truth and CHECK stages owned these inline until the JSON Schema stage arrived
 * asking the same questions of the same columns, and a second copy of a pool is a pool that
 * drifts. The emoji probes are the example that matters: they exist because a code-point count and
 * a UTF-16 `.length` disagree, and a copy that quietly lost them would stay green having stopped
 * measuring the one thing the pool was built for.
 */

/**
 * Values pushed at every column of the `matrix` table.
 *
 * Astral-plane characters are load-bearing: Postgres counts *characters* for `varchar(n)`, so a
 * 3-emoji string fits in a `varchar(5)` that every library's `.max(5)` refuses. Without these in
 * the pool no stage can see that.
 */
export const MATRIX_POOL: [string, unknown][] = [
  ['0', 0], ['1.5', 1.5], ['-1', -1], ['40000', 40000], ['2147483648', 2147483648],
  ['1e9', 1e9], ['1e300', 1e300], ['9007199254740993', 9007199254740993],
  // A `real` at full magnitude, as the text protocol returns it. Postgres accepts it and stores
  // the largest float32; a schema bounded at that float32 refuses it, which is a schema refusing
  // its own column's rows. Nothing else here is within 30 orders of magnitude of that edge, so
  // this stage asked 1400 questions and none of them was about it.
  ['3.4028235e38', 3.4028235e38],
  ['NaN', NaN], ['Infinity', Infinity],
  ["''", ''], ["'hello'", 'hello'], ['300-char', 'x'.repeat(300)],
  ['3 emoji', '\u{1F44D}\u{1F44D}\u{1F44D}'],
  ['5 emoji', '\u{1F44D}\u{1F44D}\u{1F44D}\u{1F44D}\u{1F44D}'],
  ["'0101'", '0101'], ["'010'", '010'], ["'12.5'", '12.5'], ["'1_000'", '1_000'], ["'0x1f'", '0x1f'],
  ['uuid', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'], ["'not-a-uuid'", 'not-a-uuid'],
  ["'happy'", 'happy'], ["'zzz'", 'zzz'],
  ['true', true], ['Date', new Date('2020-01-01T00:00:00Z')],
  ["'2020-01-01'", '2020-01-01'], ["'12:00:00'", '12:00:00'],
  ["['a']", ['a']], ['[1,2]', [1, 2]], ['[1,2,3]', [1, 2, 3]],
  ['{a:1}', { a: 1 }], ['Uint8Array', new Uint8Array([1, 2])],
  ["'10.0.0.1'", '10.0.0.1'], ["'999.999.999.999'", '999.999.999.999'],
];

/**
 * Values chosen to sit on both sides of every bound in the `checked` table, since a probe pool
 * that never lands on a boundary cannot tell `>` from `>=`. That distinction is most of what a
 * CHECK says.
 */
export const CHECK_PROBES: Record<string, unknown[]> = {
  k_min: [17, 18, 19, 0, -1],
  k_max: [99, 100, 101, 0],
  k_lo: [0, 1, 2, -1],
  k_hi: [8, 9, 10, 11],
  k_between: [4, 5, 10, 15, 16],
  k_eq: [6, 7, 8],
  k_in_s: ['a', 'c', 'd', '', 'A'],
  k_in_n: [1, 3, 4, 0],
  k_len: ['ab', 'abc', 'abcd', '', '\u{1F44D}\u{1F44D}\u{1F44D}'],
  k_len_max: ['abcde', 'abcdef', '', '\u{1F44D}\u{1F44D}\u{1F44D}\u{1F44D}\u{1F44D}'],
  k_card: [[], ['a'], ['a', 'b'], ['a', 'b', 'c']],
  // One side of a row-level comparison, with the other NULL. SQL leaves the CHECK satisfied, so
  // an emitted schema that rejects here would turn away rows the database takes.
  k_pair_a: [1, 100, -1],
  k_pair_b: [1, 100, -1],
};

/**
 * Both sides of the row-level check at once, which is the only way to reach it.
 *
 * Every probe above sets one column, and `CHECK (k_pair_a < k_pair_b)` is satisfied whenever
 * either side is NULL, so nothing above can tell a generator that enforces the comparison from one
 * that ignores it.
 *
 * The zod generator's own unit tests do catch a deleted row refinement, by reading the emitted
 * source. No packed or database-backed stage could: deleting all three row refinements and running
 * the pre-existing checks-truth stage against the result exits 0. So what these probes add is the
 * behavioural half, measured against Postgres rather than against a string.
 */
export const ROW_PAIR_PROBES: { row: Record<string, unknown>; satisfied: boolean }[] = [
  { row: { k_pair_a: 1, k_pair_b: 5 }, satisfied: true },
  { row: { k_pair_a: 5, k_pair_b: 1 }, satisfied: false },
  // Equal, because `<` and `<=` are one character apart and only this pair separates them.
  { row: { k_pair_a: 1, k_pair_b: 1 }, satisfied: false },
];
PROBES

cat > src/ground-truth.ts <<'GROUND_TRUTH'
/**
 * Ground truth: DRZL's schemas against Postgres itself, not against another library's opinion.
 *
 * Everything else here compares DRZL to `drizzle-orm`'s validators. Both can be wrong about the
 * same column and neither is the authority; Postgres is. PGlite runs a real Postgres in-process,
 * so every probe value can be sent through an actual INSERT and the answer compared with what the
 * two schemas predicted.
 *
 * **The Insert schema, because the question is an INSERT.** This graded `SelectmatrixSchema` for a
 * long time, which is a different schema answering a different question: a column's write type and
 * its read type are not the same type, and where they part company the verdict was simply wrong.
 * `char(4)` pads, so Postgres takes `'ab'` and returns `'ab  '`, and the Select schema's
 * `length(4)` correctly refuses the value that went in. `uuid` canonicalises, so a dashless uuid
 * goes in and a dashed one comes out. `boolean` takes the string `'yes'` and returns `true`. In
 * each case the old pairing marked a correct schema as disagreeing with Postgres, or would have
 * done had the pool carried those values. The read direction is asked separately, by the round
 * trip stage below, against the schema that describes what a read returns.
 *
 * **What is gated**: DRZL must never disagree with Postgres where the official module agrees. A
 * validator is deliberately stricter than a coercing driver, so most disagreements are correct
 * and gating on them would be noise, but disagreeing where official does not means DRZL alone is
 * wrong. That is the assertion, and it is the one that catches an over-strict check: candidate
 * patterns for `date`, `time`, `macaddr` and `inet` were all discarded because this caught them
 * turning away values Postgres accepts.
 */
import { PGlite } from '@electric-sql/pglite';
import { createInsertSchema } from 'drizzle-orm/zod';
import { matrix } from './schema.js';
import { InsertmatrixSchema as drzl } from './gen/pg/zod/matrix.zod.js';
import { DDL } from './ddl.js';
// Shared with the JSON Schema ground-truth stage, so the two ask the database the same questions
// rather than two copies of them that have drifted apart.
import { MATRIX_POOL as POOL } from './probes.js';

const db = new PGlite();
await db.exec(DDL);

const official: any = createInsertSchema(matrix);
const cols = Object.keys(official.shape);

// The DDL is hand-written, so it is checked against the analysed schema rather than trusted.
const dbCols: any = await db.query(
  `select column_name from information_schema.columns where table_name = 'matrix'`
);
const dbNames = new Set(dbCols.rows.map((r: any) => r.column_name));
const missing = cols.filter((c) => !dbNames.has(c));
if (missing.length) {
  console.error(`    FAIL: the ground-truth DDL is missing ${missing.join(', ')}`);
  process.exit(1);
}

/** Does Postgres accept this value for this column? Each probe rolls back, so nothing persists. */
async function dbAccepts(col: string, value: unknown): Promise<boolean> {
  try {
    await db.exec('BEGIN');
    await db.query(`INSERT INTO matrix (${col}) VALUES ($1)`, [value as never]);
    await db.exec('ROLLBACK');
    return true;
  } catch {
    try {
      await db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    return false;
  }
}

const ok = (schema: any, v: unknown) => {
  try {
    return schema.safeParse(v).success;
  } catch {
    return false;
  }
};

type Row = { col: string; label: string; db: boolean; drzl: boolean; off: boolean };
const rows: Row[] = [];
for (const col of cols) {
  for (const [label, value] of POOL) {
    rows.push({
      col,
      label,
      db: await dbAccepts(col, value),
      drzl: ok(drzl.shape[col], value),
      off: ok(official.shape[col], value),
    });
  }
}

/**
 * Insert-side over-permissiveness, filed and pinned rather than fixed.
 *
 * Empty, and that is a result. It held six pins: `c_date_d` and `c_ts_d` on `'0101'`, `'010'` and
 * `'12.5'`, all strings `new Date()` turns into a real date and Postgres refuses, so validation
 * passed and the INSERT then failed at the server. They appeared the moment this stage began
 * grading the Insert schema rather than the Select one; they had always been there with nothing
 * asking the question. Narrowing what a coerced string may be (AX) made all six stop firing, and a
 * pin that stops firing fails the run, which is how the fix reported itself here.
 *
 * The rule that replaced them is worth keeping in view, because the obvious one is wrong. Postgres
 * reads a 6 or 8 digit run as a compact date, so "the server refuses bare numbers" is false: ten
 * such strings are accepted by both parsers. In every one of those ten the two disagree about
 * which date it is, `'200101'` being 2020-01-01 to Postgres and the year 200101 to V8. So the test
 * is not that the server refuses the string, it is that coercing it either fails at the server or
 * silently writes a different date than the database would have stored.
 *
 * Kept rather than deleted so the next one has somewhere to go that is asserted in both directions.
 */
const DEFECTS: Record<string, { why: string; labels: string[] }> = {};

const firedDefects = new Set<string>();
const pinned = (r: Row): boolean => {
  const entry = DEFECTS[r.col];
  if (!entry || !entry.labels.includes(r.label)) return false;
  firedDefects.add(`${r.col}/${r.label}`);
  return true;
};

const drzlOnly = rows.filter((r) => r.drzl !== r.db && r.off === r.db && !pinned(r));
const offOnly = rows.filter((r) => r.off !== r.db && r.drzl === r.db);
const drzlAgrees = rows.filter((r) => r.drzl === r.db).length;
const offAgrees = rows.filter((r) => r.off === r.db).length;

console.log(`    ${rows.length} probes against a real Postgres (${cols.length} columns)`);
console.log(`    agree with the database: DRZL ${drzlAgrees}, drizzle-orm ${offAgrees}`);
console.log(`    DRZL closer than drizzle-orm on ${offOnly.length}, further on ${drzlOnly.length}`);

if (drzlOnly.length) {
  console.error('\n    FAIL: DRZL disagrees with Postgres where drizzle-orm agrees:');
  for (const r of drzlOnly.slice(0, 20)) {
    console.error(
      `      ${r.col} on ${r.label}: Postgres ${r.db ? 'accepts' : 'rejects'}, DRZL ${r.drzl ? 'accepts' : 'rejects'}`
    );
  }
  console.error('\n    A check that turns away what the database takes breaks working code.');
  await db.close();
  process.exit(1);
}

const stale: string[] = [];
for (const [col, e] of Object.entries(DEFECTS)) {
  for (const l of e.labels) if (!firedDefects.has(`${col}/${l}`)) stale.push(`${col} on ${l}`);
}
if (stale.length) {
  console.error('\n    FAIL: these DEFECTS pins matched nothing on this run:');
  for (const c of stale) console.error(`      ${c}`);
  console.error('\n    If the schema was fixed, delete them. Left here they describe nothing.');
  await db.close();
  process.exit(1);
}

await db.close();
GROUND_TRUTH

# @electric-sql/pglite is installed with the rest of this tree, far above, because the parity pass
# needs a Postgres too now. It had its own install line here, which was a second install of the
# same package into the same tree.
if ! npx tsx src/ground-truth.ts | tee -a "$WORK/printed.log"; then
  echo "FAIL: a generated schema disagrees with Postgres itself." >&2
  exit 1
fi

echo "==> round trip: the Select schemas against what Postgres hands back"
cat > src/round-trip.ts <<'ROUND_TRIP'
/**
 * Round trip: the Select schema against the value Postgres actually returns.
 *
 * The stage above sends each probe through an `INSERT` and grades `SelectmatrixSchema` on the
 * answer. Those are two different questions. A column's write type and its read type are not the
 * same type: `geometry` is written as `point(1 2)` and read back as `[1, 2]`, `bigint` in `bigint`
 * mode is written as a number and read back as a `bigint`, and a `timestamp` in `date` mode is
 * written as either and always read back as a `Date`. Grading a read schema on a write answer is
 * right only for the columns where the two coincide, and nothing in the stage above distinguishes
 * those columns from the rest.
 *
 * So this asks the read question directly: put a value in, take it back out, and check the value
 * that came out against the schema that describes values coming out.
 *
 * **The row is read through drizzle, not through the driver.** `client.query` returns Postgres's
 * wire representation, which is very nearly all strings; `mapFromDriverValue` is what turns that
 * into the `Date`, the `bigint`, the tuple and the `Uint8Array` a caller actually receives, and it
 * is the caller's value that the Select schema exists to describe. Reading raw would grade the
 * schema against a row no user of this library will ever hold.
 *
 * **The gate is absolute here, not relative.** Every other stage tolerates DRZL being stricter
 * than the database on the grounds that a validator is meant to be stricter than a coercing
 * driver. That reasoning is about untrusted input and it does not reach this direction: the value
 * did not come from a caller, it came out of the database through the very driver the schema
 * claims to describe. A Select schema that rejects a row Postgres just produced fails on real
 * rows, in production, on the read path, and no amount of official-module agreement makes it
 * correct. So there is no comparison against `drizzle-orm/zod` in the gate. Its verdict is printed
 * beside DRZL's because a column both libraries reject is worth seeing, but it suppresses nothing.
 *
 * **A probe that never landed measures nothing.** Postgres refuses most of the pool for most
 * columns, which is the point of the pool, so most pairs here produce no row at all and are
 * skipped. A column where *every* probe is refused would then be silently unmeasured while the
 * totals still looked healthy, so the count of landed probes per column is asserted to be nonzero
 * rather than assumed.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createSelectSchema } from 'drizzle-orm/zod';
import { matrix } from './schema.js';
import { SelectmatrixSchema as drzl } from './gen/pg/zod/matrix.zod.js';
import { DDL } from './ddl.js';
import { MATRIX_POOL as POOL } from './probes.js';

/**
 * Columns whose Select schema is narrower than the column type on purpose.
 *
 * The gate below says a schema rejecting a returned row is wrong. That holds where the column type
 * is the whole constraint, and these are the columns where it is not: `text({ enum })` and
 * `varchar({ enum })` narrow in TypeScript, the DDL carries no CHECK, so Postgres takes anything
 * and hands it straight back. A schema that ignored the declared enum to match the database would
 * be the defect, not the fix.
 *
 * Asserted in both directions, and the second direction is the one that matters. Excusing the
 * column outright would also excuse it rejecting `'a'`, which is the shape a completely broken
 * enum schema takes. So every rejection here has to be a value *outside* the declared set, and at
 * least one value *inside* it has to have round-tripped and been accepted, or the waiver is
 * covering a schema that has stopped accepting its own declared values.
 */
const ALLOWED: Record<string, { why: string; narrowedTo: unknown[] }> = {
  c_text_enum: {
    why: 'text({ enum }) narrows in TypeScript; the column is plain text with no CHECK',
    narrowedTo: ['a', 'b', 'c'],
  },
  c_varchar_enum: {
    why: 'varchar({ enum }) narrows in TypeScript; the column is varchar(10) with no CHECK',
    narrowedTo: ['x', 'y'],
  },
};

/**
 * Values the driver hands back that no correct schema can accept.
 *
 * Distinct from the narrowing above and kept apart from it on purpose: there the schema is
 * deliberately tighter than the column, here the schema is exactly right and the *value* is the
 * problem. `bigint({ mode: 'number' })` is the case. Postgres stores 9007199254740993 exactly, the
 * driver converts it to a JS number to satisfy the declared mode, and 9007199254740992 comes back:
 * a different integer, and one past `Number.MAX_SAFE_INTEGER`, so it is not a faithful reading of
 * the row. Both libraries reject it and both are right to.
 *
 * Pinned by the value that went in and the value that came out, so a change to either is a new
 * finding. Merging this into the ledger above would let "the driver corrupted this" hide inside
 * "the schema is narrower on purpose", and those want opposite responses.
 */
const LOSSY: Record<string, { why: string; cases: { label: string; returned: string }[] }> = {
  c_bigint_n: {
    why: 'mode number cannot hold a bigint past 2^53; the driver returns a neighbouring integer',
    cases: [{ label: '9007199254740993', returned: '9007199254740992' }],
  },
};

/**
 * Extra values for columns the shared pool cannot reach at all.
 *
 * `MATRIX_POOL` exists to push every value at every column, and for a handful of composite types
 * nothing in it is even syntactically a value: `line` wants `{1,2,3}`, an enum array wants
 * `{happy,sad}`. Those columns take nothing, so without a seed they are measured by nothing, and
 * widening the shared pool to reach them would change the answers of the three other stages that
 * read it.
 *
 * Asserted in both directions. A seed that Postgres refuses fails the run, because a seed exists
 * to land and one that does not is a typo sitting where a measurement should be. A seed for a
 * column the pool already reaches fails it too: the pool got there first, so the entry adds
 * nothing and is only waiting to be mistaken for coverage.
 */
const SEED: Record<string, string[]> = {
  c_enum_arr: ['{happy,sad}'],
  c_line: ['{1,2,3}'],
};

/**
 * Columns this fixture cannot read back, because the DDL type stands in for an extension type.
 *
 * PGlite ships neither PostGIS nor pgvector, so `geometry` is declared here as a native `point`
 * and `vector` as a `real[]`. Both take a value happily and neither can be read: drizzle's
 * `mapFromDriverValue` for those columns decodes what the real extension returns, PostGIS's EWKB
 * hex and pgvector's `[1,2,3]` text, and a native `point` or `real[]` hands it something else
 * entirely. So the failure is a fact about the stand-in and not about anything generated here, and
 * gating on it would file a defect against code that is correct in production.
 *
 * Declared rather than skipped, and asserted in both directions like the rest. The error is pinned
 * by substring, so a *different* read failure on the same column is a new finding. An entry whose
 * column reads back cleanly fails the run: that means the stand-in started working, and the column
 * should rejoin the measured set rather than sit here excused forever.
 */
const STANDIN: Record<string, { why: string; error: string }> = {
  c_geometry: {
    why: 'declared point, not PostGIS geometry; parseEWKB reads a native point as a truncated buffer',
    error: 'Offset is outside the bounds of the DataView',
  },
  c_vector: {
    why: 'declared real[], not pgvector; PGlite parses it to an array before the text mapper sees it',
    error: 'split is not a function',
  },
};

/**
 * The whole reason a call failed, not just the outermost sentence.
 *
 * drizzle wraps a driver error in a `DrizzleQueryError` whose own message is `Failed query: <sql>`,
 * which names the statement and says nothing about what went wrong with it. Reading only that top
 * line turns every distinct failure in a run into the same uninformative string, grouped under a
 * heading that looks like an explanation and is not one.
 */
const explain = (err: unknown): string => {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    const msg = String((cur as Error)?.message ?? cur).split('\n')[0].trim();
    if (msg && !parts.includes(msg)) parts.push(msg);
    cur = (cur as { cause?: unknown })?.cause;
  }
  return parts.join(' <- ') || String(err);
};

const client = new PGlite();
await client.exec(DDL);
// `{ client }` and not `drizzle(client, ...)`. Handed a PGlite instance positionally, this driver
// does not recognise it as a client: it reads it as a config object, finds no connection in it,
// and quietly constructs a *second* PGlite, which defaults to a fresh in-memory database. Every
// read then runs against an empty one. That failure announces itself as `relation "matrix" does
// not exist` from inside a `Failed query:` wrapper, which reads like a broken statement rather
// than a connection pointed somewhere else.
const db = drizzle({ client, schema: { matrix } });

// So the connection is asserted rather than assumed. Nothing else in this stage can tell a schema
// that accepts every row from a database that returned none, and the difference is one sentence
// here versus a green run that measured nothing.
const seen: any = await db.execute(`select 1 as ok from "matrix" limit 1`).catch((err: unknown) => {
  console.error(`    FAIL: drizzle cannot see the table the DDL just created: ${explain(err)}`);
  console.error('    The client is not the one this stage populated, so no result here means anything.');
  process.exit(1);
});
void seen;

const official: any = createSelectSchema(matrix);
const cols = Object.keys(official.shape);

/** How a value is written down in a report, close enough to read and short enough to scan. */
const show = (v: unknown): string => {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'bigint') return `${v}n`;
  if (v instanceof Date) return `Date(${v.toISOString()})`;
  if (v instanceof Uint8Array) return `Uint8Array(${v.length})`;
  // Before the JSON fallback, because `JSON.stringify` renders NaN, Infinity and -Infinity as the
  // string "null". Three real values Postgres stores and returns were printed here as nulls, and
  // the reading built on that was a whole false explanation: a nullable fixture handing back a
  // null the schema was right to refuse. They are numbers, the schema refuses them, and that is a
  // defect. A formatter that quietly renames a value can turn a finding into a waiver.
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

/**
 * What the driver hands a caller for this column, or the reason there is no such value.
 *
 * The refusal carries what Postgres said. A bare `refused` reads every failed statement as the
 * database declining the value, which is only sometimes what happened: a malformed statement, a
 * missing table and a broken connection all arrive at the same `catch`. Keeping the message is
 * what lets the barren report below distinguish "this column turned away the whole pool" from
 * "nothing was ever asked", and those need opposite fixes.
 */
type Trip =
  | { got: true; back: unknown }
  | { got: false; reason: 'refused'; error: string }
  | { got: false; reason: 'unmapped'; error: string };

/**
 * One value in and back out again, with the table emptied afterwards.
 *
 * The insert is raw and the read goes through drizzle on purpose. Writing through drizzle would
 * put `mapToDriverValue` between the pool and the database and quietly narrow what can land: the
 * pool is deliberately full of values drizzle would refuse to serialise, and those are exactly the
 * rows a caller can still end up reading because some other writer put them there.
 *
 * A `DELETE` and not a rolled-back transaction, because those two paths cannot be interleaved on
 * one PGlite client. `exec` speaks the simple query protocol and drizzle's select speaks the
 * extended one, and a `ROLLBACK` issued between them arrives mid-exchange: PGlite answers `08P01
 * invalid message format` from `pq_getmsgend` and takes the process down. Nothing is committed
 * that a delete cannot undo here, since every probe writes one row to one table.
 */
async function roundTrip(col: string, label: string, value: unknown): Promise<Trip> {
  try {
    await client.query(`INSERT INTO matrix (${col}) VALUES ($1)`, [value as never]);
  } catch (err) {
    return {
      got: false,
      reason: 'refused',
      error: explain(err),
    };
  }
  let trip: Trip;
  try {
    const rows = await db.select({ v: (matrix as any)[col] }).from(matrix);
    // Exactly one row was just written and the table was emptied before it. No row means the
    // harness lost it, and reading `rows[0]?.v` there would hand `undefined` to the schema as
    // though the database had returned it, turning a bookkeeping slip into a finding about a
    // value that was never fetched.
    if (rows.length !== 1) {
      console.error(`    FAIL: ${col} on ${label} wrote a row and read back ${rows.length}.`);
      await client.close();
      process.exit(1);
    }
    trip = { got: true, back: rows[0].v };
  } catch (err) {
    trip = { got: false, reason: 'unmapped', error: explain(err) };
  }
  await client.query('DELETE FROM matrix');
  return trip;
}

/**
 * A schema's verdict, or the fact that it has none.
 *
 * A thrown schema is not a rejection and is not recorded as one. Writing `false` into that slot
 * from a `catch` would turn a crashing validator into a finding about the value, which is a
 * different claim about a different thing.
 */
type Verdict = { answered: true; ok: boolean } | { answered: false; error: string };
const verdict = (schema: any, v: unknown): Verdict => {
  try {
    return { answered: true, ok: schema.safeParse(v).success };
  } catch (err) {
    return { answered: false, error: explain(err) };
  }
};

type Bad = { col: string; label: string; back: unknown; off: Verdict };
const rejected: Bad[] = [];
const unmapped: { col: string; label: string; error: string }[] = [];
const crashed: { col: string; label: string; error: string }[] = [];
const landedPerCol: Record<string, number> = {};
/** What Postgres actually said, per column, so a barren column can be explained rather than guessed at. */
const refusals: Record<string, Set<string>> = {};
/** Returned values the schema took, kept so a narrowing waiver can be shown to still admit its own set. */
const acceptedBack: Record<string, unknown[]> = {};
let landed = 0;
let bothRejected = 0;

/** One probe, graded. Shared by the pool pass and the seed pass so both are measured identically. */
async function measure(col: string, label: string, value: unknown): Promise<boolean> {
  const trip = await roundTrip(col, label, value);
  if (!trip.got) {
    if (trip.reason === 'unmapped') unmapped.push({ col, label, error: trip.error });
    else (refusals[col] ??= new Set()).add(trip.error);
    return false;
  }
  landedPerCol[col]++;
  landed++;
  const mine = verdict((drzl as any).shape[col], trip.back);
  if (!mine.answered) {
    crashed.push({ col, label, error: mine.error });
    return true;
  }
  if (mine.ok) {
    (acceptedBack[col] ??= []).push(trip.back);
    return true;
  }
  const off = verdict(official.shape[col], trip.back);
  if (off.answered && !off.ok) bothRejected++;
  rejected.push({ col, label, back: trip.back, off });
  return true;
}

for (const col of cols) {
  landedPerCol[col] = 0;
  for (const [label, value] of POOL) await measure(col, label, value);
}

// Which columns the shared pool reached on its own, captured before the seeds run, because the
// assertion below is about what the pool could do without them.
const reachedByPool = new Set(cols.filter((c) => landedPerCol[c] > 0));

const deadSeeds: string[] = [];
const idleSeeds: string[] = [];
for (const [col, values] of Object.entries(SEED)) {
  if (reachedByPool.has(col)) idleSeeds.push(col);
  for (const v of values) {
    const before = landedPerCol[col];
    await measure(col, `seed ${v}`, v);
    if (landedPerCol[col] === before && !STANDIN[col]) deadSeeds.push(`${col}: ${v}`);
  }
}

// Each narrowed column is probed with its own declared values, so the proof that it still accepts
// them does not depend on the shared pool happening to contain an enum member. It does not: there
// is no bare 'a', 'x' or 'y' anywhere in it. `c_text_enum` looked proven only because PGlite
// coerces the array probe `['a']` to the string `a` on the way into a text column, which is an
// accident of JavaScript's array-to-string rule and not a value anyone chose to test.
for (const [col, e] of Object.entries(ALLOWED)) {
  for (const v of e.narrowedTo) await measure(col, `declared ${show(v)}`, v);
}

console.log(`    ${landed} rows read back through the driver (${cols.length} columns)`);
console.log(`    rejected by DRZL: ${rejected.length}, of which drizzle-orm also rejects: ${bothRejected}`);

if (deadSeeds.length) {
  console.error('\n    FAIL: these seeds do not go into their column, so they seed nothing:');
  for (const d of deadSeeds) console.error(`      ${d}`);
  await client.close();
  process.exit(1);
}
if (idleSeeds.length) {
  console.error('\n    FAIL: the pool already reaches these columns, so their seeds add nothing:');
  for (const c of idleSeeds) console.error(`      ${c}`);
  await client.close();
  process.exit(1);
}

// A read that fails has to be declared. drizzle failing to decode a value drizzle's own database
// stored is not a defect in anything generated here, but leaving it merely printed made the two
// stand-in columns look measured while nothing about them was ever checked. Printed first because
// it is the likeliest explanation for the barren failure below, and an earlier draft exited on
// that check while holding the reason for it in this list, unprinted.
if (unmapped.length) {
  const byError: Record<string, string[]> = {};
  for (const u of unmapped) (byError[u.error] ??= []).push(u.col);
  console.log(`    drizzle could not map ${unmapped.length} stored value(s) back:`);
  for (const [error, where] of Object.entries(byError).slice(0, 5)) {
    const cs = [...new Set(where)];
    console.log(`      ${error} (${cs.length} column(s), e.g. ${cs.slice(0, 3).join(', ')})`);
  }
}
const undeclared = unmapped.filter((u) => {
  const pin = STANDIN[u.col];
  return !pin || !u.error.includes(pin.error);
});
if (undeclared.length) {
  console.error('\n    FAIL: a stored row could not be read back, and nothing here says why:');
  for (const u of undeclared.slice(0, 10)) console.error(`      ${u.col} on ${u.label}: ${u.error}`);
  console.error('\n    Either the driver regressed, or this column needs a STANDIN entry naming');
  console.error('    the fixture type that stands in for it and the error that stand-in produces.');
  await client.close();
  process.exit(1);
}
const healed = Object.keys(STANDIN).filter((c) => !unmapped.some((u) => u.col === c));
if (healed.length) {
  console.error('\n    FAIL: these STANDIN columns read back cleanly now:');
  for (const c of healed) console.error(`      ${c}: ${STANDIN[c].why}`);
  console.error('\n    The stand-in started working. Delete the entry so the column is measured.');
  await client.close();
  process.exit(1);
}

// A column that never held a row was never asked about. Reported before the verdicts below,
// because a green result here means nothing for such a column and the reader has to know which.
// The two STANDIN columns are barren by construction and excused above, not here.
const barren = cols.filter((c) => landedPerCol[c] === 0 && !STANDIN[c]);
if (barren.length) {
  console.error('\n    FAIL: these columns took none of the pool, so nothing was measured about them:');
  for (const c of barren.slice(0, 8)) {
    const why = [...(refusals[c] ?? [])].slice(0, 2).join(' | ');
    const stuck = unmapped.filter((u) => u.col === c).length;
    console.error(`      ${c}: ${why || 'nothing refused'}${stuck ? ` (+${stuck} inserted but unreadable)` : ''}`);
  }
  if (barren.length > 8) console.error(`      ... and ${barren.length - 8} more`);
  console.error('\n    Read the reason before touching the pool. "invalid input syntax" is this column');
  console.error('    turning the pool away, and "inserted but unreadable" is the opposite: the row');
  console.error('    went in and the read is what failed, which the pool cannot fix.');
  await client.close();
  process.exit(1);
}

if (crashed.length) {
  console.error('\n    FAIL: a DRZL schema threw on a value the database returned:');
  for (const c of crashed.slice(0, 10)) console.error(`      ${c.col} on ${c.label}: ${c.error}`);
  await client.close();
  process.exit(1);
}

/**
 * A returned `null` on a column the schema declares `.notNull()`.
 *
 * Not a ledger, because it is not a per-column fact: the fixture DDL makes *every* column
 * nullable so that a probe inserting one column is not defeated by a NOT NULL sibling, while the
 * drizzle schema declares them all `.notNull()`. So this table can hand back a null that the real
 * table it describes never could, and a schema refusing it is reading the declaration correctly.
 *
 * The `.notNull()` is checked on the column rather than assumed, so this cannot quietly grow into
 * "nulls are always fine": on a genuinely nullable column a rejected null is a real finding and
 * still fails below.
 */
/**
 * Rejections that are DRZL's own defect, filed and pinned rather than fixed.
 *
 * Empty, and that is a result rather than a default. It held five pins when this stage was written:
 * `c_real` and `c_double` on NaN and on Infinity, and `c_numeric_n` on NaN, all cases where Postgres
 * stores a value, returns it, and the emitted schema refused it. Fixing that (AW) made every one of
 * them stop firing, and a pin that stops firing fails the run, which is how the fix reported itself
 * here rather than needing to be checked for by hand.
 *
 * Kept rather than deleted so the next one has somewhere to go that is asserted in both directions.
 */
const DEFECTS: Record<string, { why: string; cases: { label: string; returned: string }[] }> = {};

const excusedNarrow = new Set<string>();
const excusedLossy = new Set<string>();
const firedCases = new Set<string>();
const insideOwnSet: Bad[] = [];

const unexcused = rejected.filter((r) => {
  // A stand-in column's read path is not measuring this library at all, so neither its thrown
  // reads nor its wrong values are findings. That exclusion is what the healed check above keeps
  // honest: it fails the moment the stand-in starts reading back cleanly.
  if (STANDIN[r.col]) return false;

  const narrow = ALLOWED[r.col];
  if (narrow) {
    // Rejecting a value the column declares it accepts is the failure this waiver must not cover.
    if (narrow.narrowedTo.some((v) => Object.is(v, r.back))) {
      insideOwnSet.push(r);
      return false;
    }
    excusedNarrow.add(r.col);
    return false;
  }

  for (const [name, ledger] of [['LOSSY', LOSSY], ['DEFECTS', DEFECTS]] as const) {
    const entry = ledger[r.col];
    if (!entry) continue;
    const hit = entry.cases.find((c) => c.label === r.label && c.returned === show(r.back));
    if (!hit) return true;
    firedCases.add(`${name}/${r.col}/${hit.label}`);
    excusedLossy.add(r.col);
    return false;
  }
  return true;
});

if (insideOwnSet.length) {
  console.error('\n    FAIL: a narrowed column rejects a value it declares it accepts:');
  for (const r of insideOwnSet) console.error(`      ${r.col}: returned ${show(r.back)}`);
  console.error('\n    The ALLOWED entry is about values outside the declared set. This is inside it.');
  await client.close();
  process.exit(1);
}

if (unexcused.length) {
  console.error('\n    FAIL: a DRZL Select schema rejects a row Postgres just returned:');
  // Grouped by column, because these arrive in column order and a flat list truncated at twenty
  // shows one column's rejections and hides how many others there are.
  const byCol: Record<string, Bad[]> = {};
  for (const r of unexcused) (byCol[r.col] ??= []).push(r);
  for (const [col, rs] of Object.entries(byCol)) {
    const alsoOff = rs.filter((r) => r.off.answered && !r.off.ok).length;
    console.error(`      ${col}: ${rs.length} rejected (drizzle-orm rejects ${alsoOff} of them)`);
    for (const r of rs.slice(0, 3)) {
      console.error(`        on ${r.label}: driver returned ${show(r.back)} (typeof ${typeof r.back})`);
    }
    if (rs.length > 3) console.error(`        ... and ${rs.length - 3} more`);
  }
  console.error('\n    This value came out of the database through the driver the schema describes.');
  console.error('    Every read of such a row fails validation, so the schema is wrong, not the row.');
  await client.close();
  process.exit(1);
}

const staleNarrow = Object.keys(ALLOWED).filter((c) => !excusedNarrow.has(c));
if (staleNarrow.length) {
  console.error('\n    FAIL: these ALLOWED entries excused nothing on this run:');
  for (const c of staleNarrow) console.error(`      ${c}: ${ALLOWED[c].why}`);
  console.error('\n    If the schema was fixed, delete them. Left here they describe nothing.');
  await client.close();
  process.exit(1);
}

// The other half of the narrowing assertion. Above proves the waiver covered something; this
// proves it did not cover everything. A schema that had stopped accepting its own enum members
// would produce no rejection inside the set to catch, because nothing inside the set would ever
// have round-tripped, so the absence has to be checked directly.
const unproven = Object.entries(ALLOWED).filter(
  ([c, e]) => !e.narrowedTo.some((v) => (acceptedBack[c] ?? []).some((b) => Object.is(b, v)))
);
if (unproven.length) {
  console.error('\n    FAIL: no declared value of these narrowed columns round-tripped and was accepted:');
  for (const [c, e] of unproven) {
    console.error(`      ${c}: expected one of ${e.narrowedTo.map(show).join(', ')} to come back and pass`);
  }
  console.error('\n    Without that, the waiver would equally cover a schema that accepts nothing.');
  await client.close();
  process.exit(1);
}

const stalePins: string[] = [];
for (const [name, ledger] of [['LOSSY', LOSSY], ['DEFECTS', DEFECTS]] as const) {
  for (const [c, e] of Object.entries(ledger)) {
    for (const k of e.cases) {
      if (!firedCases.has(`${name}/${c}/${k.label}`)) stalePins.push(`${name} ${c} on ${k.label}`);
    }
  }
}
if (stalePins.length) {
  console.error('\n    FAIL: these pinned cases did not happen on this run:');
  for (const c of stalePins) console.error(`      ${c}`);
  console.error('\n    A DEFECTS pin that stops firing is the fix landing: delete it. A LOSSY pin');
  console.error('    that stops firing means the driver changed what it returns.');
  await client.close();
  process.exit(1);
}
void excusedLossy;

await client.close();
ROUND_TRIP

# The stage prints its own verdict and exits non-zero on it. This line says only that it did not
# finish, because a crash is not a verdict: earlier runs died on a PGlite protocol error and on a
# connection pointed at an empty database, and both were announced here as a Select schema
# rejecting a row, which is a specific accusation neither run was in a position to make.
if ! npx tsx src/round-trip.ts | tee -a "$WORK/printed.log"; then
  echo "FAIL: the Select round trip did not pass. Its own output above says why." >&2
  exit 1
fi

cat > src/json-schema-truth.ts <<'JSON_SCHEMA_TRUTH'
/**
 * The emitted JSON Schema against Postgres itself.
 *
 * The zod ground-truth stage above asks whether a generated validator agrees with the database.
 * This asks the same question of the generator that emits a published API contract, which until
 * now was compared with nothing at all: not with a database, not with its siblings, not with a
 * validator.
 *
 * **The value has to be the same value.** A JSON Schema describes a document, and a document
 * cannot carry a `Date`, a `Uint8Array` or a `bigint`; those travel as an ISO string, as base64 and
 * as digits. So each probe is converted once and the database, the reference and the schema are
 * all asked about the converted value. An earlier draft asked Postgres about the JavaScript value
 * and ajv about its encoding, and reported 31 disagreements, every one of which was two different
 * questions rather than one answer: Postgres had been shown a `Uint8Array` and ajv the string
 * `"AQI="`.
 *
 * **What is gated**: the schema must never disagree with Postgres where the zod output agrees.
 * There is no official JSON Schema generator to be the reference, so zod stands in for one: it is
 * already gated against both this database and the first-party `drizzle-orm/zod` module, so where
 * zod matches Postgres and this does not, this one is alone and wrong. Where both differ from the
 * database it is the deliberate a-validator-is-stricter-than-a-driver gap the other stages already
 * tolerate, and it is counted rather than gated.
 */
import { PGlite } from '@electric-sql/pglite';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { SelectmatrixSchema as jsonSelect } from './gen/pg/json-schema/matrix.schema.js';
import { SelectmatrixSchema as zodSelect } from './gen/pg/zod/matrix.zod.js';
import { DDL } from './ddl.js';
import { MATRIX_POOL } from './probes.js';

/**
 * A probe as it appears inside a JSON document.
 *
 * Tagged rather than nullable, because "there is no JSON form" and "the JSON form is `null`" are
 * different facts and `JSON.stringify` conflates them: it turns `NaN` into `null`, which is a value
 * the schema has an opinion about and the probe never was.
 */
type JsonForm = { carried: true; value: unknown } | { carried: false; why: string };

function asJson(value: unknown): JsonForm {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { carried: false, why: 'JSON has no NaN and no Infinity' };
  }
  if (typeof value === 'bigint') return { carried: true, value: value.toString() };
  if (value instanceof Date) return { carried: true, value: value.toISOString() };
  if (value instanceof Uint8Array) {
    return { carried: true, value: Buffer.from(value).toString('base64') };
  }
  return { carried: true, value };
}

const db = new PGlite();
await db.exec(DDL);

const props = (jsonSelect as unknown as { properties: Record<string, unknown> }).properties;
const cols = Object.keys(props);
const zodShape = (zodSelect as unknown as {
  shape: Record<string, { safeParse(v: unknown): { success: boolean } }>;
}).shape;

// The two generators have to be describing the same table, or a column missing from one of them
// would simply not be compared and the run would go quiet about it.
const zodCols = Object.keys(zodShape).sort();
if (cols.slice().sort().join(',') !== zodCols.join(',')) {
  console.error('    FAIL: the JSON Schema and zod outputs describe different columns.');
  console.error(`      json-schema: ${cols.slice().sort().join(', ')}`);
  console.error(`      zod:         ${zodCols.join(', ')}`);
  await db.close();
  process.exit(1);
}

// One validator per column, compiled from that column's subschema, which is the JSON Schema
// equivalent of reaching into zod's `.shape`. Compiling the whole object instead would answer a
// different question: every probe sets one column, and a whole-row schema would refuse the row for
// the thirty-nine columns the probe left out.
const validators: Record<string, (x: unknown) => boolean> = {};
for (const [col, sub] of Object.entries(props)) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv as never);
  validators[col] = ajv.compile(sub as never) as never;
}

/**
 * Does Postgres accept this value for this column? Each probe rolls back, so nothing persists.
 *
 * The refusal and the message behind it are both kept. The message decides nothing, but a column
 * that accepts nothing at all has to be explained before it can be set aside, and this reads any
 * failure as a refusal: it cannot tell "the database refused this value" from "the driver never
 * sent this value". Printing what Postgres actually said is what lets a reader check the recorded
 * reason instead of taking it on trust.
 */
type DbVerdict = { accepted: true } | { accepted: false; error: string };
async function dbAccepts(col: string, value: unknown): Promise<DbVerdict> {
  try {
    await db.exec('BEGIN');
    await db.query(`INSERT INTO matrix (${col}) VALUES ($1)`, [value as never]);
    await db.exec('ROLLBACK');
    return { accepted: true };
  } catch (err) {
    try {
      await db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    return { accepted: false, error: String((err as Error)?.message ?? err).split('\n')[0] };
  }
}

/**
 * The reference's verdict, or the fact that it has none.
 *
 * A thrown reference is not a rejection. The gate fires only where zod agrees with Postgres, so a
 * `false` written into that slot by a `catch` can move an over-strict finding into the tolerated
 * bucket and silence the gate. Neither an error nor an absence is a value here either.
 */
type RefVerdict = { answered: true; ok: boolean } | { answered: false; error: string };
const zodVerdict = (col: string, value: unknown): RefVerdict => {
  try {
    return { answered: true, ok: zodShape[col].safeParse(value).success };
  } catch (err) {
    return { answered: false, error: String((err as Error)?.message ?? err).split('\n')[0] };
  }
};

/**
 * Every conversion above has to have been exercised, or the pool quietly stopped covering the cases
 * the conversion exists for. Counted rather than assumed: a pool that lost its `Date` probe would
 * leave `format: 'date-time'` measured by nothing while the totals still looked healthy.
 */
const converted = { date: 0, binary: 0, none: 0 };
const pool: { label: string; value: unknown }[] = [];
for (const [label, raw] of MATRIX_POOL) {
  if (raw instanceof Date) converted.date++;
  else if (raw instanceof Uint8Array) converted.binary++;
  const form = asJson(raw);
  if (!form.carried) {
    converted.none++;
    continue;
  }
  pool.push({ label, value: form.value });
}
const unexercised = Object.entries(converted)
  .filter(([, n]) => n === 0)
  .map(([k]) => k);
if (unexercised.length) {
  console.error(`    FAIL: the probe pool no longer contains a value needing the ${unexercised.join(', ')}`);
  console.error('          conversion, so that branch of the JSON encoding is measured by nothing.');
  await db.close();
  process.exit(1);
}

type Row = { col: string; label: string; db: boolean; json: boolean; zod: boolean };
const rows: Row[] = [];
/**
 * The distinct *kinds* of refusal Postgres gave per column, kept as evidence for the set below.
 *
 * The quoted value is stripped out, because Postgres embeds it and a set keyed on the raw message
 * is one entry per probe, which is a wall of text rather than evidence. What is left is the shape
 * of the complaint, and that is the part that distinguishes the three exempt columns: `c_enum_arr`
 * answers `malformed array literal` to the number 0 and to `['happy']` alike, which is the driver
 * flattening both into a bare string before Postgres ever parses them, while `c_line` answers
 * `invalid input syntax for type line`, which is Postgres reading exactly what was sent.
 */
const kindOf = (message: string) => message.replace(/"[^"]*"/g, '"..."');
const refusalMessages: Record<string, Set<string>> = {};
const unanswered: string[] = [];
for (const col of cols) {
  for (const { label, value } of pool) {
    const verdict = await dbAccepts(col, value);
    if (!verdict.accepted) (refusalMessages[col] ??= new Set()).add(kindOf(verdict.error));
    const ref = zodVerdict(col, value);
    if (!ref.answered) {
      unanswered.push(`${col} on ${label}: ${ref.error}`);
      continue;
    }
    rows.push({ col, label, db: verdict.accepted, json: validators[col](value), zod: ref.ok });
  }
}

if (unanswered.length) {
  console.error('\n    FAIL: the zod reference threw rather than answering, so the gate has no filter:');
  for (const u of unanswered.slice(0, 20)) console.error(`      ${u}`);
  console.error('\n    This gate fires only where zod agrees with Postgres. A thrown reference read as');
  console.error('    a rejection would move an over-strict finding into the tolerated bucket.');
  await db.close();
  process.exit(1);
}

/**
 * The columns Postgres has no verdict to give about, each with the reason it has none.
 *
 * A column the database accepts nothing for cannot be compared: agreement would require a schema
 * that accepts nothing either. That is a real state rather than a waiver, but it is only honest
 * while every member is understood, because `dbAccepts` reads any failure as a refusal and cannot
 * tell a database verdict from a driver that never sent the value. The three below are three
 * different reasons, and only the first was worked out when this stage was written.
 *
 * An earlier version derived the set and printed it. Review forced thirty-nine of the forty
 * columns into it and the stage printed thirty-nine lines and exited 0, then replaced one excluded
 * column's subschema with an object that accepts anything and the stage stayed green. So the set is
 * asserted, both ways: a fourth member fails, and a member that stops belonging fails too, because
 * the moment the database can answer for one of these the exemption is stale and has to go.
 */
const NO_VERDICT: Record<string, string> = {
  c_bytea:
    'the JSON form is base64 text the consumer decodes before Drizzle sees it, so Postgres is ' +
    'never shown the string the schema describes. A bound bytea parameter takes bytes and refuses ' +
    'every string, including the exact base64 of a Uint8Array the same column accepts unencoded.',
  c_enum_arr:
    'PGlite cannot bind a JavaScript array to a user-defined enum array, so Postgres is asked ' +
    'about `happy` rather than `{happy}`. Its answer is about a value the probe never sent. ' +
    '`c_text_arr` binds fine and `c_enum` binds fine, so this is the pair, not either half.',
  c_line:
    'the shared pool holds no `line` literal. Postgres does accept `{1,2,3}` here, so adding one ' +
    'would make the column measurable; the row would land in the tolerated bucket, since the zod ' +
    'output emits a tuple and refuses the string too.',
};

const unanswerable = cols.filter((c) => !rows.some((r) => r.col === c && r.db));
const unexplained = unanswerable.filter((c) => !(c in NO_VERDICT));
const stale = Object.keys(NO_VERDICT).filter((c) => !unanswerable.includes(c));
if (unexplained.length || stale.length) {
  console.error('\n    FAIL: the set of columns Postgres has no verdict about is not the expected one.');
  for (const c of unexplained) {
    const asked = rows.filter((r) => r.col === c).length;
    console.error(`      ${c} accepted none of its ${asked} probes and no reason is recorded for it.`);
    for (const m of refusalMessages[c] ?? []) console.error(`        Postgres said: ${m}`);
  }
  for (const c of stale) {
    console.error(`      ${c} is listed as having no verdict, and Postgres now accepts something for it.`);
    console.error('        The entry is stale: delete it and let the column be compared like the rest.');
  }
  console.error('\n    Setting a column aside is only honest while its reason is written down. Work out');
  console.error('    whether the database is refusing the value or the driver never sent it, then say so');
  console.error('    in NO_VERDICT, or fix the fixture so the question can be asked.');
  await db.close();
  process.exit(1);
}

/**
 * A column the database cannot judge still has to be constrained by something.
 *
 * Otherwise the exemption is a place to hide an empty schema: review replaced one excluded column's
 * subschema with `{ description: '...' }`, which accepts every value there is, and nothing noticed.
 */
const inert = unanswerable.filter((c) => pool.every(({ value }) => validators[c](value)));
if (inert.length) {
  console.error('\n    FAIL: a column set aside for having no database verdict constrains nothing either:');
  for (const c of inert) console.error(`      ${c} accepts all ${pool.length} probes`);
  console.error('\n    Nothing can check these against the database, so an inert schema here is invisible');
  console.error('    everywhere else too.');
  await db.close();
  process.exit(1);
}

const measured = rows.filter((r) => !unanswerable.includes(r.col));
const findings = measured.filter((r) => r.json !== r.db && r.zod === r.db);
const shared = measured.filter((r) => r.json !== r.db && r.zod !== r.db);
const agrees = measured.filter((r) => r.json === r.db).length;
// A run where the schema never refuses anything has compiled a pile of empty objects and would
// agree with nothing but a database that also accepts everything.
const refusals = measured.filter((r) => !r.json).length;

console.log(`    ${rows.length} JSON probes against a real Postgres (${cols.length} columns)`);
console.log(`    ${converted.none} probe(s) per column have no JSON form and were not asked (NaN, Infinity)`);
for (const c of unanswerable) {
  const asked = rows.filter((r) => r.col === c).length;
  const said = [...(refusalMessages[c] ?? [])];
  console.log(`    ${c} has no database verdict: Postgres accepted 0 of ${asked} JSON probes,`);
  for (const m of said) console.log(`      saying "${m}"`);
}
console.log(`    agree with the database: ${agrees} of ${measured.length}; ${shared.length} differ where zod differs too`);
console.log(`    the schema refused ${refusals} of ${measured.length} probes`);

if (refusals === 0) {
  console.error('\n    FAIL: the emitted schemas refused nothing at all, so they constrain nothing.');
  await db.close();
  process.exit(1);
}

if (findings.length) {
  console.error('\n    FAIL: the emitted JSON Schema disagrees with Postgres where the zod output agrees:');
  for (const r of findings.slice(0, 20)) {
    console.error(
      `      ${r.col} on ${r.label}: Postgres ${r.db ? 'accepts' : 'rejects'}, ` +
        `the schema ${r.json ? 'accepts' : 'rejects'}`
    );
  }
  console.error('\n    A contract that turns away what the database takes breaks working clients,');
  console.error('    and one that takes what the database refuses promises an endpoint that 500s.');
  await db.close();
  process.exit(1);
}

await db.close();
JSON_SCHEMA_TRUTH

echo "==> ground truth: the emitted JSON Schema against a real Postgres"
if ! npx tsx src/json-schema-truth.ts; then
  echo "FAIL: the emitted JSON Schema disagrees with Postgres itself." >&2
  exit 1
fi

cat > src/checks-truth.ts <<'CHECKS_TRUTH'
/**
 * CHECK constraints against Postgres itself.
 *
 * This is DRZL's main advantage over the first-party validators, and until now it was verified
 * only against its own emitted strings: unit tests asserted the schema said `.min(18)` and the
 * emitted module was executed to confirm it rejected 17. Neither asks whether `.min(18)` means
 * what `CHECK (k_min >= 18)` means. Postgres is the only thing that can answer that.
 *
 * The gate here runs the other way round from the matrix one, because the official validators
 * have no CHECK support at all and are therefore looser than the database on every one of these
 * columns by construction. So:
 *
 *   FAIL   DRZL rejects what Postgres accepts. Over-strict breaks working code, and there is no
 *          reading of a CHECK under which that is correct.
 *   REPORT DRZL accepts what Postgres rejects. Sometimes deliberate, since the parser refuses
 *          expressions it cannot read with certainty, so it is counted rather than gated.
 */
import { PGlite } from '@electric-sql/pglite';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { DDL } from './ddl';
import { CHECK_PROBES, ROW_PAIR_PROBES } from './probes';
// The *update* schema, whose fields are all optional, so a one-column probe is a valid input.
// The select schema is not usable here: a row-level check wraps the object in a ZodEffects, which
// has no `.partial()` and no `.shape`, so every probe threw and read as a rejection. That looked
// exactly like a catastrophic generator bug for one very confusing minute.
//
// It is also the right semantic. Inserting one column is a partial row, and that is what the
// database is being asked about.
import { UpdatecheckedSchema as drzlUpdate } from './gen/pg/zod/checked.zod';
import { UpdatecheckedSchema as vUpdate } from './gen/pg/valibot/checked.valibot';
import { UpdatecheckedSchema as aUpdate } from './gen/pg/arktype/checked.arktype';
import { UpdatecheckedSchema as tUpdate } from './gen/pg/typebox/checked.typebox';
// The fifth voice. It emits data rather than a validator, so it is read by ajv rather than called.
import { UpdatecheckedSchema as jUpdate } from './gen/pg/json-schema/checked.schema';
import * as v from 'valibot';
import { type } from 'arktype';
import { Value } from '@sinclair/typebox/value';
import { createUpdateSchema } from 'drizzle-orm/zod';
import { checked } from './schema';

const db = new PGlite();
await db.exec(DDL);

const official: any = createUpdateSchema(checked);
const drzl: any = drzlUpdate;

// Both sides of every bound, from the shared pool, so the JSON Schema stage asks the database
// exactly these questions rather than a copy of them that has drifted.
const PROBES = CHECK_PROBES;

async function dbAccepts(col: string, value: unknown): Promise<boolean> {
  try {
    await db.exec('BEGIN');
    await db.query(`INSERT INTO checked (${col}) VALUES ($1)`, [value as never]);
    await db.exec('ROLLBACK');
    return true;
  } catch {
    try {
      await db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    return false;
  }
}

const ok = (schema: any, v: unknown) => {
  try {
    return schema.safeParse(v).success;
  } catch {
    return false;
  }
};

// The whole object is parsed, not the field alone: a row-level check lives on the object, so a
// per-field parse could never see it. Every other key is left out, which is what the database
// does too when one column is inserted.
const parses = (schema: any, col: string, v: unknown) => {
  try {
    return schema.safeParse({ [col]: v }).success;
  } catch {
    return false;
  }
};

/**
 * The same probes through all four generators.
 *
 * A CHECK form is read once by the shared parser and then emitted four times, so a generator can
 * drop one without any test noticing: `length()` was applied by zod and valibot and emitted as
 * nothing at all by arktype and typebox, for as long as both have existed. The matrix table
 * already cross-checks the four, and it carries no CHECK constraints, so it could never see this.
 *
 * Whole-object parsing, because a row-level check lives on the object and a per-field comparison
 * cannot reach it.
 */
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv as never);
const jsonSchemaOk = ajv.compile(jUpdate as never) as unknown as (o: unknown) => boolean;

const RUNNERS: Record<string, (o: unknown) => boolean> = {
  zod: (o) => drzlUpdate.safeParse(o).success,
  valibot: (o) => v.safeParse(vUpdate as never, o).success,
  arktype: (o) => !((aUpdate as any)(o) instanceof type.errors),
  typebox: (o) => Value.Check(tUpdate as never, o),
  // The fifth: ajv reading the emitted JSON Schema in strict mode. The shared parser reads a CHECK
  // once and six generators render it, so this one dropping a form it understood would be invisible
  // to every test that only reads its own output, which is exactly how `length()` came to be
  // applied by two generators and emitted as nothing at all by two others.
  'json-schema': jsonSchemaOk,
};

const safely = (f: (o: unknown) => boolean, o: unknown) => {
  try {
    return f(o);
  } catch {
    return false;
  }
};

type Row = { col: string; value: unknown; db: boolean; drzl: boolean; off: boolean };
const rows: Row[] = [];
for (const [col, values] of Object.entries(PROBES)) {
  for (const value of values) {
    rows.push({
      col,
      value,
      db: await dbAccepts(col, value),
      drzl: parses(drzl, col, value),
      off: parses(official, col, value),
    });
  }
}

const strict = rows.filter((r) => r.db && !r.drzl);
const loose = rows.filter((r) => !r.db && r.drzl);
const offLoose = rows.filter((r) => !r.db && r.off);
const show = (v: unknown) => JSON.stringify(v);

console.log(`    ${rows.length} CHECK probes against a real Postgres (${Object.keys(PROBES).length} constrained columns)`);
console.log(`    rows Postgres rejects and the validator accepts: DRZL ${loose.length}, drizzle-orm ${offLoose.length}`);

if (strict.length) {
  console.error('\n    FAIL: DRZL rejects rows Postgres accepts:');
  for (const r of strict.slice(0, 20)) {
    console.error(`      ${r.col} = ${show(r.value)}`);
  }
  console.error('\n    A CHECK read more strictly than the database wrote it turns away valid rows.');
  await db.close();
  process.exit(1);
}

if (loose.length) {
  console.log('    accepted by DRZL but not by Postgres (parser declined to read the check):');
  for (const r of loose.slice(0, 10)) console.log(`      ${r.col} = ${show(r.value)}`);
}

const split: string[] = [];
for (const [col, values] of Object.entries(PROBES)) {
  for (const value of values) {
    const verdicts = Object.entries(RUNNERS).map(
      ([name, run]) => [name, safely(run, { [col]: value })] as const
    );
    const yes = verdicts.filter(([, r]) => r).map(([n]) => n);
    const no = verdicts.filter(([, r]) => !r).map(([n]) => n);
    if (yes.length && no.length) {
      split.push(`      ${col} = ${show(value)}: ${yes.join('/')} accept, ${no.join('/')} reject`);
    }
  }
}

if (split.length) {
  console.error(`\n    FAIL: the ${Object.keys(RUNNERS).length} generators disagree about a CHECK:`);
  for (const line of split.slice(0, 20)) console.error(line);
  console.error('\n    One of them is dropping a constraint the parser read.');
  await db.close();
  process.exit(1);
}
console.log(`    all ${Object.keys(RUNNERS).length} generators agree on every CHECK probe`);

/**
 * The one place the JSON Schema output is knowingly looser than the database, asserted rather than
 * waived.
 *
 * JSON Schema cannot compare one property against another. `if`/`then` and `dependentSchemas`
 * branch on a property's presence or on a fixed value, and neither of those is
 * `k_pair_a < k_pair_b`, so the generator carries the constraint as a `description` and does not
 * pretend to enforce it. That is documented in docs/generators/json-schema.md.
 *
 * A documented exemption is worth nothing unless something checks it is still the exemption it says
 * it is, so all three halves are asserted: Postgres rejects the disordered row, the four validator
 * generators reject it, and the JSON Schema accepts it *and* still says so in prose. If it ever
 * starts enforcing the comparison, or stops carrying the description, this fails and the
 * documentation moves with it.
 *
 * None of the probes above can reach this. Each sets one column, and the CHECK is satisfied
 * whenever either side is NULL, so a generator that had silently dropped the row check entirely
 * would have looked identical to one that enforces it.
 */
const ENFORCING = ['zod', 'valibot', 'arktype', 'typebox'];
const rowProblems: string[] = [];

const description = (jUpdate as { description?: string }).description;
if (!description || !description.includes('k_pair_a < k_pair_b')) {
  rowProblems.push(
    `the emitted schema no longer names the row constraint in its description (was ${JSON.stringify(description)}). ` +
      'Carrying it as prose is the whole of what the format allows, so losing it leaves the ' +
      'constraint stated nowhere at all.'
  );
}

async function pairAccepted(row: Record<string, unknown>): Promise<boolean> {
  const keys = Object.keys(row);
  const params = keys.map((_, i) => `$${i + 1}`).join(', ');
  try {
    await db.exec('BEGIN');
    await db.query(
      `INSERT INTO checked (${keys.join(', ')}) VALUES (${params})`,
      keys.map((k) => row[k]) as never
    );
    await db.exec('ROLLBACK');
    return true;
  } catch {
    try {
      await db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    return false;
  }
}

for (const { row, satisfied } of ROW_PAIR_PROBES) {
  const label = JSON.stringify(row);
  const inDb = await pairAccepted(row);
  if (inDb !== satisfied) {
    rowProblems.push(
      `Postgres ${inDb ? 'accepts' : 'rejects'} ${label}, which the fixture says it should not. ` +
        'The DDL and the probe disagree, so nothing below means anything.'
    );
    continue;
  }
  for (const name of ENFORCING) {
    const verdict = safely(RUNNERS[name], row);
    if (verdict !== satisfied) {
      rowProblems.push(
        `${name} ${verdict ? 'accepts' : 'rejects'} ${label} and Postgres ${satisfied ? 'accepts' : 'rejects'} it. ` +
          'A row-level CHECK is the one constraint these four can express and the JSON Schema ' +
          'cannot, so this one losing it makes the exemption meaningless.'
      );
    }
  }
  // The exemption itself. Accepting the satisfied row is agreement; accepting the violating one is
  // the documented gap, and it has to still be there or the documentation is now wrong.
  if (!safely(RUNNERS['json-schema'], row)) {
    rowProblems.push(
      `json-schema rejects ${label}. It has no way to compare two properties, so a rejection means ` +
        'the schema is refusing the row for some other reason entirely.'
    );
  }
}

if (rowProblems.length) {
  console.error('\n    FAIL: the row-level CHECK exemption is not what it is documented to be:');
  for (const p of rowProblems) console.error(`      ${p}`);
  await db.close();
  process.exit(1);
}
console.log(
  `    ${ROW_PAIR_PROBES.length} row-level probes: Postgres and the four validator generators ` +
    'agree, and the JSON Schema carries the constraint as prose it cannot enforce'
);

await db.close();
CHECKS_TRUTH

if ! npx tsx src/checks-truth.ts | tee -a "$WORK/printed.log"; then
  echo "FAIL: a generated CHECK disagrees with Postgres." >&2
  exit 1
fi



cat > src/defaults-truth.ts <<'DEFAULTS_TRUTH'
/**
 * `applyDefaults` against what the database actually writes.
 *
 * The option reproduces a column's literal default in the insert schema, so parsing a row that
 * omits the key fills it in. Until now it was covered only by unit tests asserting the emitted
 * source said `.default(42)`. Nothing asked whether 42 is what Postgres would have written, and
 * nothing here exercised the option at all: the fixture had no defaults in it.
 *
 * The falsy ones are the reason to bother. `0`, `false` and `''` are what a truthiness test drops,
 * and a dropped default is invisible: the key is simply absent, the insert succeeds, and the
 * database writes its own value. That is only a bug when the two disagree, which is exactly what
 * this compares.
 */
import { PGlite } from '@electric-sql/pglite';
import { DDL } from './ddl';
import { InsertdefaultedSchema } from './gen/pg-defaults/zod/defaulted.zod';

const db = new PGlite();
await db.exec(DDL);

// What the database writes when every column is omitted.
await db.query('INSERT INTO defaulted DEFAULT VALUES');
const stored: any = await db.query('SELECT * FROM defaulted');
const row = stored.rows[0];

// What the schema fills in for the same input.
const parsed = (InsertdefaultedSchema as any).safeParse({});
if (!parsed.success) {
  console.error('    FAIL: the insert schema rejects a row with every defaulted column omitted.');
  console.error(`      ${JSON.stringify(parsed.error.issues?.slice(0, 5))}`);
  await db.close();
  process.exit(1);
}

const cols = Object.keys(row);
const diffs: string[] = [];
let filled = 0;
for (const col of cols) {
  const db_ = row[col];
  const ours = parsed.data[col];
  if (ours === undefined) {
    diffs.push(`      ${col}: Postgres writes ${JSON.stringify(db_)}, the schema fills in nothing`);
    continue;
  }
  filled++;
  // Postgres hands back a real number for double precision and a boolean for boolean, so a
  // loose comparison would hide a string/number mix-up. Compared by value and by type.
  if (db_ !== ours || typeof db_ !== typeof ours) {
    diffs.push(
      `      ${col}: Postgres writes ${JSON.stringify(db_)} (${typeof db_}), ` +
        `the schema fills in ${JSON.stringify(ours)} (${typeof ours})`
    );
  }
}

console.log(`    ${cols.length} defaulted columns, ${filled} reproduced by applyDefaults`);

if (diffs.length) {
  console.error('\n    FAIL: applyDefaults disagrees with what the database writes:');
  console.error(diffs.join('\n'));
  console.error('\n    A default that differs writes a different row than omitting the key would.');
  await db.close();
  process.exit(1);
}

await db.close();
DEFAULTS_TRUTH

if ! npx tsx src/defaults-truth.ts | tee -a "$WORK/printed.log"; then
  echo "FAIL: applyDefaults does not reproduce the database's defaults." >&2
  exit 1
fi

# MySQL is the one dialect with no in-process engine, so this stage runs only where a server is
# reachable: CI provides one as a service container, and a local run without `MYSQL_URL` skips it
# and says so rather than silently covering less than the output claims.
if [ -n "${MYSQL_URL:-}" ]; then
npm install --no-audit --no-fund --loglevel=error mysql2 >/dev/null

cat > src/mysql-truth.ts <<'MYSQL_TRUTH'
/**
 * CHECK constraints and text limits against a real MySQL.
 *
 * MySQL is the only dialect with no in-process engine, so this is the one stage that needs a
 * server. It earns that by answering a question nothing else can: MySQL's text limits are
 * measured in **bytes**, not characters, and its `varchar(n)` is measured in characters, and no
 * amount of reading the manual settles which applies to a given column as reliably as inserting
 * into one.
 *
 * Measured here on utf8mb4, which is MySQL 8's default:
 *
 *   varchar(10)  accepts 10 emoji, rejects 11        -> characters
 *   tinytext     accepts 63 emoji (252 bytes)
 *                rejects 64 emoji (256 bytes)
 *                accepts 255 ascii, rejects 256      -> bytes
 */
import mysql from 'mysql2/promise';
import { UpdatecheckedSchema as drzlChecked } from './gen/mysql/zod/checked.zod';
import { UpdatelimitsSchema as drzlLimits } from './gen/mysql/zod/limits.zod';

const db = await mysql.createConnection(process.env.MYSQL_URL!);
await db.query('DROP TABLE IF EXISTS checked');
await db.query('DROP TABLE IF EXISTS limits');
await db.query(`
CREATE TABLE checked (
  k_min int CHECK (k_min >= 18),
  k_max int CHECK (k_max <= 100),
  k_lo int CHECK (k_lo > 0),
  k_between int CHECK (k_between BETWEEN 5 AND 15),
  k_eq int CHECK (k_eq = 7),
  k_in_s varchar(20) CHECK (k_in_s IN ('a', 'b', 'c')),
  k_in_n int CHECK (k_in_n IN (1, 2, 3)),
  k_len varchar(50) CHECK (char_length(k_len) >= 3),
  k_pair_a int,
  k_pair_b int,
  CONSTRAINT k_pair_c CHECK (k_pair_a < k_pair_b)
) CHARACTER SET utf8mb4`);
await db.query(`
CREATE TABLE limits (
  l_varchar varchar(10),
  l_tinytext tinytext,
  l_text text
) CHARACTER SET utf8mb4`);

const EMOJI = '\u{1F44D}';

const CHECK_PROBES: Record<string, unknown[]> = {
  k_min: [17, 18, 19],
  k_max: [99, 100, 101],
  k_lo: [0, 1],
  k_between: [4, 5, 15, 16],
  k_eq: [6, 7],
  k_in_s: ['a', 'c', 'd'],
  k_in_n: [1, 3, 4],
  k_len: ['ab', 'abc', EMOJI.repeat(3)],
  k_pair_a: [1, 100],
  k_pair_b: [1, 100],
};

const LIMIT_PROBES: Record<string, unknown[]> = {
  l_varchar: ['a'.repeat(10), 'a'.repeat(11), EMOJI.repeat(10), EMOJI.repeat(11)],
  l_tinytext: ['a'.repeat(255), 'a'.repeat(256), EMOJI.repeat(63), EMOJI.repeat(64)],
  l_text: ['a'.repeat(65535), 'a'.repeat(65536)],
};

async function accepts(table: string, col: string, value: unknown): Promise<boolean> {
  try {
    await db.beginTransaction();
    await db.query(`INSERT INTO \`${table}\` (\`${col}\`) VALUES (?)`, [value]);
    await db.rollback();
    return true;
  } catch {
    try {
      await db.rollback();
    } catch {
      /* already rolled back */
    }
    return false;
  }
}

// The update schemas, whose fields are all optional, so a one-column probe is a valid input and
// nothing needs unwrapping. Calling `.partial()` here instead made every probe read as a
// rejection, which looked exactly like a catastrophic generator bug. Same trap as the Postgres
// harness, and the same fix.
const parses = (schema: any, col: string, v: unknown) => {
  try {
    return schema.safeParse({ [col]: v }).success;
  } catch {
    return false;
  }
};

type Row = { table: string; col: string; value: unknown; db: boolean; drzl: boolean };
const rows: Row[] = [];
for (const [col, values] of Object.entries(CHECK_PROBES)) {
  for (const value of values) {
    rows.push({
      table: 'checked',
      col,
      value,
      db: await accepts('checked', col, value),
      drzl: parses(drzlChecked, col, value),
    });
  }
}
for (const [col, values] of Object.entries(LIMIT_PROBES)) {
  for (const value of values) {
    rows.push({
      table: 'limits',
      col,
      value,
      db: await accepts('limits', col, value),
      drzl: parses(drzlLimits, col, value),
    });
  }
}

const strict = rows.filter((r) => r.db && !r.drzl);
const loose = rows.filter((r) => !r.db && r.drzl);
const show = (v: unknown) => (typeof v === 'string' ? `${v.length} units` : JSON.stringify(v));

console.log(`    ${rows.length} probes against a real MySQL`);
console.log(`    rows MySQL rejects and DRZL accepts: ${loose.length}`);

if (strict.length) {
  console.error('\n    FAIL: DRZL rejects rows MySQL accepts:');
  for (const r of strict.slice(0, 20)) console.error(`      ${r.table}.${r.col} = ${show(r.value)}`);
  await db.end();
  process.exit(1);
}
if (loose.length) {
  console.log('    accepted by DRZL but not by MySQL:');
  for (const r of loose.slice(0, 10)) console.log(`      ${r.table}.${r.col} = ${show(r.value)}`);
}

await db.end();
MYSQL_TRUTH

if ! npx tsx src/mysql-truth.ts | tee -a "$WORK/printed.log"; then
  echo "FAIL: a generated schema disagrees with MySQL." >&2
  exit 1
fi
else
  echo "==> MySQL ground truth skipped: no MYSQL_URL"
fi

cat > src/sqlite-truth.ts <<'SQLITE_TRUTH'
/**
 * CHECK constraints against SQLite itself, as a second database authority.
 *
 * SQLite's *type* checking is famously weak, which is why there is no type ground-truth stage for
 * it: a non-STRICT column takes almost anything and measuring against it would say nothing. Its
 * *CHECK* enforcement is not weak at all. It is exactly as strict as Postgres's, and `length()`
 * counts characters there too, so three thumbs-up characters are three.
 *
 * `node:sqlite` is built into Node 22, so this costs no dependency and no install.
 *
 * The value is dialect coverage. The same parser reads a check expression rendered by a different
 * dialect's SQL builder, and the emitted schema has to still mean what the database means.
 */
import { DatabaseSync } from 'node:sqlite';
import { UpdatecheckedSchema as drzlUpdate } from './gen/sqlite/zod/checked.zod';

const db = new DatabaseSync(':memory:');
db.exec(`
CREATE TABLE checked (
  k_min integer CHECK (k_min >= 18),
  k_max integer CHECK (k_max <= 100),
  k_lo integer CHECK (k_lo > 0),
  k_between integer CHECK (k_between BETWEEN 5 AND 15),
  k_eq integer CHECK (k_eq = 7),
  k_in_s text CHECK (k_in_s IN ('a', 'b', 'c')),
  k_in_n integer CHECK (k_in_n IN (1, 2, 3)),
  k_len text CHECK (length(k_len) >= 3),
  k_pair_a integer,
  k_pair_b integer,
  CONSTRAINT k_pair_c CHECK (k_pair_a < k_pair_b)
);
`);

const PROBES: Record<string, unknown[]> = {
  k_min: [17, 18, 19, 0],
  k_max: [99, 100, 101],
  k_lo: [0, 1, 2],
  k_between: [4, 5, 15, 16],
  k_eq: [6, 7, 8],
  k_in_s: ['a', 'c', 'd', ''],
  k_in_n: [1, 3, 4],
  k_len: ['ab', 'abc', '', '\u{1F44D}\u{1F44D}\u{1F44D}'],
  k_pair_a: [1, 100],
  k_pair_b: [1, 100],
};

function dbAccepts(col: string, value: unknown): boolean {
  try {
    db.exec('BEGIN');
    db.prepare(`INSERT INTO checked (${col}) VALUES (?)`).run(value as never);
    db.exec('ROLLBACK');
    return true;
  } catch {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    return false;
  }
}

const parses = (col: string, v: unknown) => {
  try {
    return (drzlUpdate as any).safeParse({ [col]: v }).success;
  } catch {
    return false;
  }
};

type Row = { col: string; value: unknown; db: boolean; drzl: boolean };
const rows: Row[] = [];
for (const [col, values] of Object.entries(PROBES)) {
  for (const value of values) {
    rows.push({ col, value, db: dbAccepts(col, value), drzl: parses(col, value) });
  }
}

const strict = rows.filter((r) => r.db && !r.drzl);
const loose = rows.filter((r) => !r.db && r.drzl);
const show = (v: unknown) => JSON.stringify(v);

console.log(`    ${rows.length} CHECK probes against a real SQLite (${Object.keys(PROBES).length} constrained columns)`);
console.log(`    rows SQLite rejects and DRZL accepts: ${loose.length}`);

if (strict.length) {
  console.error('\n    FAIL: DRZL rejects rows SQLite accepts:');
  for (const r of strict.slice(0, 20)) console.error(`      ${r.col} = ${show(r.value)}`);
  db.close();
  process.exit(1);
}
if (loose.length) {
  console.log('    accepted by DRZL but not by SQLite:');
  for (const r of loose.slice(0, 10)) console.log(`      ${r.col} = ${show(r.value)}`);
}
db.close();
SQLITE_TRUTH

# `node:sqlite` is still flagged experimental, and its warning is not news here.
if ! npx tsx --disable-warning=ExperimentalWarning src/sqlite-truth.ts | tee -a "$WORK/printed.log"; then
  echo "FAIL: a generated CHECK disagrees with SQLite." >&2
  exit 1
fi

# ---------------------------------------------------------------------------------------------
# The numbers the published documentation quotes, against the run that produced them.
#
# Until this existed nothing in the project checked a number in the documentation. Measured rather
# than assumed: `9.9999999999999999e42` substituted for the float4 bound in the shipped TypeBox
# page left `pnpm lint`, `pnpm typecheck`, every package test, `pnpm -C docs build` and
# `scripts/extract-doc-configs.mjs` all at exit 0, and that last one is the only docs-aware stage
# in the whole gate: it reads runnable config blocks and cannot see a table or a paragraph.
#
# It is not a documentation test framework, and it does not try to be. It covers exactly one
# thing, the block in benchmarks.md that quotes this script's own output, which is the only prose
# in the docs whose numbers this run also computes. That block was stale when this check was
# written: it claimed `DRZL 1007, drizzle-orm 979` and `closer on 28` for a run that had been
# printing 1012 and 33 since the commit that changed the float bounds, and five rounds of review
# had read the same branch without noticing. Every other number in the docs is still unchecked and
# still has nothing behind it.
#
# The comparison is line by line and literal, so a fabricated digit fails rather than a fabricated
# sentence. Lines about MySQL are skipped, by name and out loud, when no MYSQL_URL is set: that
# stage did not run, so this run has nothing to compare them with.
#
# Both controls were run against a captured run log before this shipped. `DRZL 1048` changed to
# `DRZL 9999` in the page exits 1 naming that line. The vacuity control matters more, because this
# check finds its block by a phrase in the prose above it: editing "three real databases" to
# "three actual databases" makes the extraction return nothing, and the count guard below exits 1
# rather than reporting that everything matched.
echo "==> the numbers the documentation quotes, against this run"
DOC_BENCH="$ROOT/docs/guide/benchmarks.md"
doc_missing=0
doc_checked=0
doc_skipped=0
while IFS= read -r doc_line; do
  doc_trim="$(printf '%s' "$doc_line" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  [ -z "$doc_trim" ] && continue
  if [ -z "${MYSQL_URL:-}" ] && printf '%s' "$doc_trim" | grep -q 'MySQL'; then
    doc_skipped=$((doc_skipped + 1))
    echo "    not compared, that stage did not run without MYSQL_URL: $doc_trim"
    continue
  fi
  doc_checked=$((doc_checked + 1))
  if ! grep -Fq -- "$doc_trim" "$WORK/printed.log"; then
    if [ "$doc_missing" -eq 0 ]; then
      echo "    FAIL: docs/guide/benchmarks.md quotes this script's output, and this run did not"
      echo "          print these lines. Paste what the run printed, or say what changed:"
    fi
    echo "      $doc_trim"
    doc_missing=$((doc_missing + 1))
  fi
done < <(awk '/three real databases/{found=1} found && /^```$/{n++; next} found && n==1' "$DOC_BENCH")
if [ "$doc_checked" -eq 0 ]; then
  echo "    FAIL: found no quoted lines to compare, so this check measured nothing." >&2
  exit 1
fi
if [ "$doc_missing" -gt 0 ]; then
  echo "FAIL: the documentation quotes numbers this run did not produce." >&2
  exit 1
fi
echo "    $doc_checked line(s) of docs/guide/benchmarks.md matched this run's output, $doc_skipped not compared"

cd "$APP"

# ---------------------------------------------------------------------------------------------
# Both drizzle majors, against each other.
#
# Every generator's own tests build fake column objects, the parity tree pins v1 and the consumer
# tree takes whatever npm's `latest` tag serves. Between them, nothing here ever described one
# schema under both majors and compared the two descriptions.
#
# What that hid: 0.4x models `.array()` by wrapping the column in a `PgArray` whose `baseColumn`
# is the element, while v1 leaves the class alone and raises `dimensions`. The analyzer read only
# the v1 signal, so on 0.4x every array column came back `unknown` in all five generators. The
# fixture below contains four array columns and the gate was green the whole time.
#
# Two trees, each pinning its own major, because the version has to be a decision rather than
# whatever a tag points at today. The v1 side used to be the consumer tree, whose `drizzle-orm`
# is deliberately unpinned, and `latest` is 0.45.2: this stage compared 0.45.2 with 0.45.2 from
# the day it was added until 2026-08-03 and passed for the same reason a diff of a file against
# itself passes. Each side now records the version it ran under, and the two are compared before
# any field is.
# ---------------------------------------------------------------------------------------------
echo "==> installing both drizzle-orm majors"
OLD="$WORK/old-major"
NEW="$WORK/new-major"
rm -rf "$OLD" "$NEW"; mkdir -p "$OLD/src" "$NEW/src"
cd "$OLD"
npm init -y >/dev/null 2>&1
npm install --no-audit --no-fund --loglevel=error \
  "$TARS"/*.tgz drizzle-orm@0.45.2 zod tsx >/dev/null

# The same tarballs and the other major. `zod` because the generate step below runs in the 0.4x
# tree; this one only analyzes, and installing the same set keeps the two trees differing in
# exactly one thing.
( cd "$NEW" && npm init -y >/dev/null 2>&1 && npm install --no-audit --no-fund --loglevel=error \
  "$TARS"/*.tgz drizzle-orm@1.0.0-rc.4 zod tsx >/dev/null )

# Written once and analyzed under both majors, so the comparison below is about the analyzer
# rather than about two schemas that happen to differ. Every type here exists in both.
cat > src/schema.ts <<'OLD_SCHEMA'
import {
  pgTable, pgSchema, pgEnum, text, integer, smallint, bigint, varchar, char, timestamp, date,
  boolean, numeric, doublePrecision, uuid, json, jsonb, index, unique, foreignKey, primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const mood = pgEnum('mood', ['sad', 'ok', 'happy']);

export const rows = pgTable('rows', {
  id: integer('id').primaryKey(),
  small: smallint('small').notNull(),
  big53: bigint('big53', { mode: 'number' }).notNull(),
  big64: bigint('big64', { mode: 'bigint' }).notNull(),
  name: varchar('name', { length: 40 }).notNull(),
  code: char('code', { length: 3 }).notNull(),
  bio: text('bio'),
  at: timestamp('at').notNull(),
  day: date('day').notNull(),
  live: boolean('live').notNull(),
  amount: numeric('amount').notNull(),
  ratio: doublePrecision('ratio').notNull(),
  ref: uuid('ref').notNull(),
  blob: json('blob').notNull(),
  blob2: jsonb('blob2').notNull(),
  feeling: mood('feeling').notNull(),
  tags: text('tags').array().notNull(),
  scores: integer('scores').array().notNull(),
  moods: mood('moods').array().notNull(),
  grid: text('grid').array().array().notNull(),
});

/**
 * Everything the analyzer says about a table rather than about a column, so that comparing those
 * facts is a comparison rather than an agreement between empty arrays.
 *
 * Before these three tables the fixture carried no unique constraint, no foreign key, no
 * generated column and no `references`, and the stage compared `[]` with `[]` for each of them
 * while reporting that they agreed. The guard further down now refuses any field it only ever
 * saw empty, so the next one added here cannot repeat it.
 *
 * `alt_ref` is renamed on purpose: Drizzle reports index, unique and foreign key members by
 * database column name, and the analyzer translates those back to the TypeScript names the rest
 * of its output uses. A fixture whose two names are identical cannot tell the two apart.
 */
export const parents = pgTable('parents', {
  id: integer('id').primaryKey(),
  label: text('label').notNull(),
});

export const children = pgTable(
  'children',
  {
    id: integer('id').primaryKey(),
    parentId: integer('parent_id')
      .references(() => parents.id)
      .notNull(),
    altRef: integer('alt_ref').notNull(),
    b: integer('b').notNull(),
    span: integer('span').generatedAlwaysAs(sql`alt_ref + b`),
    seenAt: timestamp('seen_at').notNull().default(sql`now()`),
  },
  (t) => [
    unique('children_alt_b_uq').on(t.altRef, t.b),
    index('children_b_idx').on(t.b),
    foreignKey({ columns: [t.altRef], foreignColumns: [parents.id], name: 'children_alt_fk' }),
  ]
);

export const pairs = pgTable(
  'pairs',
  {
    left: integer('left').notNull(),
    right: integer('right').notNull(),
  },
  (t) => [primaryKey({ columns: [t.left, t.right] })]
);

// A table outside the public schema, which is the only way `schema` is anything but undefined.
// The analyzer reads it off `drizzle:Schema`, and both majors still put it there.
export const app = pgSchema('app');

export const notes = app.table('notes', {
  id: integer('id').primaryKey(),
  body: text('body').notNull(),
});
OLD_SCHEMA

# The one thing a Postgres fixture cannot describe: MySQL's text family, whose cap is a property
# of the type rather than a declared length.
#
# It is one of two sources of `maxBytes`, not the only one, which is what this sentence said
# before. MYSQL_TEXT_CAPS (packages/analyzer/src/index.ts:242) is eight entries, four text and
# four blob. Measured on 1.0.0-rc.4: a `blob` column comes back with maxBytes 65535 and a
# `tinyblob` with 255.
#
# The text half is the half a shared fixture can carry. Measured on 0.45.2: text, tinytext,
# mediumtext and longtext are functions on its mysql-core, and blob, tinyblob, mediumblob and
# longblob are all undefined, which is also why the parity MySQL fixture cannot be imported
# under that major at all. That last fact was briefly used here to claim no fixture could cover
# `maxBytes`, which was false, and this file is what refutes it. Four columns and a varchar key,
# all of which import on both majors.
cat > src/mysql-text.ts <<'MYSQL_TEXT'
import { mysqlTable, varchar, text, tinytext, mediumtext, longtext } from 'drizzle-orm/mysql-core';

export const mtext = mysqlTable('mtext', {
  id: varchar('id', { length: 20 }).primaryKey(),
  t_text: text('t_text').notNull(),
  t_tiny: tinytext('t_tiny').notNull(),
  t_medium: mediumtext('t_medium').notNull(),
  t_long: longtext('t_long').notNull(),
});
MYSQL_TEXT

# The Postgres fixture the parity stage measures against the first-party validators: the
# 40-column matrix, the defaults table, the nullable arrays and the twelve CHECK expressions.
# Read out of the parity tree rather than re-typed, so widening that fixture widens this
# comparison instead of leaving a copy of it behind to drift.
#
# Two columns come out: 0.4x's pg-core has no `bytea` export at all, so a fixture carrying one
# cannot even be imported there. That is asserted in check-old.ts rather than trusted, and the
# edit below is checked for having changed something, since a `sed` that matches nothing is the
# quiet way to end up analyzing the wrong file.
#
# The second is `c_bytea_null`, on the `nullable` table, and it is named for the first so that the
# same line-delete takes it. The check that no line mentioning the type survives is what holds
# that, which is also why no comment in the fixture may mention the type without the `c_` prefix:
# such a line survives the delete and fails the check.
[ -f "$PARITY/src/schema.ts" ] || {
  echo "FAIL: the parity fixture is not where this stage expects it, so there is nothing to" >&2
  echo "      analyze under both majors." >&2
  exit 1
}
sed -e 's/ bytea,//' -e '/c_bytea/d' "$PARITY/src/schema.ts" > src/matrix.ts
if cmp -s "$PARITY/src/schema.ts" src/matrix.ts; then
  echo "FAIL: nothing was removed from the parity fixture, so either bytea is gone from it (in" >&2
  echo "      which case delete the edit above and analyze the file as it is) or the edit no" >&2
  echo "      longer matches what it is meant to remove." >&2
  exit 1
fi
if grep -q 'bytea' src/matrix.ts; then
  echo "FAIL: bytea survived the edit above, so this fixture cannot be imported under 0.4x." >&2
  exit 1
fi

cat > drzl.config.ts <<'OLD_CONFIG'
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: 'src/schema.ts',
  outDir: 'src/gen',
  generators: [{ kind: 'zod', path: 'src/gen/zod' }],
});
OLD_CONFIG

echo "==> generating against drizzle-orm 0.4x"
npx drzl generate --config drzl.config.ts >/dev/null

cat > describe-columns.ts <<'DESCRIBE'
import { readFileSync } from 'node:fs';
import { SchemaAnalyzer } from '@drzl/analyzer';

// Everything the analyzer says about these schema files, and the drizzle-orm that produced it.
//
// The whole column object rather than a chosen list of fields. A list is a decision, taken in
// advance, about which facts are allowed to differ, and it is silently wrong the moment the
// analyzer learns a new one: `integer`, `maxBytes`, `defaultValue`, `hasDefault`, `isGenerated`
// and `references` are all fields the list this replaced did not have, and it flattened `shape`
// to its `kind`, which drops a tuple's length and a bit string's exactness. `integer` alone
// carries five of the differences reported below.
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

async function main() {
  // Off disk rather than through `require.resolve`: drizzle-orm's `exports` map has no
  // `./package.json` entry, so resolving it throws ERR_PACKAGE_PATH_NOT_EXPORTED. Reading it is
  // also the point of this line, which is to report the version of the tree this ran in rather
  // than the version somebody believes it installed.
  const pkg = JSON.parse(readFileSync('node_modules/drizzle-orm/package.json', 'utf8'));
  const out: {
    drizzle: string;
    tables: Record<string, unknown>;
    columns: Record<string, unknown>;
    fields: { table: string[]; column: string[] };
  } = { drizzle: pkg.version, tables: {}, columns: {}, fields: { table: [], column: [] } };
  // The field names the analyzer produced, collected before this is serialised. A field it sets
  // to `undefined` on every column, as it does with `references` until something references
  // something, is gone by the time the JSON is read, and a comparison cannot notice a field it
  // cannot see. This is what lets the guard downstream tell "always empty" from "not a field".
  const table = new Set<string>();
  const column = new Set<string>();
  for (const file of process.argv.slice(2)) {
    const a = await new SchemaAnalyzer(file).analyze({});
    // A fixture this drizzle cannot import analyzes to zero tables and one issue, and would
    // otherwise leave nothing behind but a smaller number in the count. Not hypothetical: the
    // MySQL parity fixture cannot be imported under 0.45.2 at all, because 0.4x's mysql-core
    // has no `blob` export.
    const failed = a.issues.filter((i) => i.code === 'DRZL_ANL_IMPORT');
    if (failed.length) {
      console.error(`FAIL: ${file} could not be imported under drizzle-orm ${pkg.version}:`);
      for (const i of failed) console.error(`      ${i.message}`);
      process.exit(1);
    }
    for (const t of a.tables) {
      // Two fixture files exporting a table of the same name would silently keep one table's
      // facts and both tables' columns under the same prefix, comparing a mixture of the two.
      if (out.tables[t.name]) {
        console.error(`FAIL: two schema files both export a table called ${t.name}, so this`);
        console.error('      description would mix them. Rename one.');
        process.exit(1);
      }
      const { columns, ...rest } = t;
      out.tables[t.name] = rest;
      for (const k of Object.keys(rest)) table.add(k);
      for (const c of columns) {
        out.columns[`${t.name}.${c.name}`] = c;
        for (const k of Object.keys(c)) column.add(k);
      }
    }
  }
  out.fields = { table: [...table].sort(), column: [...column].sort() };
  console.log(JSON.stringify(out, null, 1));
}
DESCRIBE

echo "==> describing the same three schema files under both drizzle-orm majors"
cp src/schema.ts src/matrix.ts src/mysql-text.ts "$NEW/src/"
cp describe-columns.ts "$NEW/describe-columns.ts"
npx tsx describe-columns.ts src/schema.ts src/matrix.ts src/mysql-text.ts > "$WORK/cols-0.4x.json"
( cd "$NEW" && npx tsx describe-columns.ts src/schema.ts src/matrix.ts src/mysql-text.ts ) > "$WORK/cols-v1.json"

cat > cross-major.ts <<'CROSS'
import { readFileSync } from 'node:fs';

/**
 * The same three schema files, analyzed under both drizzle majors, have to describe the same
 * columns.
 *
 * This is the systematic form of the bug that prompted the stage: the analyzer read v1's array
 * signal and not 0.4x's, so `.array()` columns were `unknown` on the version most people have.
 * A per-field diff catches every instance of that shape at once, including the ones nobody has
 * thought to write a test for.
 *
 * Two maps, because two different things are being said about a difference:
 *
 *   ALLOWED  the majors really do differ here, and DRZL reflects each one correctly.
 *   DEFECTS  the analyzer reads one major and not the other. Filed rather than fixed, and
 *            reported on every run.
 *
 * An entry in either that suppresses nothing fails this stage, so fixing a defect forces its
 * entry out instead of leaving a sentence behind that describes something nobody can observe.
 *
 * What it cannot catch is both majors being wrong the same way, which is why the unnamed-column
 * check below is separate rather than folded in. Measured, in both directions, because the
 * sentence that used to stand here was false: deleting the analyzer's `PgEnumColumn` arm does
 * *not* go unnoticed here, since v1 reads its enums through `describeV1Column` and keeps saying
 * `string` while 0.4x starts saying `unknown`, which is ten differences on this fixture.
 *
 * The state where it does go quiet takes deleting the v1 path as well. With `describeV1Column`
 * returning null on top of that deletion, five enum columns read `unknown` on both sides and
 * this comparison says nothing about any of them; that mutation is not silent overall, since
 * dropping the v1 path also drops v1's `arrayDimensions` and leaves two differences on the two
 * enum *array* columns, but the enum defect itself is invisible here and the check below names
 * all five. The old sentence read as measured because it was: against a run comparing 0.45.2
 * with itself, where every mutation stays silent.
 */
const ALLOWED: Record<string, string> = {
  // `.array().array()` is two dimensions in 0.4x and one in v1, and DRZL repeats each major
  // faithfully rather than choosing. v1's `array()` takes the depth as a string, so
  // `.array('[][]')` is the 2D spelling and a chained `.array()` sets `'[]'.length / 2 = 1`
  // however often it is repeated. Confirmed against the first-party validator of each major on
  // this exact column: drizzle-zod 0.8.3 on 0.45.2 accepts [['a']] and rejects ['a'], and
  // drizzle-orm/zod on 1.0.0-rc.4 does the opposite. v1 also infers `string[]`, not `string[][]`.
  'rows.grid.arrayDimensions': "v1 spells 2D `.array('[][]')`; chaining `.array()` stays at 1",
};

/**
 * Differences that are DRZL defects rather than differences between the majors.
 *
 * Every one of these is the analyzer describing a column correctly under one major and not the
 * other, so they are exactly what this stage was built to surface. They are named rather than
 * fixed here because this stage is a diff, and a diff cannot say which side is right.
 *
 * The gate that can is the 0.4x parity stage further down, which measures DRZL's emitted
 * validators against the first-party modules for 0.45.2 the way the stage near the top of this
 * file does for v1. It carries three of these columns in its own DEFECTS map, so a fix has to
 * clear an entry there as well as here. That gate is what made the first fixes possible: the
 * float bounds and the point and line tuples were filed here for a round because nothing could
 * show that changing the 0.4x path was right, and both left this map through it.
 */
const DEFECTS: Record<string, string> = {
  // ---- 0.4x names the SQL type coarsely, and once v1 does ------------------------------------
  // 0.4x carries no `codec`, so the analyzer maps these off the class name, and that table folds
  // PgVarchar, PgChar and PgSmallInt into TEXT and INTEGER, PgDate into TIMESTAMP, and
  // PgInet/PgCidr/PgMacaddr into TEXT. `c_serial` runs the other way: 0.4x says SERIAL and v1
  // says INTEGER.
  //
  // A label, and nothing more, on this fixture. `dbType` is read in exactly one place outside the
  // analyzer, `isIntegerColumn`, which prefers the `integer` flag and only falls back to
  // `dbType === 'INTEGER'`. Measured by changing it rather than by reading the output: setting all
  // seventeen of the labels this group then held to the value v1 reports, in the analysis of the
  // 0.4x tree, and regenerating all three fixtures with the zod and JSON Schema generators
  // produces 29 byte-identical files. Reading the diff of the two majors' output instead would
  // have been wrong, and `matrix.c_real.dbType` is why: it sat in this group and in the float
  // group, so its output did change, for the float bounds rather than for the label. It is gone
  // from both now, because `PgReal` reaches an arm of its own and is named REAL on 0.4x too.
  'rows.small.dbType': 'label only: PgSmallInt is named INTEGER on 0.4x',
  'rows.name.dbType': 'as rows.small.dbType, PgVarchar as TEXT',
  'rows.code.dbType': 'as rows.small.dbType, PgChar as TEXT',
  'rows.day.dbType': 'as rows.small.dbType, PgDate as TIMESTAMP',
  'arrays.a_varchar_arr_null.dbType': 'as rows.name.dbType',
  'matrix.c_varchar.dbType': 'as rows.name.dbType',
  'matrix.c_char.dbType': 'as rows.code.dbType',
  'matrix.c_smallint.dbType': 'as rows.small.dbType',
  'matrix.c_serial.dbType': 'label only, the other way: 0.4x says SERIAL and v1 says INTEGER',
  'matrix.c_date_d.dbType': 'as rows.day.dbType',
  'matrix.c_date_s.dbType': 'as rows.day.dbType',
  'matrix.c_varchar_arr.dbType': 'as rows.name.dbType',
  'nullable.n_varchar.dbType': 'as rows.name.dbType',
  'matrix.c_inet.dbType': 'label only: PgInet is named TEXT on 0.4x',
  'matrix.c_cidr.dbType': 'as matrix.c_inet.dbType',
  'matrix.c_macaddr.dbType': 'as matrix.c_inet.dbType',
  'mtext.id.dbType': 'as rows.name.dbType, on MySQL: MySqlVarChar is named TEXT on 0.4x',

  // ---- a numeric column is unchecked on 0.4x -------------------------------------------------
  // The numeric pattern is DRZL's own, kept because a bare string accepts 'hello' for a column
  // Postgres refuses it in, which the ALLOWED entry in the parity harness records as verified
  // through PGlite. It is attached in the v1 arm only, so on 0.4x these three columns emit a bare
  // string and take 'hello' back.
  'rows.amount.format': 'the numeric pattern is attached on v1 only',
  'matrix.c_numeric.format': 'as rows.amount.format',
  'matrix.c_decimal.format': 'as rows.amount.format',

  // ---- geometry, bit and vector are unnamed on 0.4x ------------------------------------------
  // `c_geometry`, `c_bit`, `c_vector` and their nullable twins used to sit here, eighteen entries,
  // all of them the class-name path having no arm for the column. Every one is named now, the two
  // majors agree, and this stage retired them by name three columns at a time as the arms landed.
  //
  // The bit half is worth remembering rather than only recording: the first version of that arm
  // returned `dbType: 'TEXT'` where v1's codec says `BIT`, and this check left exactly
  // `c_bit.dbType` and `nullable.n_bit.dbType` standing while the other ten went stale. A ledger
  // asserted in both directions tells a fix from a half fix without anybody looking for the
  // difference.

  // ---- MySQL's text family carries no character cap on 0.4x ----------------------------------
  // v1's `MySqlText` states `length` equal to the type's cap, 255 for `tinytext` and 65535 for
  // `text`; 0.4x's leaves it undefined. The analyzer reads the declared length the same way on
  // both, at packages/analyzer/src/index.ts:907, with no dialect gate and no cap table, so the
  // difference is in the column object rather than in the reading of it.
  //
  // That is why this sat in ALLOWED for a round, and it is the wrong home, because the majors'
  // own validators do not differ here. drizzle-zod 0.8.3 on drizzle-orm 0.45.2 emits `max_length`
  // 255 / 65535 / 16777215 / 4294967295 on all four, off the text subtype (`column.textType`)
  // rather than off `length`, which is the same place DRZL's own 0.4x path gets `maxBytes` from.
  // So DRZL on 0.4x is looser than official on 0.4x here, and that is worth recording because the
  // column has a cap and DRZL's 0.4x answer claims it does not, not because looser is a direction
  // this map forbids: the parity passes count their looser entries and most run that way.
  //
  // Measured on the emitted files, since ALLOWED also claimed nothing was accepted on one side
  // and refused on the other. All five generators emit different source, and one differs in
  // verdict:
  //
  //   zod, valibot, arktype, typebox   v1 gains a code-point check of the same number as the
  //                                    byte check both majors emit, and it can never be the
  //                                    deciding one. UTF-8 spends at least one byte per code
  //                                    point, so bytes(v) >= codePoints(v) for every string, and
  //                                    a lone surrogate encodes as U+FFFD, three bytes for one
  //                                    code point, which leans the same way. The two caps are the
  //                                    same number on all four columns. So anything inside the
  //                                    byte cap is inside the character cap, and the check v1
  //                                    adds refuses nothing the check both majors emit accepts.
  //                                    That argument needs `maxBytes <= maxLength`, which is a
  //                                    property of the column rather than of the encoding, and
  //                                    the stage below asserts it instead of leaving it to luck.
  //
  //                                    Same verdicts, not the same behaviour. The two majors
  //                                    describe a rejection differently, so this is invisible
  //                                    only to a caller that reads the boolean. On 256 ascii into
  //                                    `t_tiny`: zod and valibot report one issue on 0.4x ("at
  //                                    most 255 bytes") and two on v1 (the character one first,
  //                                    then the byte one), arktype reports one on each and names
  //                                    the character cap on v1 where 0.4x names the byte cap, and
  //                                    typebox reports two against three under `Value.Errors`.
  //                                    Anything rendering validation errors sees a difference.
  //   json-schema                      no byte check to fall back on. v1 carries `maxLength` and
  //                                    0.4x carries no cap of any kind, so a 256 character
  //                                    `t_tiny` is accepted by the 0.4x document and refused by
  //                                    the v1 one. Official drizzle-zod refuses it on 0.4x too.
  //
  // Two defects meet in that last line. `maxBytes` is right on both majors; the JSON Schema
  // generator ignores it entirely, which is what leaves the 0.4x document with no cap at all,
  // and that gap is filed already from the round that measured it. The number 0.4x's `maxBytes`
  // carries is the number v1's `maxLength` carries on all four columns, so closing it would put
  // the same cap on both sides; the description would still differ and these four entries stay.
  //
  // Recorded alongside, since it means the v1 side is not the obviously correct one either:
  // v1's `length` on a MySqlText is a byte budget worn as a character length, which is what
  // packages/analyzer/src/index.ts:95 says `maxLength` cannot express. On v1's JSON Schema it is
  // the only cap and it is counted in characters, so a 64 emoji `t_tiny` is 256 bytes, over the
  // type's budget, and that document accepts it. Measured under ajv.
  'mtext.t_text.maxLength': 'no character cap on 0.4x, which official drizzle-zod does emit there',
  'mtext.t_tiny.maxLength': 'as mtext.t_text.maxLength',
  'mtext.t_medium.maxLength': 'as mtext.t_text.maxLength',
  'mtext.t_long.maxLength': 'as mtext.t_text.maxLength',
};

const a = JSON.parse(readFileSync(process.env.OLD_JSON!, 'utf8'));
const b = JSON.parse(readFileSync(process.env.NEW_JSON!, 'utf8'));

// Nothing is compared until the two sides prove they came from different majors. Each file
// carries the version read out of the tree that produced it, so this cannot be satisfied by
// believing an install line: it is the only reason the stage below is a comparison at all.
const major = (v: unknown) => (typeof v === 'string' && v ? v.split('.')[0] : '');
if (!major(a.drizzle) || !major(b.drizzle) || major(a.drizzle) === major(b.drizzle)) {
  console.error('    FAIL: this stage compares two drizzle-orm majors, and the two sides report');
  console.error(`          ${JSON.stringify(a.drizzle)} and ${JSON.stringify(b.drizzle)}.`);
  console.error('          A diff of one version against itself is green for the same reason a');
  console.error('          diff of a file against itself is.');
  process.exit(1);
}

const used = new Set<string>();
const diffs: string[] = [];
const suppressed: Array<{ key: string; defect: boolean }> = [];

/**
 * Fields this fixture can never fill in, so the guard below would name them every run.
 *
 * Each is a promise that nothing can populate the field, not that nobody has bothered, and it
 * dies the moment something does.
 */
const EMPTY_OK: Record<string, string> = {
  'table:meta': 'the analyzer writes `meta: {}` at one site and never puts anything in it',
  'column:defaultExpression': 'the analyzer writes `defaultExpression: undefined` and never sets it',
};
const emptyOkUsed = new Set<string>();

// Whether a value says anything at all. Two sides agreeing on `[]`, `{}`, `false` or nothing at
// all is not a comparison of that field, it is a comparison of its absence.
const meaningful = (v: unknown) =>
  !(
    v === undefined ||
    v === null ||
    v === false ||
    v === '' ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0)
  );
// Seeded from the field names each side reported producing, so a field that is `undefined`
// everywhere and therefore absent from the JSON is still held to the rule below.
const seen = new Map<string, boolean>();
for (const side of [a, b]) {
  if (!side.fields?.table?.length || !side.fields?.column?.length) {
    console.error('    FAIL: a description arrived without the field names it produced, so the');
    console.error('          guard below would have had nothing to check and would have passed.');
    process.exit(1);
  }
  for (const kind of ['table', 'column'] as const) {
    for (const f of side.fields[kind]) seen.set(`${kind}:${f}`, false);
  }
}

const compare = (kind: string, label: string, l: Record<string, unknown>, r: Record<string, unknown>) => {
  // The union of both sides' keys, so a field only one major produces is a difference rather
  // than something the loop never looks at. Reading `Object.keys(l)` alone is how a v1-only
  // field would go unexamined forever.
  for (const f of new Set([...Object.keys(l), ...Object.keys(r)])) {
    const field = `${kind}:${f}`;
    seen.set(field, (seen.get(field) ?? false) || meaningful(l[f]) || meaningful(r[f]));
    const lv = JSON.stringify(l[f]);
    const rv = JSON.stringify(r[f]);
    if (lv === rv) continue;
    const key = `${label}.${f}`;
    if (ALLOWED[key] || DEFECTS[key]) {
      used.add(key);
      suppressed.push({ key, defect: !ALLOWED[key] });
      continue;
    }
    diffs.push(`${key}: 0.4x ${lv}, v1 ${rv}`);
  }
};

let compared = 0;
const names = [...new Set([...Object.keys(a.columns), ...Object.keys(b.columns)])];
for (const n of names) {
  const l = a.columns[n];
  const r = b.columns[n];
  if (!l || !r) {
    diffs.push(`${n}: present on ${l ? '0.4x' : 'v1'} only`);
    continue;
  }
  compared++;
  compare('column', n, l, r);
}

// Everything the analyzer says about the table rather than about one column: its primary key,
// its uniques, its indexes, its foreign keys and its parsed CHECK expressions. All of it is
// identical across the majors today, and none of it was compared before.
const tables = [...new Set([...Object.keys(a.tables), ...Object.keys(b.tables)])];
for (const t of tables) {
  const l = a.tables[t];
  const r = b.tables[t];
  if (!l || !r) {
    diffs.push(`table ${t}: present on ${l ? '0.4x' : 'v1'} only`);
    continue;
  }
  compare('table', `table:${t}`, l, r);
}

// A comparison that compared nothing must fail rather than print a reassuring number.
//
// Both fixtures have to have loaded on both sides, and every field either of them produces has
// to have carried a real value somewhere. The second half is the general form of a specific
// check that used to sit here for CHECK expressions alone, and it is here because the specific
// one was not enough: `unique`, `foreignKeys` and every column's `references` were `[]` or
// absent across the whole fixture, and this stage called them facts that agree across the
// majors.
//
// It holds every field the analyzer *assigns*, including the ones it assigns `undefined` to on
// every column, because the field names come from what it produced rather than from what
// survived serialisation. It cannot hold a field that is spread in conditionally and never
// fires, which is this analyzer's usual style for an optional one. Measured with a control
// either way: a field written `...(false ? { probe: 1 } : {})` never reaches the field list and
// this stage stays green, while the same field written `probe: undefined` is named and it fails.
//
// One field is outside it today:
//
//   readOnly   packages/analyzer/src/index.ts:1414, set for a materialized view. Adding one
//              covers the v1 side alone: `pgMaterializedView` answers a `drizzle:Columns`
//              lookup on 1.0.0-rc.4 and returns undefined on 0.45.2, so the analyzer sees no
//              0.4x view of any kind as a relation, and this stage would report the table as
//              present on v1 only. Covering `readOnly` means dealing with that first.
//
// `maxBytes` was the other, on the claim that no fixture this stage could carry would produce
// one, since the MySQL parity fixture cannot be imported under 0.45.2. That was an impossibility
// argued from a different fixture, and it was false: `src/mysql-text.ts` above uses the text
// family alone, imports on both majors and carries a cap on four columns, through
// packages/analyzer/src/index.ts:478 on v1 and the conditional spread at :1302 on 0.4x. Both
// sites are MySQL-gated, so "set only on MySQL" is the part of the old sentence that held.
const REQUIRED = [
  'rows', 'parents', 'children', 'pairs', 'notes', 'mtext', 'matrix', 'arrays', 'defaulted',
  'checked', 'nullable',
];
const missing = REQUIRED.filter((t) => !a.tables[t] || !b.tables[t]);
if (missing.length) {
  diffs.push(`these tables are missing from one side or both: ${missing.join(', ')}`);
}
if (!compared) diffs.push('no column was described on both sides, so nothing was compared');
// Kept specific as well as general. The rule below is satisfied by any table carrying a CHECK,
// and `checked` is the table whose entire purpose is to carry them. The two say the same thing
// only for as long as it is the only such table, and the general rule alone would let this one
// stop parsing them while something else went on carrying one.
if (!(a.tables.checked?.checks ?? []).length) {
  diffs.push('the checked table parsed no CHECK expressions, so nothing was compared');
}
for (const [field, sawValue] of seen) {
  const noun = field.startsWith('table:') ? 'table' : 'column';
  if (sawValue) continue;
  if (EMPTY_OK[field]) {
    emptyOkUsed.add(field);
    continue;
  }
  diffs.push(
    `${field} was empty on both sides of every ${noun}, so comparing it proves nothing. ` +
      'Give the fixture one that carries a value.'
  );
}

// The precondition the four `mtext` entries above are argued from, made executable.
//
// That argument has two halves. One is a property of UTF-8 and cannot change. The other is
// `maxBytes <= maxLength` on the column, which is a property of what the analyzer read, and
// nothing held it: a column whose byte cap is above its character cap makes v1's character check
// the deciding one. With a 20 byte cap and a 10 character cap, 15 ascii characters pass the byte
// check and fail the other, so v1 refuses a value 0.4x takes and those entries stop describing a
// difference in wording alone.
//
// Nothing in this fixture can do that today, and the reason is drizzle's rather than the schema's:
// handing `text()` a `{ length: 10 }` moves neither major, because v1 overwrites it with the
// type's own cap and 0.4x carries no length on a text column at all. Both measured, at runtime, on
// the column object the analyzer reads. A choice that release makes is not a rule, which is why
// this is a check rather than one more sentence.
//
// A column carrying only one of the two caps is outside this: with no `maxLength` there is no
// character check to bind, and with no `maxBytes` there is no byte check to bind first.
const capChecked: string[] = [];
const capBroken: string[] = [];
for (const [side, doc] of [['0.4x', a], ['v1', b]] as const) {
  const cols = doc.columns as Record<string, Record<string, unknown>>;
  for (const [name, col] of Object.entries(cols)) {
    const bytes = col.maxBytes;
    const chars = col.maxLength;
    if (typeof bytes !== 'number' || typeof chars !== 'number') continue;
    capChecked.push(`${side} ${name}`);
    if (bytes > chars) capBroken.push(`${side} ${name}: maxBytes ${bytes} over maxLength ${chars}`);
  }
}

const defects = suppressed.filter((s) => s.defect);
const columnsWithDefects = [...new Set(defects.map((s) => s.key.replace(/\.[^.]+$/, '')))];
console.log(
  `    ${compared} columns and ${tables.length} tables compared, ` +
    `drizzle-orm ${a.drizzle} against ${b.drizzle}`
);
console.log(
  `    ${suppressed.length - defects.length} documented difference(s) between the majors, ` +
    `${defects.length} known-defect field(s) on ${columnsWithDefects.length} column(s)`
);
if (columnsWithDefects.length) {
  console.log(`    described differently per major: ${columnsWithDefects.join(', ')}`);
}
console.log(`    ${capChecked.length} column(s) carry both a byte cap and a character cap`);

// A waiver that suppresses nothing is a sentence claiming a difference exists, sitting next to
// the ones that do. Both maps are held to it, so fixing a defect fails this stage until its
// entry goes, which is the only thing keeping the DEFECTS map from becoming a place to put
// failures.
const dead = [
  ...Object.keys(ALLOWED).filter((k) => !used.has(k)).map((k) => `ALLOWED[${k}]`),
  ...Object.keys(DEFECTS).filter((k) => !used.has(k)).map((k) => `DEFECTS[${k}]`),
  // An EMPTY_OK entry is used by the field staying empty. One that is no longer needed means
  // the field now carries a value somewhere, which is the good outcome and still has to be
  // recorded by deleting the entry.
  ...Object.keys(EMPTY_OK).filter((k) => !emptyOkUsed.has(k)).map((k) => `EMPTY_OK[${k}]`),
];
if (dead.length) {
  console.error('    FAIL: these entries suppressed nothing on this run. If the analyzer was');
  console.error('          fixed, delete them; they now describe something nobody can observe:');
  for (const k of dead) console.error(`      ${k}`);
}

if (diffs.length) {
  console.error('    FAIL: the analyzer describes the same schema differently per major:');
  for (const d of diffs) console.error(`      ${d}`);
  console.error('\n    A generator reads these fields, so a difference here is a different schema.');
}

if (!capChecked.length) {
  console.error('    FAIL: no column carries both a byte cap and a character cap, so the rule');
  console.error('          above compared nothing. The four mtext entries are argued from it, so');
  console.error('          give the fixture a column carrying both or drop the argument.');
}
if (capBroken.length) {
  console.error('    FAIL: a byte cap is above the character cap on the same column, so the code');
  console.error('          point check v1 adds can refuse a value the byte check accepts, and the');
  console.error('          mtext entries above no longer describe a difference in wording alone:');
  for (const c of capBroken) console.error(`      ${c}`);
}

if (diffs.length || dead.length || capBroken.length || !capChecked.length) process.exit(1);
CROSS

OLD_JSON="$WORK/cols-0.4x.json" NEW_JSON="$WORK/cols-v1.json" npx tsx cross-major.ts || {
  echo "FAIL: the analyzer is not consistent across drizzle-orm majors." >&2
  exit 1
}

cat > check-old.ts <<'OLD_CHECK'
import { SchemaAnalyzer } from '@drzl/analyzer';

/**
 * What the analyzer makes of the 0.4x tree on its own, with no other major to compare against.
 *
 * The diff above is relative: it can only see the two majors disagreeing. This one is absolute,
 * and it is what still fires when they agree about something wrong. Measured: deleting both the
 * `PgEnumColumn` arm and the v1 path makes five enum columns `unknown` on both sides at once,
 * where the comparison above has nothing to say and this reports every one of them.
 */

/**
 * Columns 0.4x cannot name today. Filed, not tolerated: naming one makes its entry dead and
 * fails this check, so a fix cannot land quietly. The same three columns carry entries in the
 * DEFECTS map above, which is the relative half of the same finding.
 */
const KNOWN_UNNAMED: Record<string, string> = {
  // Empty, and that is a result rather than a reason to delete this check. Every Postgres class the
  // 0.4x path could not name has an arm now: `c_vector` and `n_vector` went first, then
  // `c_geometry`, `c_bit` and their nullable twins. Each entry died the moment its arm landed and
  // this stage named it.
  //
  // It still fails on the first column that comes back unnamed, which is the direction that matters
  // from here, and an empty map is the strongest form of that claim rather than the weakest.
};

// `npm init -y` leaves the project CommonJS, where tsx refuses a top-level await.
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

async function main() {
let bad = 0;

// The reason the matrix fixture loses a column on the way in. Asserted rather than trusted,
// because the whole justification for editing that file is that this export does not exist
// here, and a pin that moves to a release carrying it should say so instead of quietly
// analyzing 40 columns where the parity stage analyzes 41.
const pgCore: Record<string, unknown> = await import('drizzle-orm/pg-core');
if (typeof pgCore.bytea === 'function') {
  console.error('    FAIL: this drizzle-orm exports `bytea`, so the matrix fixture no longer has');
  console.error('          to have it stripped. Drop the edit in the stage above and let this');
  console.error('          fixture carry the column.');
  bad++;
}

const cols: Array<{ table: string; name: string; tsType: string; dbType: string; arrayDimensions?: number }> = [];
for (const file of ['src/schema.ts', 'src/matrix.ts', 'src/mysql-text.ts']) {
  const a = await new SchemaAnalyzer(file).analyze({});
  for (const t of a.tables) {
    for (const c of t.columns) cols.push({ table: t.name, ...c });
  }
}
if (!cols.length) {
  console.error('FAIL: no columns analyzed on drizzle-orm 0.4x at all.');
  process.exit(1);
}

// A column the analyzer cannot name is the shape this failure takes: nothing throws, the
// generators emit `z.unknown()`, and every row validates.
const named = (c: { table: string; name: string }) => `${c.table}.${c.name}`;
const usedKnown = new Set<string>();
const vague = cols.filter((c) => {
  if (c.tsType !== 'unknown' && c.dbType !== 'UNKNOWN') return false;
  if (KNOWN_UNNAMED[named(c)]) {
    usedKnown.add(named(c));
    return false;
  }
  return true;
});
const arrays = cols.filter((c) => c.name.match(/^(tags|scores|moods|grid|c_text_arr|c_int_arr|c_enum_arr|c_varchar_arr)$/));
const notArrays = arrays.filter((c) => !c.arrayDimensions);

console.log(
  `    ${cols.length} columns analyzed on drizzle-orm 0.4x, ${vague.length} unnamed ` +
    `beyond the ${Object.keys(KNOWN_UNNAMED).length} filed as defects`
);

if (vague.length) {
  console.error('    FAIL: analyzed as unknown on 0.4x:');
  for (const c of vague) console.error(`      ${named(c)} (${c.dbType})`);
  bad++;
}
const deadKnown = Object.keys(KNOWN_UNNAMED).filter((k) => !usedKnown.has(k));
if (deadKnown.length) {
  console.error('    FAIL: these columns are named on 0.4x now, so their entries describe a');
  console.error('          defect that no longer happens. Delete them, here and in the DEFECTS');
  console.error('          map of the comparison above:');
  for (const k of deadKnown) console.error(`      ${k}`);
  bad++;
}
if (!arrays.length) {
  console.error('    FAIL: the fixture has no array columns, so nothing was checked for one.');
  bad++;
}
if (notArrays.length) {
  console.error('    FAIL: an .array() column carries no dimension:');
  for (const c of notArrays) console.error(`      ${named(c)}`);
  bad++;
}
const grid = cols.find((c) => c.name === 'grid');
if (!grid || grid.arrayDimensions !== 2) {
  console.error(`    FAIL: text().array().array() reported ${grid?.arrayDimensions} dimensions, not 2`);
  bad++;
}
if (bad) process.exit(1);
}
OLD_CHECK

if ! npx tsx check-old.ts; then
  echo "FAIL: the analyzer loses column types on drizzle-orm 0.4x." >&2
  exit 1
fi

# ---------------------------------------------------------------------------------------------
# The same differential parity as the stage near the top of this file, on the other major.
#
# That stage installs drizzle-orm@1.0.0-rc.4 and measures v1 alone, so its 36 parity lines said
# nothing about 0.45.2, which is what `npm install drizzle-orm` still serves. The comparison above
# is relative: it can see the two majors disagreeing about a column, and cannot see either of them
# being wrong. This one is absolute on 0.4x, against the first-party validators for that major.
#
# Those are four separate packages rather than submodules of drizzle-orm, and each is pinned for
# the reason drizzle-orm is: the target is a specific release, and a floating one turns an upstream
# change into a mysterious failure here rather than a deliberate re-measurement. They were chosen
# by installing them and running them, not from a compatibility table:
#
#   drizzle-zod 0.8.3, drizzle-valibot 0.4.2, drizzle-arktype 0.1.3, drizzle-typebox 0.3.3
#
# All four declare `drizzle-orm >=0.36.0`, all four import against 0.45.2, and all four build
# select, insert and update schemas for all three dialects here. None had to be skipped.
#
# The json-schema generator takes no part, for the same reason it takes none in the v1 pass: there
# is no official JSON Schema module to compare it against. That is stated in the stage output
# rather than left to a reader of this comment, because a generator the stage quietly does not
# reach is indistinguishable from one that passes.
# ---------------------------------------------------------------------------------------------
echo "==> differential parity against the official 0.4x validators"
# @electric-sql/pglite for the same reason the v1 tree has it: where the official validator crashes
# on a value there is nothing left to compare DRZL against, and a real Postgres is what says
# whether DRZL's answer to that value is the right one. It ships a CommonJS build, which this tree
# needs and the v1 one does not.
npm install --no-audit --no-fund --loglevel=error \
  drizzle-zod@0.8.3 drizzle-valibot@0.4.2 drizzle-arktype@0.1.3 drizzle-typebox@0.3.3 \
  valibot arktype @sinclair/typebox @electric-sql/pglite >/dev/null

cp "$WORK/parity-pool.ts" src/pool.ts

# The MySQL and SQLite fixtures the v1 pass measures, read out of that tree rather than re-typed,
# so widening one fixture widens both comparisons. `src/matrix.ts` is already here: the stage above
# derived it from the Postgres one.
#
# MySQL loses one column on the way in. 0.4x's mysql-core has no `blob` export, so a fixture
# carrying it cannot be imported at all, and that is the only missing one: `tinytext`, `mediumtext`
# and `longtext` are all functions there, and every other type this fixture names resolves.
# Measured by importing the module and asking, not by reading a changelog.
#
# SQLite loses nothing. Every type its fixture names, including all four blob modes, exists on
# 0.45.2.
#
# Both edits are checked for having changed what they claim to change, because a `sed` that matches
# nothing is the quiet way to end up comparing the wrong file, and a `cp` of a fixture that has
# since grown a 0.4x-only import would fail much further down as an import error nobody expects.
for f in schema-mysql schema-sqlite; do
  [ -f "$PARITY/src/$f.ts" ] || {
    echo "FAIL: $PARITY/src/$f.ts is not where this stage expects it, so there is nothing to" >&2
    echo "      measure against the official 0.4x validators." >&2
    exit 1
  }
done
sed -e 's/ blob,//' -e '/m_blob/d' "$PARITY/src/schema-mysql.ts" > src/matrix-mysql.ts
if cmp -s "$PARITY/src/schema-mysql.ts" src/matrix-mysql.ts; then
  echo "FAIL: nothing was removed from the MySQL parity fixture, so either blob is gone from it" >&2
  echo "      (in which case delete the edit above and use the file as it is) or the edit no" >&2
  echo "      longer matches what it is meant to remove." >&2
  exit 1
fi
if grep -q 'blob' src/matrix-mysql.ts; then
  echo "FAIL: blob survived the edit above, so this fixture cannot be imported under 0.4x." >&2
  exit 1
fi
cp "$PARITY/src/schema-sqlite.ts" src/matrix-sqlite.ts

for dialect in pg mysql sqlite; do
  case "$dialect" in
    pg)     schema=src/matrix.ts ;;
    mysql)  schema=src/matrix-mysql.ts ;;
    sqlite) schema=src/matrix-sqlite.ts ;;
  esac
  gens=""
  for lib in zod valibot arktype typebox; do
    gens="$gens    { kind: '$lib', path: 'src/gen-0-4x/$dialect/$lib' },"$'\n'
  done
  cat > "drzl.0-4x.$dialect.config.ts" <<CONFIG
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: '$schema',
  outDir: 'src/gen-0-4x/$dialect',
  generators: [
$gens  ],
});
CONFIG
  npx drzl generate --config "drzl.0-4x.$dialect.config.ts" >/dev/null
  for lib in zod valibot arktype typebox; do
    if [ ! -e "src/gen-0-4x/$dialect/$lib/matrix.$lib.ts" ]; then
      echo "FAIL: the $lib generator produced no file for the $dialect 0.4x parity matrix." >&2
      exit 1
    fi
  done
done


cat > parity-0-4x.ts <<'PARITY_0_4X'
/**
 * Differential parity for DRZL's validator generators on drizzle-orm 0.4x.
 *
 * Same method as `src/parity.ts` in the v1 tree and the same pool of values, imported from the
 * same file: build a schema for every column of every table in three dialects and all three
 * modes, with DRZL and with the official first-party module, then push the pool through both and
 * compare verdicts. Reading the emitted source cannot do this, because a schema that validates
 * and one that merely parses look identical as text.
 *
 * The ledger is the part that makes this runnable rather than permanently red. Two maps:
 *
 *   ALLOWED  DRZL and the official 0.4x module really do differ here, deliberately.
 *   DEFECTS  DRZL is wrong on 0.4x, whichever way the difference runs. Filed rather than fixed,
 *            and reported every run. Not "looser than official": ALLOWED entries are looser and
 *            right too, because the database says so, and every run counts how many rather than
 *            leaving a number here to go stale. Two copies of this sentence carried the same
 *            number; the round that corrected it landed on the one over the map itself and left
 *            this one behind, which is what a number in prose costs.
 *
 * Both are asserted exactly and in both directions. A difference in neither map fails the stage; an
 * entry that suppresses nothing fails it; and an entry whose libraries, modes, pairing count or
 * exact divergence no longer match what was measured fails it with the observed signature printed.
 * That last direction is the one that matters. A list checked only for additions turns into a
 * record of things that used to be wrong, and a fix then regresses with the gate still green.
 *
 * `divergence` is what makes an entry pin a specific difference rather than a shape. Three
 * sabotages walked through the shape-only version, and all three are named now, each verified by
 * running the stage against the edited output:
 *
 *   c_char capped at 400 code points instead of 4
 *   c_char's length check deleted, so a char(4) schema takes a 70,000 character string
 *   m_tinytext tightened from 255 bytes to 3, so it refuses 'hello' into a TINYTEXT column
 *
 * None of them changes the libraries, the modes, the pairing count or which way the disagreement
 * runs. All of them change which probes differ, which is the only thing that cannot be preserved
 * by a change to the column's behaviour.
 *
 * `c_char` was the example this docstring used to call an exception. It is not one, and the
 * numbers are worth keeping because they show what a partial fix looks like. Recomputed against
 * the real official field: it differs on 7 pool values today, on 5 if DRZL counted UTF-16 units,
 * and on none if DRZL demanded exactly 4 code points. Every one of those is a different signature,
 * so all three states are distinguishable now, where before only the third was.
 *
 * A ragged defect, one that reached zod on select and valibot on insert alone, is declarable:
 * `divergence` keys are `<modes>/<libraries>` and can name a single pairing. The pairing count
 * would still have to be stated, and a sentence here used to say such a defect would have to be
 * split into two entries, which the key format does not allow.
 */
import { readFileSync } from 'node:fs';
import { constants } from 'node:buffer';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { SchemaAnalyzer } from '@drzl/analyzer';
import {
  POOL,
  LIBS,
  probe,
  askPostgres,
  askPresence,
  type DbProbe,
  type Lib,
  type Presence,
  type Verdict,
} from './src/pool.js';

import {
  createSelectSchema as zSelect,
  createInsertSchema as zInsert,
  createUpdateSchema as zUpdate,
} from 'drizzle-zod';
import {
  createSelectSchema as vSelect,
  createInsertSchema as vInsert,
  createUpdateSchema as vUpdate,
} from 'drizzle-valibot';
import {
  createSelectSchema as aSelect,
  createInsertSchema as aInsert,
  createUpdateSchema as aUpdate,
} from 'drizzle-arktype';
import {
  createSelectSchema as tSelect,
  createInsertSchema as tInsert,
  createUpdateSchema as tUpdate,
} from 'drizzle-typebox';

import { matrix as pgTable, nullable as pgNullable } from './src/matrix.js';
import { matrix as myTable, nullable as myNullable } from './src/matrix-mysql.js';
import { matrix as sqTable, nullable as sqNullable } from './src/matrix-sqlite.js';

const OFFICIAL: Record<string, Record<string, (t: any) => any>> = {
  zod: { select: zSelect, insert: zInsert, update: zUpdate },
  valibot: { select: vSelect, insert: vInsert, update: vUpdate },
  arktype: { select: aSelect, insert: aInsert, update: aUpdate },
  typebox: { select: tSelect, insert: tInsert, update: tUpdate },
};

type Entry = {
  /** The libraries this difference shows up in, asserted exactly against what was measured. */
  libs: string[];
  /** The modes it shows up in, asserted the same way. */
  modes: string[];
  /**
   * The exact divergence this entry covers, keyed `<modes>/<libraries>` with `*` for all of them.
   *
   * A signature is `L: <labels DRZL accepts and official refuses> | T: <the other way>`, in pool
   * order, and it has to match what the run measured character for character.
   * `every probe official rejects (N of them), and official accepts only: <labels>` states the
   * same set from the other end, for the columns DRZL accepts the whole pool of: the divergence is
   * exactly official's rejections, N is how many those are, and the labels are the complement,
   * which is a handful where the list they replace is nearly the whole pool. Naming the complement
   * is what makes it a set. The count on its own was a shape, measured: with `c_vector` changed
   * from `vector({ dimensions: 3 })` to `dimensions: 2`, official refuses `[1,2,3]` and accepts
   * `[1,2]`, which is the opposite behaviour at an unchanged count, and the stage was green.
   *
   * This replaced a `direction` field, which named only which way the disagreement ran. That
   * closed a reversal and nothing else, and three sabotages walked through it: capping `c_char` at
   * 400 code points instead of 4, deleting its length check entirely so a `char(4)` schema takes a
   * 70,000 character string, and tightening `m_tinytext` from 255 bytes to 3. All three keep the
   * libraries, the modes, the pairing count and the direction, and all three are named now,
   * because all three change which probes differ.
   *
   * It is brittle against a pool change, deliberately. Adding a value that any waived column
   * treats differently from official has to re-open that waiver, because the alternative is a
   * waiver silently covering a divergence nobody has looked at, which is how two filed `maxLength`
   * fields spent a round under a green line.
   */
  divergence: Record<string, string>;
  /** What DRZL emits on 0.4x. */
  drzl: string;
  /** What the official 0.4x module emits for the same column. */
  official: string;
  /** Which filed defect this is, or why it is not one. */
  filed: string;
};

/**
 * A signature for a column DRZL accepts every probe of: official's rejection count, plus the exact
 * set official accepts instead. The columns in that state are the ones the class-name path cannot
 * name at all, and the alternative is writing out nearly the whole pool once per pairing group.
 * How many they are is printed by the run, off the ledgers themselves, rather than written here.
 *
 * Naming what official accepts names the divergence exactly, from the other end. DRZL accepted
 * every compared probe, so the probes that differ are exactly the ones official rejected, and that
 * is every compared probe except the ones listed here: a handful of labels instead of nearly all
 * of them.
 *
 * Both halves are here because each closed a hole the other left open, and both holes were live.
 *
 *   the count       the phrase alone pinned DRZL's side only. "DRZL accepts everything" fails the
 *                   moment DRZL stops accepting everything, but official was not mentioned, so
 *                   official narrowing its rejections to two left the signature unmoved.
 *   the complement  the count pinned how many, not which. Measured: `c_vector` changed from
 *                   `vector({ dimensions: 3 })` to `dimensions: 2` in src/matrix.ts makes official
 *                   accept `[1,2]` and refuse `[1,2,3]`, the opposite behaviour, at an unchanged
 *                   count on all 12 pairings. The stage exited 0 and went on printing "official
 *                   emits an array of exactly 3 numbers". With the complement declared the same
 *                   edit exits 1 on all 12 pairings.
 *
 * Why the numbers are not uniform over the 72 pairings, measured on this run rather than reasoned,
 * and now visible in the declarations themselves rather than only described here:
 *
 *   update on zod, valibot, arktype   one fewer rejection, always `undefined`. Official's update
 *                                     schema marks the field optional, and in those three the
 *                                     extracted field takes `undefined` on its own.
 *   update on typebox                 no such move. TypeBox holds optionality as a modifier the
 *                                     parent object consults, and this harness compares
 *                                     `s.properties[k]`, where it is inert:
 *                                     `Value.Check(prop, undefined)` is false with
 *                                     `Symbol(TypeBox.Optional)` present on the property, and
 *                                     deleting that symbol changes no pool verdict at all.
 *   valibot on c_geometry             one fewer in every mode: official builds a `v.tuple`, which
 *                                     ignores extra items, so `[1,2,3]` and `[1,2,3,4]` both go
 *                                     into a 2-tuple and `[1,2,3]` is accepted alongside `[1,2]`.
 *   typebox on c_bit                  a count of its own in every mode, and not because it takes
 *                                     anything the other three refuse. Official's TypeBox schema
 *                                     throws on `null` and `undefined` for that column, so those
 *                                     two probes are not compared at all: they go to the THREW
 *                                     ledger and are arbitrated against a real Postgres. An
 *                                     earlier version of this note said "TypeBox refuses two fewer
 *                                     probes than the rest on `c_bit`", which reads as a rejection
 *                                     it never made and was wrong about update as well. The
 *                                     declarations below are the counts; no number is repeated
 *                                     here, because the one that was went stale twice.
 */
const allProbes = (n: number, accepted: string[]) =>
  `every probe official rejects (${n} of them), and official accepts only: ` +
  (accepted.length ? accepted.join(', ') : 'nothing in the pool');

/**
 * Does a declaration key such as `select,insert/zod,typebox` cover the pairing `select/zod`?
 * `*` on either side means all of them. Kept deliberately dumb: a declaration that covers no
 * pairing, or two that cover the same one, both fail rather than being resolved by precedence.
 */
const pairingMatches = (decl: string, pairing: string) => {
  const [dModes, dLibs] = decl.split('/');
  const [mode, lib] = pairing.split('/');
  const covers = (spec: string, x: string) => spec === '*' || spec.split(',').includes(x);
  return covers(dModes, mode) && covers(dLibs, lib);
};

const LIB_NAMES = ['zod', 'valibot', 'arktype', 'typebox'];
const MODE_NAMES = ['select', 'insert', 'update'];
// Insert and update. A divergence that only exists on write is a different claim from one that
// exists on read, and coerceDates is the reason the distinction is load-bearing here.
const WRITE = ['insert', 'update'];

/**
 * Divergences from the official 0.4x module that are deliberate and reasoned.
 *
 * Every one of these also holds against the v1 module, and the v1 pass carries the same reasoning
 * in its own ALLOWED map, except where noted on `c_char`.
 */
const ALLOWED: Record<string, Entry> = {
  // Two independent differences meet on this column, and only the first of them is in the v1 pass.
  //
  //   code points   a character limit counts characters; official counts `.length`, which is
  //                 UTF-16 units, so it refuses three emoji in a char(4) the database accepts.
  //   exact length  drizzle-zod 0.8.3 emits `length_equals 4`, on all three modes. Official v1
  //                 emits a maximum and no minimum, which is what DRZL emits on both majors, so
  //                 only the 0.4x module can see this at all.
  //
  // The exact-length half is upstream being stricter than the database on write, measured against
  // Postgres through PGlite rather than argued: `insert into t (c) values ('ab')` into a `char(4)`
  // is accepted and reads back as `'ab  '`, four characters. So official 0.4x refuses a legal
  // insert, and DRZL's select schema is the loose one, since a row from that column is always
  // four characters wide.
  'pg/c_char': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    divergence: { '*/*': `L: "", 3 emoji, 'zzz', 'a', 'x', '010' | T: ` },
    drzl: 'a string of at most 4 code points',
    official: 'a string of exactly 4 UTF-16 units',
    filed: 'not a defect: two deliberate differences, see the note above',
  },
  'mysql/m_char': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    divergence: { '*/*': `L: "", 3 emoji, 'zzz', 'a', 'x', '010' | T: ` },
    drzl: 'as pg/c_char',
    official: 'as pg/c_char',
    filed: 'as pg/c_char',
  },
  // MySQL caps the TEXT family in bytes; official caps it in UTF-16 units. A real MySQL 8 on a
  // utf8mb4 client is the authority and puts DRZL on the right side of it: a 100 emoji string is
  // 200 units and 400 bytes, `insert into caps (t) values (?)` into a `tinytext` fails with "Data
  // too long", and the same string goes into a `varchar(255)` and reports `length` 400 with
  // `char_length` 100. So one table has a byte budget and a character count side by side.
  //
  // Until the pool carried that string, all four MySQL text columns reported parity on both
  // majors while `mtext.t_text.maxLength` and its three siblings were filed against them. The
  // green line was not agreement, it was a pool with nothing in it that could tell the two counts
  // apart: every other string here is ascii, where they coincide, or too short to reach a cap.
  //
  // Which of the four columns this reaches is a property of the pool and is settled by arithmetic
  // rather than by trying strings. A separating probe must be over the cap in bytes and not over it
  // in UTF-16 units, and UTF-8 spends at most 3 bytes per unit, so it needs more than cap/3 units:
  // 86 for `tinytext` and 21846 for `text`, both carried in the pool, 5592406 for `mediumtext`,
  // which is a 10.7 MiB string measured by the byte-cap stage below instead of by every pairing,
  // and 1431655766 for `longtext`, which is more than V8 will let a string be.
  'mysql/m_tinytext': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    divergence: { '*/*': `L:  | T: 100 emoji` },
    drzl: 'a string of at most 255 UTF-8 bytes, which is the column budget',
    official: 'a string of at most 255 UTF-16 units, so it takes 400 bytes into a 255 byte column',
    filed: 'not a defect: DRZL is stricter, and MySQL itself refuses what official accepts',
  },
  // The same thing on `text`, reached by the 22000 CJK probe rather than the emoji one: 66000
  // bytes over 22000 units against a 65535 byte budget. Filed as `mtext.t_text.maxLength`, and it
  // sat under a green parity line on both majors until that probe existed.
  'mysql/m_text': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    divergence: { '*/*': `L:  | T: 22000 cjk` },
    drzl: 'a string of at most 65535 UTF-8 bytes, which is the column budget',
    official: 'a string of at most 65535 UTF-16 units, so it takes 66000 bytes into a 65535 byte column',
    filed: 'not a defect: as mysql/m_tinytext',
  },
  // `coerceDates` defaults to coercing on insert and update, which is a documented DRZL option and
  // is what `coerceDates: 'none'` turns off to match official exactly. Only strings and numbers
  // are coerced: null, booleans and arrays are still rejected.
  'pg/c_date_d': {
    libs: LIB_NAMES,
    modes: WRITE,
    divergence: {
      '*/zod': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101 | T: `,
      '*/valibot,arktype,typebox': `L: '2020-01-01', '2020-01-01T00:00:00Z' | T: `,
    },
    drzl: 'a Date, or a string or number coerced to one',
    official: 'a Date only',
    filed: 'not a defect: coerceDates',
  },
  'pg/c_ts_d': { libs: LIB_NAMES, modes: WRITE, divergence: { '*/zod': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101 | T: `, '*/valibot,arktype,typebox': `L: '2020-01-01', '2020-01-01T00:00:00Z' | T: `,     }, drzl: 'as pg/c_date_d', official: 'as pg/c_date_d', filed: 'as pg/c_date_d' },
  'mysql/m_date': { libs: LIB_NAMES, modes: WRITE, divergence: { '*/zod': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101 | T: `, '*/valibot,arktype,typebox': `L: '2020-01-01', '2020-01-01T00:00:00Z' | T: `,     }, drzl: 'as pg/c_date_d', official: 'as pg/c_date_d', filed: 'as pg/c_date_d' },
  'mysql/m_datetime': { libs: LIB_NAMES, modes: WRITE, divergence: { '*/zod': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101 | T: `, '*/valibot,arktype,typebox': `L: '2020-01-01', '2020-01-01T00:00:00Z' | T: `,     }, drzl: 'as pg/c_date_d', official: 'as pg/c_date_d', filed: 'as pg/c_date_d' },
  'mysql/m_ts': { libs: LIB_NAMES, modes: WRITE, divergence: { '*/zod': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101 | T: `, '*/valibot,arktype,typebox': `L: '2020-01-01', '2020-01-01T00:00:00Z' | T: `,     }, drzl: 'as pg/c_date_d', official: 'as pg/c_date_d', filed: 'as pg/c_date_d' },
  'sqlite/s_int_ts': { libs: LIB_NAMES, modes: WRITE, divergence: { '*/zod': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101 | T: `, '*/valibot,arktype,typebox': `L: '2020-01-01', '2020-01-01T00:00:00Z' | T: `,     }, drzl: 'as pg/c_date_d', official: 'as pg/c_date_d', filed: 'as pg/c_date_d' },
  // TypeBox fails a format it has no entry for rather than ignoring it, so official's schema
  // rejects every valid uuid in any project that has not populated `FormatRegistry` first.
  'pg/c_uuid': {
    libs: ['typebox'],
    modes: MODE_NAMES,
    divergence: { '*/*': `L: uuid | T: ` },
    drzl: 'a string carrying a uuid pattern, which needs no setup',
    official: "Type.String({ format: 'uuid' }), which rejects every uuid until FormatRegistry is populated",
    filed: 'not a defect: DRZL is the usable one',
  },
  // Stricter than official, in DRZL's favour, on every json column of every dialect.
  'pg/c_json': {
    libs: ['valibot'],
    modes: MODE_NAMES,
    divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` },
    drzl: 'a JSON value: no Infinity, no Date, no Buffer',
    official: 'v.any(), which takes all three',
    filed: 'not a defect: DRZL is stricter',
  },
  'pg/c_jsonb': { libs: ['valibot'], modes: MODE_NAMES, divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` }, drzl: 'as pg/c_json', official: 'as pg/c_json', filed: 'as pg/c_json' },
  'pg/c_jsonb_typed': { libs: ['valibot'], modes: MODE_NAMES, divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` }, drzl: 'as pg/c_json', official: 'as pg/c_json', filed: 'as pg/c_json' },
  'mysql/m_json': { libs: ['valibot'], modes: MODE_NAMES, divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` }, drzl: 'as pg/c_json', official: 'as pg/c_json', filed: 'as pg/c_json' },
  'sqlite/s_text_json': { libs: ['valibot'], modes: MODE_NAMES, divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` }, drzl: 'as pg/c_json', official: 'as pg/c_json', filed: 'as pg/c_json' },
  'sqlite/s_blob_json': { libs: ['valibot'], modes: MODE_NAMES, divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` }, drzl: 'as pg/c_json', official: 'as pg/c_json', filed: 'as pg/c_json' },
  // Arrived here when `point` stopped being typed `string` on 0.4x and started being the tuple it
  // is. The v1 pass has carried the same entry all along, for the same reason: DRZL emits
  // `v.strictTuple` and official emits `v.tuple`, which ignores anything past the declared
  // members. The other three libraries reject a third element on both sides.
  //
  // Postgres is what makes DRZL the right one, rather than a preference for strictness. Asked
  // through PGlite on a real `point` column, `[1, 2, 3]` is handed to the driver as `(1,2)`,
  // because drizzle's `mapToDriverValue` reads `value[0]` and `value[1]` and nothing else. The
  // insert succeeds, the column stores `(1,2)`, and the row reads back as `[1, 2]`. So the value
  // official accepts is one the database silently truncates.
  //
  // `c_line` is not here, and not because it behaves differently. The longest array in the pool
  // is `[1,2,3]`, which both a strict and a lax 3-tuple accept, so nothing in it separates the two
  // at that arity. The run asserts every entry's libs and divergence, so listing `c_line` on a
  // difference nothing measures would fail this stage rather than pass quietly.
  'pg/c_point': {
    libs: ['valibot'],
    modes: MODE_NAMES,
    divergence: { '*/*': `L:  | T: [1,2,3]` },
    drzl: 'a strict tuple of exactly two numbers',
    official: 'v.tuple, which ignores a third element the column then drops',
    filed: 'not a defect: DRZL is stricter, and Postgres truncates what official accepts',
  },
  // Looser than official, on purpose, and looser on a numeric range rather than on a format or a
  // length, which is the part worth reading for. An earlier version of this sentence called these
  // six the only entries in either pass running that way; they are not, and the run now counts and
  // prints how many waivers do. The reasoning, the PGlite measurements and the two caveats are
  // written out once at the same keys in the v1 pass near the top of this file, because both
  // majors now take the database's answer and moving one without the other is what the cross-major
  // diff catches.
  //
  // They were in DEFECTS below for one release, filed as "DRZL emits an unbounded number, official
  // emits a number within +/-8388607". The fix that closed that filed the wrong way: it adopted
  // official's bound, which refuses 8388608, 9000000, 1e9 and 2147483648 on a column that stores
  // and returns all four. Review measured the cost against the ground-truth pool at ten probes
  // Postgres stores and both DRZL and official refused. The bound is the database's now.
  //
  // `pg/c_numeric_n` is deliberately not among them. Its bound is the safe-integer range, which is
  // about what a JS number can carry rather than about the column, official emits the same one,
  // and Postgres is stricter than both: it refuses 2147483648 into a `numeric(10,2)`.
  // The arktype update arm gains `Infinity` alone. Official arktype already accepts NaN in its
  // union-shaped arms, so NaN was never a divergence there. Same split as the v1 pass.
  'pg/c_real': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    divergence: {
      'select,insert/*': `L: 9000000, 2147483648, 9007199254740993, 3.4028235e38, NaN, Infinity | T: `,
      'update/zod,valibot,typebox': `L: 9000000, 2147483648, 9007199254740993, 3.4028235e38, NaN, Infinity | T: `,
      'update/arktype': `L: 9000000, 2147483648, 9007199254740993, 3.4028235e38, Infinity | T: `,
    },
    drzl: 'a number within the magnitude Postgres accepts into a real, plus the non-finite values it stores',
    official: 'a number within +/-8388607, which refuses rows the column returns',
    filed: 'not a defect: the database is the arbiter, see the same key in the v1 pass',
  },
  // NaN and not the infinities, because Postgres takes an infinity into a numeric only when the
  // column carries no precision and the analyzer does not read precision at all. arktype on update
  // is excepted: official already accepts NaN there, so there is nothing to waive. See the v1 copy
  // of this entry for the full reasoning.
  'pg/c_numeric_n': { libs: LIB_NAMES, modes: MODE_NAMES, except: ['update/arktype'], divergence: { '*/*': `L: NaN | T: ` }, drzl: 'a number, plus the NaN Postgres stores in a numeric column', official: 'a number, refusing the NaN the database hands back', filed: 'not a defect: as pg/c_real' },
  // Not `as pg/c_real` in the signature, which it was until MySQL was measured: the two 4 byte
  // floats have different edges, and `3.4028235e38` is the probe that says so.
  'mysql/m_float': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/*': `L: 9000000, 2147483648, 9007199254740993 | T: ` }, drzl: 'as pg/c_real, at the narrower MySQL edge', official: 'as pg/c_real', filed: 'as pg/c_real' },
  'pg/c_double': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    divergence: {
      'select,insert/*': `L: 9007199254740993, 3.4028235e38, NaN, Infinity | T: `,
      'update/zod,valibot,typebox': `L: 9007199254740993, 3.4028235e38, NaN, Infinity | T: `,
      'update/arktype': `L: 9007199254740993, 3.4028235e38, Infinity | T: `,
    },
    drzl: 'an unbounded number, because no finite bound is true of an 8 byte float, plus the non-finite values it stores',
    official: 'a number within +/-140737488355327, which refuses an ordinary microsecond epoch',
    filed: 'not a defect: as pg/c_real',
  },
  'mysql/m_real': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/zod,typebox': `L: 9007199254740993, 3.4028235e38 | T: `, '*/valibot,arktype': `L: 9007199254740993, 3.4028235e38, Infinity | T: ` }, drzl: 'as pg/c_double', official: 'as pg/c_double', filed: 'as pg/c_real' },
  'mysql/m_double': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/zod,typebox': `L: 9007199254740993, 3.4028235e38 | T: `, '*/valibot,arktype': `L: 9007199254740993, 3.4028235e38, Infinity | T: ` }, drzl: 'as pg/c_double', official: 'as pg/c_double', filed: 'as pg/c_real' },
  'sqlite/s_real': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/zod,typebox': `L: 9007199254740993, 3.4028235e38 | T: `, '*/valibot,arktype': `L: 9007199254740993, 3.4028235e38, Infinity | T: ` }, drzl: 'as pg/c_double', official: 'as pg/c_double', filed: 'as pg/c_real' },

  // ---- the nullable table --------------------------------------------------------------------
  // Each of these is the divergence its `notNull` twin in `matrix` already carries, measured again
  // through the wrapper each generator puts round a nullable column. A signature identical to the
  // twin's is the evidence that the wrapping loses nothing. Three have no twin and they are the
  // three CHECK columns: no column of `matrix` carries a CHECK, and no first-party module reads
  // one at all.
  'pg/n_real': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/zod,valibot,typebox': `L: 9000000, 2147483648, 9007199254740993, 3.4028235e38, NaN, Infinity | T: `, '*/arktype': `L: 9000000, 2147483648, 9007199254740993, 3.4028235e38, Infinity | T: ` }, drzl: 'as pg/c_real', official: 'as pg/c_real', filed: 'as pg/c_real' },
  'pg/n_json': { libs: ['valibot'], modes: MODE_NAMES, divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` }, drzl: 'as pg/c_json', official: 'as pg/c_json', filed: 'as pg/c_json' },
  'pg/n_point': { libs: ['valibot'], modes: MODE_NAMES, divergence: { '*/*': `L:  | T: [1,2,3]` }, drzl: 'as pg/c_point', official: 'as pg/c_point', filed: 'as pg/c_point' },
  'pg/n_ts': { libs: LIB_NAMES, modes: WRITE, divergence: { '*/zod': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101 | T: `, '*/valibot,arktype,typebox': `L: '2020-01-01', '2020-01-01T00:00:00Z' | T: ` }, drzl: 'as pg/c_date_d', official: 'as pg/c_date_d', filed: 'as pg/c_date_d' },
  // The database has already answered this one in this same script: the CHECK ground-truth stage
  // runs 53 probes over the `checked` table against a real Postgres and reports rows Postgres
  // rejects and the validator accepts as DRZL 0, drizzle-orm 22, and `k_between BETWEEN 5 AND 15`
  // there is this column's own CHECK form. The v1 copy of this entry carries the rest of the
  // reasoning, including why the bound is two-sided.
  'pg/n_check': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/*': `L:  | T: 0, 1, -1, 200, 40000, 9000000, 1900, 2000, 2500, 17, 101` }, drzl: 'the column CHECK, as a bound', official: 'no CHECK at all: no first-party module reads one', filed: 'not a defect: this is what DRZL is for' },
  'mysql/m_n_text': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/*': `L:  | T: 22000 cjk` }, drzl: 'as mysql/m_text', official: 'as mysql/m_text', filed: 'as mysql/m_text' },
  'mysql/m_n_tinytext': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/*': `L:  | T: 100 emoji` }, drzl: 'as mysql/m_tinytext', official: 'as mysql/m_tinytext', filed: 'as mysql/m_tinytext' },
  'mysql/m_n_float': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/*': `L: 9000000, 2147483648, 9007199254740993 | T: ` }, drzl: 'as mysql/m_float', official: 'as mysql/m_float', filed: 'as pg/c_real' },
  'mysql/m_n_json': { libs: ['valibot'], modes: MODE_NAMES, divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` }, drzl: 'as pg/c_json', official: 'as pg/c_json', filed: 'as pg/c_json' },
  'mysql/m_n_datetime': { libs: LIB_NAMES, modes: WRITE, divergence: { '*/zod': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101 | T: `, '*/valibot,arktype,typebox': `L: '2020-01-01', '2020-01-01T00:00:00Z' | T: ` }, drzl: 'as pg/c_date_d', official: 'as pg/c_date_d', filed: 'as pg/c_date_d' },
  'mysql/m_n_check': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/*': `L:  | T: 0, 1, -1, 200, 40000, 9000000, 1900, 2000, 2500, 17, 101` }, drzl: 'as pg/n_check', official: 'as pg/n_check', filed: 'as pg/n_check' },
  'sqlite/s_n_real': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/zod,typebox': `L: 9007199254740993, 3.4028235e38 | T: `, '*/valibot,arktype': `L: 9007199254740993, 3.4028235e38, Infinity | T: ` }, drzl: 'as pg/c_double', official: 'as pg/c_double', filed: 'as pg/c_real' },
  'sqlite/s_n_json': { libs: ['valibot'], modes: MODE_NAMES, divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` }, drzl: 'as pg/c_json', official: 'as pg/c_json', filed: 'as pg/c_json' },
  'sqlite/s_n_ts': { libs: LIB_NAMES, modes: WRITE, divergence: { '*/zod': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101 | T: `, '*/valibot,arktype,typebox': `L: '2020-01-01', '2020-01-01T00:00:00Z' | T: ` }, drzl: 'as pg/c_date_d', official: 'as pg/c_date_d', filed: 'as pg/c_date_d' },
  'sqlite/s_n_check': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/*': `L:  | T: 0, 1, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, 17, 101` }, drzl: 'as pg/n_check', official: 'as pg/n_check', filed: 'as pg/n_check' },
  // ---- binary and varbinary, where only DRZL enforces the declared width ----------------------
  // These two were DEFECTS here until the analyzer stopped calling a byte string a Uint8Array. They
  // are waivers now because DRZL is the stricter side and the server agrees with it.
  //
  // `L:` is empty in all twelve pairings, where it used to carry Buffer and Uint8Array: DRZL is no
  // longer looser than official anywhere on this major. Official 0.4x emits a bare string with no
  // cap at all, so every value in `T:` is one over the declared byte width that official takes and
  // both DRZL and MySQL refuse.
  //
  // '3 emoji' on m_binary and '5 emoji' on m_varbinary sit in insert and update and not in select,
  // which is the cap being direction-dependent rather than noise: 12 bytes does not fit a
  // binary(4) and 20 does not fit a varbinary(16), while a value already in the column came from a
  // server that had room for it.
  'mysql/m_binary': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { 'select/*': `L:  | T: 'hello', 300-char, 70k-char, 5-char, 5 emoji, 'not-a-uuid', uuid, 'happy', '2020-01-01', '2020-01-01T00:00:00Z', '12:00:00', '25:99:99', 100 emoji, 22000 cjk, '999.999.999.999', '10.0.0.1'`, 'insert,update/*': `L:  | T: 'hello', 300-char, 70k-char, 5-char, 3 emoji, 5 emoji, 'not-a-uuid', uuid, 'happy', '2020-01-01', '2020-01-01T00:00:00Z', '12:00:00', '25:99:99', 100 emoji, 22000 cjk, '999.999.999.999', '10.0.0.1'` }, drzl: 'a string capped at the declared byte width', official: 'an uncapped string', filed: 'not a defect: DRZL is stricter here and the server agrees' },
  'mysql/m_varbinary': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { 'select/*': `L:  | T: 300-char, 70k-char, uuid, '2020-01-01T00:00:00Z', 100 emoji, 22000 cjk`, 'insert,update/*': `L:  | T: 300-char, 70k-char, 5 emoji, uuid, '2020-01-01T00:00:00Z', 100 emoji, 22000 cjk` }, drzl: 'as mysql/m_binary', official: 'as mysql/m_binary', filed: 'as mysql/m_binary' },
  // ---- geometry, where DRZL counts the coordinates and official does not ----------------------
  // These were DEFECTS across all four libraries while the class-name path could not name a
  // `geometry` column at all. It is named now and what survives is one library and one direction:
  // valibot's `v.tuple` ignores a third element, so official takes `[1,2,3]` into a two-coordinate
  // point and DRZL's tuple shape refuses it. ALLOWED[pg/n_point] already records the same valibot
  // capability difference from the other side.
  'pg/c_geometry': { libs: ['valibot'], modes: MODE_NAMES, divergence: { '*/valibot': `L:  | T: [1,2,3]` }, drzl: 'a two-number tuple', official: 'an array of any length', filed: 'not a defect: DRZL counts the coordinates and the server agrees' },
  'pg/n_geometry': { libs: ['valibot'], modes: MODE_NAMES, divergence: { '*/valibot': `L:  | T: [1,2,3]` }, drzl: 'as pg/c_geometry', official: 'as pg/c_geometry', filed: 'as pg/c_geometry' },
};

/**
 * Where DRZL is wrong on 0.4x, whichever way the difference runs.
 *
 * Not "looser than official", which is the neighbouring map's business as often as this one's:
 * ALLOWED above holds columns where DRZL is looser and right, because the database says so, and
 * the run prints how many of its entries run that way rather than a sentence here claiming a
 * number. The sentence that used to stand here said six, and the nullable twins added since made
 * it nine.
 * What puts an entry here is that DRZL's answer is wrong about the column.
 *
 * `filed: 'AC: ...'` names the fields the cross-major stage above already carries for the same
 * column. The two sets do not line up one to one and were never going to: that map records the
 * analyzer describing a column differently per major, and this one records the emitted validator
 * behaving differently from the first-party one. How many of these columns are filed there and how
 * many are new is not written here: the run splits this map on its own `filed` strings and prints
 * both, a few lines above the entries themselves. The sentence that stood here gave the second
 * number, and it was the ledger's size at the branch base rather than its size now, which the
 * nullable twins moved in the same edit that moved everything else this branch had to correct.
 * The new ones are mostly new because the cross-major fixture is Postgres plus four MySQL text
 * columns, so no MySQL binary, no MySQL year and no SQLite column of any kind had ever been
 * described under both majors.
 *
 * Nine entries have left this map, which is what it is for, and they left by two different doors.
 *
 * `pg/c_point` and `pg/c_line` were the class-name path answering `string` for a value the driver
 * hands back as a tuple. Fixed in the analyzer, and gone from both maps except for the valibot
 * strict-tuple entry above, which is DRZL being the stricter one.
 *
 * `pg/c_real`, `pg/c_double`, `mysql/m_real`, `mysql/m_double`, `mysql/m_float` and
 * `sqlite/s_real` were an inexact numeric column carrying no bound at all. They are in ALLOWED
 * above now rather than gone: they are still divergences, in the opposite direction, because the
 * bound DRZL adopted is the database's and not official's. `pg/c_numeric_n` is the one that is
 * simply gone, since its safe-integer bound is what official emits too.
 *
 * Removing an entry before the fix is what showed the entry was covering the defect: taking the
 * nine out on their own failed this stage with 108 parity findings naming exactly those nine
 * columns.
 *
 * Two kinds of filed defect are not in this map, and they are not there for different reasons.
 *
 * Invisible, because official is equally loose. `matrix.c_numeric.format` and its two siblings are
 * the numeric pattern being attached on the v1 arm only, so on 0.4x DRZL emits a bare string for
 * `c_numeric` and `c_decimal` and takes 'hello' back. Official drizzle-zod 0.8.3 emits a bare
 * string there too, so the two agree and this comparison reports nothing however it is probed. The
 * cross-major diff is what sees that one.
 *
 * Visible, and pointing the other way. `mtext.t_*.maxLength` is four filed fields on the MySQL text
 * family, and this comparison reports parity for all four, because the difference it would show is
 * DRZL being the stricter and correct one. Where each of the four is actually measured, since a
 * green `parity` line over a filed field is the thing a ledger is supposed to make impossible and
 * an earlier version of this paragraph claimed all four were in ALLOWED when two were not:
 *
 *   t_tiny     ALLOWED[mysql/m_tinytext], from the 100 emoji probe, and the byte-cap stage
 *   t_text     ALLOWED[mysql/m_text], from the 22000 CJK probe, and the byte-cap stage
 *   t_medium   the byte-cap stage alone. Its separating string is 10.7 MiB, too heavy for a pool.
 *   t_long     nothing. Its separating string would need more units than V8 will put in a string,
 *              and the byte-cap stage prints it by name as unprobeable rather than omitting it.
 *
 * So one of the four is genuinely uncovered, it is uncovered for a reason that is arithmetic
 * rather than effort, and the run says so out loud.
 */
const DEFECTS: Record<string, Entry> = {
  // ---- columns the class-name path cannot name at all ----------------------------------------
  // No arm for the class, so the column comes back `unknown` and every generator emits a validator
  // that accepts anything. The three Postgres ones are also named in check-old.ts, as an absolute
  // check rather than a relative one. The three SQLite ones are new here: `SQLiteBlobBuffer` and
  // the millisecond timestamp mode have no arm either, and no SQLite fixture had ever been
  // analyzed under 0.4x.
  //
  // A bare `blob()` is not the same column on the two majors, measured on the column object:
  // 0.45.2 builds a `SQLiteBlobBuffer` and 1.0.0-rc.4 builds a `SQLiteBlobJson`. So `s_blob` and
  // `s_blob_buf` are both buffer columns here, which is why official demands a Buffer for both.
  // `pg/c_bit` and `pg/n_bit` stood here and are gone: the column is named, so nothing about it
  // diverges from official any more. `pg/c_geometry` and `pg/n_geometry` moved to `ALLOWED` above,
  // narrowed from all four libraries and twelve pairings to valibot and three, in the one direction
  // where DRZL is the stricter and correct side.
  'sqlite/s_blob': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    divergence: {
      'select,insert/*': allProbes(62, ['Buffer']),
      'update/zod,valibot,arktype': allProbes(61, ['undefined', 'Buffer']),
      'update/typebox': allProbes(62, ['Buffer']),
    },
    drzl: 'unknown, which accepts every value in the pool',
    official: 'a Buffer',
    filed: 'new: no SQLiteBlobBuffer arm in the class-name path',
  },
  'sqlite/s_blob_buf': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    divergence: {
      'select,insert/*': allProbes(62, ['Buffer']),
      'update/zod,valibot,arktype': allProbes(61, ['undefined', 'Buffer']),
      'update/typebox': allProbes(62, ['Buffer']),
    },
    drzl: 'unknown, which accepts every value in the pool',
    official: 'a Buffer',
    filed: 'new: as sqlite/s_blob',
  },
  'sqlite/s_int_ts_ms': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    divergence: {
      'select,insert/*': allProbes(62, ['Date']),
      'update/zod,valibot,arktype': allProbes(61, ['undefined', 'Date']),
      'update/typebox': allProbes(62, ['Date']),
    },
    drzl: 'unknown, which accepts every value in the pool',
    official: 'a Date',
    filed: 'new: integer({ mode: timestamp_ms }) is unnamed on 0.4x',
  },

  // ---- a wrong type on MySQL -----------------------------------------------------------------
  // The class-name path answering with the wrong JavaScript type rather than with nothing.
  // `binary` and `varbinary` are strings on both majors and DRZL calls them Uint8Array, which
  // shows up as DRZL refusing everything official takes and taking things official refuses.
  //
  // `MySqlDecimal` used to sit here as the second of two. It was fixed rather than waived: the
  // analyzer now types each decimal mode as what the driver hands back, measured against a live
  // MySQL 8.4. Its entry went with it, because a ledger entry that suppresses nothing fails this
  // stage by design.
  // The two official majors do not agree about this column, so `official: a string` is only half
  // the picture and a reader needs the rest before acting on it. Measured on the column object and
  // ---- an integer range is missing or wrong on 0.4x ------------------------------------------
  // `sqlite/s_int` is three libraries rather than four, and the missing one is not an omission:
  // zod's `.int()` refuses a number outside the safe-integer range on its own, so zod reaches
  // official's answer for 9007199254740993 without the bound DRZL failed to emit. The other three
  // have no such rule and take it.
  'mysql/m_serial': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    divergence: {
      '*/zod': `L: -1 | T: `,
      '*/valibot,arktype,typebox': `L: -1, 9007199254740993, 3.4028235e38 | T: `,
    },
    drzl: 'an unbounded integer, so it takes -1 for an auto-increment column',
    official: 'an integer within 0..9007199254740991',
    filed: 'new',
  },
  'mysql/m_year': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    divergence: {
      '*/zod': `L: 0, 1, -1, 200, 40000, 9000000, 2147483648, 1900, 2500, 17, 18, 50, 100, 101 | T: `,
      '*/valibot,arktype,typebox': `L: 0, 1, -1, 200, 40000, 9000000, 2147483648, 9007199254740993, 3.4028235e38, 1900, 2500, 17, 18, 50, 100, 101 | T: `,
    },
    drzl: 'an unbounded integer',
    official: 'an integer within 1901..2155',
    filed: 'new',
  },
  'sqlite/s_int': {
    libs: ['valibot', 'arktype', 'typebox'],
    modes: MODE_NAMES,
    divergence: { '*/*': `L: 9007199254740993 | T: ` },
    drzl: 'an integer within the signed 64-bit range',
    official: 'an integer within the safe-integer range',
    filed: 'new',
  },
  'sqlite/s_blob_bigint': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    divergence: { '*/*': `L: 2n**70n | T: ` },
    drzl: 'an unbounded bigint',
    official: 'a bigint within the signed 64-bit range',
    filed: 'new',
  },

  // ---- the nullable table, where the same 0.4x defects show up again -------------------------
  // Each of these is its `matrix` twin's defect measured through a nullable wrapper, which is what
  // says the defect is in the analysis of the column rather than in one emitted shape.
  // The other two Postgres classes the class-name path cannot name. All five classes that produce
  // this shape are in the fixture now, three here and two on SQLite below.
  // `pg/n_geometry` and `pg/n_bit` were here, the nullable twins of the two above, and went
  // the same way for the same reason: the classes are named, so a nullable one is no longer an
  // unknown wrapped in a union.
  'sqlite/s_n_blob': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    divergence: {
      'select/*': allProbes(61, ['null', 'Buffer']),
      'insert,update/zod,valibot,arktype': allProbes(60, ['null', 'undefined', 'Buffer']),
      'insert,update/typebox': allProbes(61, ['null', 'Buffer']),
    },
    drzl: 'unknown, which accepts every value in the pool',
    official: 'a Buffer, or null',
    filed: 'as sqlite/s_blob_buf: no SQLiteBlobBuffer arm in the class-name path',
  },
  'sqlite/s_n_ts_ms': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    divergence: {
      'select/*': allProbes(61, ['null', 'Date']),
      'insert,update/zod,valibot,arktype': allProbes(60, ['null', 'undefined', 'Date']),
      'insert,update/typebox': allProbes(61, ['null', 'Date']),
    },
    drzl: 'unknown, which accepts every value in the pool',
    official: 'a Date, or null',
    filed: 'as sqlite/s_int_ts_ms: integer({ mode: timestamp_ms }) has no arm on 0.4x',
  },
  'sqlite/s_n_int': {
    libs: ['valibot', 'arktype', 'typebox'],
    modes: MODE_NAMES,
    divergence: { '*/*': `L: 9007199254740993 | T: ` },
    drzl: 'as sqlite/s_int',
    official: 'as sqlite/s_int',
    filed: 'as sqlite/s_int',
  },
  // The same column type with a default on it, which is why it carries the same defect. Its
  // divergence is exactly `sqlite/s_n_int`'s and not the default's: `applyDefaults` is off in this
  // config, so neither side fills anything in.
  'sqlite/s_n_default': {
    libs: ['valibot', 'arktype', 'typebox'],
    modes: MODE_NAMES,
    divergence: { '*/*': `L: 9007199254740993 | T: ` },
    drzl: 'as sqlite/s_int',
    official: 'as sqlite/s_int',
    filed: 'as sqlite/s_int',
  },
  'sqlite/s_n_bigint': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    divergence: { '*/*': `L: 2n**70n | T: ` },
    drzl: 'as sqlite/s_blob_bigint',
    official: 'as sqlite/s_blob_bigint',
    filed: 'as sqlite/s_blob_bigint',
  },
};

/**
 * Where DRZL and the official 0.4x module disagree about whether a key may be missing.
 *
 * A ledger of its own, because it answers a question of its own: the maps above are about what a
 * schema does with a value, and this is about whether the object needs the key at all. Same shape
 * and same both-directions assertion, with the signature `official <required|optional>, DRZL <the
 * same two>` per pairing.
 *
 * Both entries are the same defect wearing a different coat. On 0.4x the analyzer cannot name these
 * columns, so DRZL emits an unknown for them, and on TypeBox a *nullable* unknown is
 * `Type.Union([Type.Unknown(), Type.Null()])`, which lets the key be missing. Three measurements on
 * TypeBox itself, not on anything DRZL emits:
 *
 *   Type.Object({ k: Type.Unknown(), other })          the key omitted   rejected
 *   Type.Object({ k: Union([Unknown, Null]), other })  the key omitted   accepted
 *   the same object with the key present                                 accepted
 *
 * So it is the nullable form and not the unknown that opens it, and that is why no column of
 * `matrix` is here. The ones unnamed on this major are `c_geometry`, `c_bit`, `c_vector`,
 * `s_blob`, `s_blob_buf` and `s_int_ts_ms`. They are `notNull`,
 * so they emit a bare `Type.Unknown()` and their keys stay required, which this run measures: an
 * entry for any of them would fail as dead. The three Postgres ones are read on update alone,
 * because `PRESENCE_BARREN` below makes select and insert unreadable on that pairing, and update is
 * where both sides make every key optional anyway.
 *
 * A row that never mentions the column validates against the entries that are here, and the
 * field-level comparison cannot see it, because TypeBox keeps requiredness on the parent.
 *
 * Only TypeBox. zod, valibot and arktype all keep the key required for their nullable unknown, and
 * this run measures that rather than assuming it: an entry naming another library fails, and a
 * library that starts doing it and is not named fails too.
 */
/**
 * Where the presence axis cannot read a side at all, because that side's schema for the column
 * accepts nothing in the pool and so no object satisfying it exists.
 *
 * The same one column as the v1 pass, for the same reason `ALLOWED[pg/c_uuid]` above records:
 * official emits `Type.String({ format: 'uuid' })` and TypeBox fails a format it has no entry for,
 * so that field refuses every value. On select and insert the column is required, so no object
 * satisfying official's Postgres TypeBox schema exists and no key of it can be asked about; on
 * update it is optional and only that column is lost. Asserted in both directions.
 */
const PRESENCE_BARREN: Record<string, string> = {
  'pg/typebox/c_uuid': "official's Type.String({ format: 'uuid' }) refuses every value with no FormatRegistry",
};

/**
 * The absolute half of the presence axis: on `select`, DRZL's own schema has to require every key.
 *
 * `PRESENCE` below is differential and can only see DRZL and official disagreeing. This fires where
 * they agree about something wrong, and it fires where official cannot answer at all: `pg/n_bit` is
 * in this list and not in `PRESENCE`, because official's TypeBox schema throws on the object with
 * that key omitted rather than reporting it missing, so there is no verdict to differ from.
 *
 * A select row always carries every column, so an optional key there is wrong however many
 * libraries agree about it. Keyed `<dialect>/<library>/<column>` and asserted in both directions.
 *
 * Five column classes reach it on this major and all five are here: `PgVector`, `PgGeometry`,
 * `PgBinaryVector`, `SQLiteBlobBuffer` and `integer({ mode: 'timestamp_ms' })`, each of them a
 * column the class-name path cannot name, plus the customType, which is unnamed on both majors.
 * Only TypeBox: zod, valibot and arktype keep the key required for their own nullable unknown.
 */
/**
 * How far the check below actually reached, declared and asserted in both directions, for the
 * reason the v1 copy carries: an absolute check has no second side, so a shrinking reach prints the
 * same line and finds nothing. Measured on the v1 pass by making a select schema barren at a column
 * already declared in `PRESENCE_BARREN`, which dropped 40 keys and hid a real optional one.
 */
const SELECT_REACH = { schemas: 24, keys: 492 };

const SELECT_OPTIONAL: Record<string, string> = {
  // The three Postgres entries that stood here are gone, and nobody edited them out: naming
  // `vector`, `geometry` and `bit` means those columns no longer emit an unknown, so their nullable
  // form is no longer the union whose TypeBox key may go missing, and this check retired each one
  // by name as its arm landed. Only SQLite is left, where two classes are still unnamed.
  'sqlite/typebox/s_n_blob': 'no SQLiteBlobBuffer arm, so a nullable unknown whose TypeBox key may be missing',
  'sqlite/typebox/s_n_ts_ms': 'as sqlite/typebox/s_n_blob, with no timestamp_ms arm',
  'sqlite/typebox/s_n_custom': 'a nullable customType is unknown on both majors, and official emits the same union',
};

const PRESENCE: Record<string, Entry> = {
  // `pg/n_geometry` sat here for the same reason and left with the rest of them.
  'sqlite/s_n_blob': {
    libs: ['typebox'],
    modes: ['select'],
    divergence: { '*/*': 'official required, DRZL optional' },
    drzl: 'as pg/n_vector',
    official: 'as pg/n_vector',
    filed: 'as sqlite/s_blob_buf: no SQLiteBlobBuffer arm in the class-name path',
  },
  'sqlite/s_n_ts_ms': {
    libs: ['typebox'],
    modes: ['select'],
    divergence: { '*/*': 'official required, DRZL optional' },
    drzl: 'as pg/n_vector',
    official: 'as pg/n_vector',
    filed: 'as sqlite/s_int_ts_ms: integer({ mode: timestamp_ms }) has no arm on 0.4x',
  },
  // No `pg/n_bit` entry, and its absence is the reason SELECT_OPTIONAL exists next to this map:
  // official's TypeBox schema throws on the object with that key omitted rather than reporting it
  // missing, so this differential comparison has no verdict to differ from. `s_n_custom` is absent
  // for the opposite reason: official emits the same union DRZL does, so the two agree.
};

// A field lookup that throws yields nothing, and nothing is not read as agreement anywhere below:
// every branch that reaches an absent field pushes a finding row. Measured on this run, it throws
// zero times, so the catch is a guard rather than a path anything travels. Verdicts go through
// `probe` in pool.ts, which does not treat a crash as a rejection.
const safeField = (lib: Lib, s: any, k: string) => {
  try {
    return lib.field(s, k);
  } catch {
    return undefined;
  }
};

/**
 * Probes where one side crashes instead of answering. Declared exactly and asserted in both
 * directions, keyed `<dialect>/<library>/<column>`.
 *
 * A crash is not a verdict, so the value it happened on is not compared for that column. It is
 * recorded here instead, which is what stops a swallowed exception from being scored as the other
 * side's answer.
 *
 * Not comparing it is not the same as not measuring it, and for a while it was: the value was
 * dropped and nothing looked at DRZL's answer, which made a crashing official module a licence for
 * DRZL to do anything on that value. So two more fields, both asserted:
 *
 *   `drzl`     what DRZL answers on the crashed value, keyed `<mode-or-*>/<value>`. Every crashed
 *              probe has to be claimed by exactly one declaration and match it, and every
 *              declaration has to claim at least one probe.
 *   `arbiter`  what settles that DRZL's answer is the right one, keyed by value, computed by the
 *              run rather than believed. A real Postgres through PGlite wherever one runs for that
 *              dialect; and where none does, the reason, also computed.
 *
 * On this major `c_bit` is one of the columns the analyzer cannot name, so DRZL takes every
 * value including a NULL for a NOT NULL column, and takes the column being left out of the insert
 * as well. That is the filed defect DEFECTS[pg/c_bit] carries, and the arbitration prints a line
 * per probe saying so: the database refuses it, DRZL accepts it, and the map naming the column is
 * what keeps that from being a hard failure here too. Until this round it did not print anything.
 * The claim that it "says so out loud rather than passing over it" stood over a branch guarded by
 * `!DEFECTS[...]`, so the entry that made the sentence worth writing was also what stopped it from
 * ever running, and the run printed a count and nothing else.
 */
type Crash = {
  side: string;
  modes: string[];
  values: string[];
  why: string;
  /** What DRZL answers where official crashed, keyed `<mode-or-*>/<value>`. */
  drzl: Record<string, string>;
  /** What settles that answer, keyed by value. Computed by the run and compared with this. */
  arbiter: Record<string, string>;
  /**
   * The modes in which the same side crashes on the *object* with this key omitted, rather than
   * reporting the key missing. Same upstream cause as the value crashes above: the length check
   * reads `value.length` of the absent property. Asserted in both directions.
   */
  absentModes: string[];
};
const THREW: Record<string, Crash> = {
  // Official emits `{ type: 'RegExp', source: '^[01]+$', maxLength: 3 }`, and TypeBox's length
  // check reads `value.length` with no type guard, so `null` and `undefined` crash it rather than
  // failing it. `drizzle-orm/typebox-legacy` on 1.0.0-rc.4 does the same, so this is an upstream
  // defect on both majors rather than a difference between them.
  //
  // One site here and three in the v1 pass, and the difference is upstream rather than arbitrary:
  // the crashing columns are exactly the columns official emits as `type: 'RegExp'`, enumerated on
  // both majors, and this module emits a bare string for `m_binary` and `m_varbinary` where the v1
  // one emits a capped pattern. Nothing DRZL emits crashes on any probe, on either major.
  'pg/typebox/c_bit': {
    side: 'official',
    modes: ['select', 'insert', 'update'],
    values: ['null', 'undefined'],
    why: 'official Type.RegExp with maxLength reads .length of a null value',
    // Every probe, because the analyzer names no type for this column on 0.4x. The other three
    // libraries report the same thing through the ALL_PROBES signature in DEFECTS[pg/c_bit]; this
    // is the fourth, which the comparison cannot reach.
    drzl: { '*/null': 'reject', '*/undefined': 'reject' },
    arbiter: {
      // A real Postgres, built from this column's own `getSQLType()`, refuses a NULL into
      // `bit(3) not null` with a not-null violation, and its nullable twin takes one.
      null: 'postgres refuses it (SQLSTATE 23502)',
      // An absence is handed to a database by leaving the column out of the insert. What stood
      // here said no database could be handed one, on the evidence that a bound `undefined` comes
      // back 23502; that measures the driver's parameter binding and was written up as a fact
      // about databases. `pool.ts` asks it as an omission instead, and the twin carrying a default
      // is what keeps that from being the NULL answer under another name.
      undefined: 'postgres refuses the column omitted from the insert (SQLSTATE 23502)',
    },
    // No omission reaches this column: `c_uuid` on the same object accepts nothing on this major
    // either, so official's Postgres TypeBox schema has no satisfiable object. See PRESENCE_BARREN.
    absentModes: [],
  },
  // The nullable twin, and the same upstream defect. Two things differ and both follow from the
  // column being nullable: DRZL's answer is `accept` because the analyzer cannot name the column on
  // this major and an unknown takes everything, and Postgres agrees with that answer here rather
  // than refusing it, because the subject table this run builds carries the column's own
  // nullability. `absentModes` is select alone: insert and update make the key optional, so TypeBox
  // skips the property instead of reaching the length check.
  'pg/typebox/n_bit': {
    side: 'official',
    modes: ['select', 'insert', 'update'],
    values: ['null', 'undefined'],
    why: 'as pg/typebox/c_bit',
    drzl: { '*/null': 'accept', '*/undefined': 'reject' },
    arbiter: {
      null: 'postgres accepts it',
      undefined: 'postgres accepts the column omitted from the insert',
    },
    absentModes: ['select'],
  },
};

/**
 * Columns the analyzer cannot name at all on 0.4x, in the two fixtures nothing else checks.
 *
 * The comparison above is differential and can only see DRZL and official disagreeing. This is
 * absolute, and it is what still fires when they agree about something wrong. `m_enum` used to be
 * the worked example: DRZL called it `unknown` while every generator recovered its members from
 * `enumValues`, so the emitted schema was right, the description was not, and nothing differential
 * could see it. It is named now and its entries are gone.
 * `check-old.ts` in the stage above does the same job for the Postgres and
 * MySQL-text fixtures; it cannot cover these two, because it runs before this stage writes them.
 * One home per fixture, so a fix has exactly one entry to remove.
 *
 * Asserted both ways: an unnamed column that is not here fails, and an entry here whose column is
 * named now fails too.
 */
const UNNAMED: Record<string, string> = {
  // No SQLiteBlobBuffer arm in the class-name path, and a bare `blob()` really is a buffer column
  // on 0.45.2. Both also carry a DEFECTS entry above, which is the relative half of the finding.
  'sqlite/matrix.s_blob': 'no SQLiteBlobBuffer arm in the class-name path',
  'sqlite/matrix.s_blob_buf': 'as sqlite/matrix.s_blob',
  'sqlite/matrix.s_int_ts_ms': 'integer({ mode: timestamp_ms }) has no arm; only mode timestamp does',
  // The one the comparison cannot see, and the reason this absolute check earns its place. The
  // analyzer names no type for a 0.4x mysqlEnum and prints "so its validator will accept any
  // value", and that sentence is false: every generator reads `enumValues` off the column
  // regardless of `tsType`, and the 0.4x zod output for this column is `z.enum(['a','b','c'])`.
  // So the emitted validator is right, the comparison above reports parity, and nothing but this
  // line records that the analyzer still cannot describe the column. Filed as addendum Z.
  // The nullable table's share of the same two gaps. Both are the same class as their `matrix`
  // twin, so listing them is the check that the gap is about the column class rather than about
  // `notNull`, which is the only thing that differs between the two.
  'sqlite/nullable.s_n_blob': 'as sqlite/matrix.s_blob_buf',
  'sqlite/nullable.s_n_ts_ms': 'as sqlite/matrix.s_int_ts_ms',
  // Unnamed on both majors rather than on this one, and correctly so: a customType's JavaScript
  // type exists at compile time and nowhere else. It is here because this list is the absolute
  // record of what the analyzer cannot name, not of what it names differently per major.
  'sqlite/nullable.s_n_custom': 'a customType has no runtime shape to read; official emits an unknown for it too',
};

// Two tables per dialect, for the reason the v1 pass has two: every column of `matrix` is
// `notNull`, so until `nullable` arrived neither pass had compared a nullable column at all.
const DIALECTS = [
  {
    name: 'pg',
    tables: [
      {
        name: 'matrix',
        table: pgTable,
        mods: {
          zod: () => import('./src/gen-0-4x/pg/zod/matrix.zod.js'),
          valibot: () => import('./src/gen-0-4x/pg/valibot/matrix.valibot.js'),
          arktype: () => import('./src/gen-0-4x/pg/arktype/matrix.arktype.js'),
          typebox: () => import('./src/gen-0-4x/pg/typebox/matrix.typebox.js'),
        } as Record<string, () => Promise<any>>,
      },
      {
        name: 'nullable',
        table: pgNullable,
        mods: {
          zod: () => import('./src/gen-0-4x/pg/zod/nullable.zod.js'),
          valibot: () => import('./src/gen-0-4x/pg/valibot/nullable.valibot.js'),
          arktype: () => import('./src/gen-0-4x/pg/arktype/nullable.arktype.js'),
          typebox: () => import('./src/gen-0-4x/pg/typebox/nullable.typebox.js'),
        } as Record<string, () => Promise<any>>,
      },
    ],
  },
  {
    name: 'mysql',
    tables: [
      {
        name: 'matrix',
        table: myTable,
        mods: {
          zod: () => import('./src/gen-0-4x/mysql/zod/matrix.zod.js'),
          valibot: () => import('./src/gen-0-4x/mysql/valibot/matrix.valibot.js'),
          arktype: () => import('./src/gen-0-4x/mysql/arktype/matrix.arktype.js'),
          typebox: () => import('./src/gen-0-4x/mysql/typebox/matrix.typebox.js'),
        } as Record<string, () => Promise<any>>,
      },
      {
        name: 'nullable',
        table: myNullable,
        mods: {
          zod: () => import('./src/gen-0-4x/mysql/zod/nullable.zod.js'),
          valibot: () => import('./src/gen-0-4x/mysql/valibot/nullable.valibot.js'),
          arktype: () => import('./src/gen-0-4x/mysql/arktype/nullable.arktype.js'),
          typebox: () => import('./src/gen-0-4x/mysql/typebox/nullable.typebox.js'),
        } as Record<string, () => Promise<any>>,
      },
    ],
  },
  {
    name: 'sqlite',
    tables: [
      {
        name: 'matrix',
        table: sqTable,
        mods: {
          zod: () => import('./src/gen-0-4x/sqlite/zod/matrix.zod.js'),
          valibot: () => import('./src/gen-0-4x/sqlite/valibot/matrix.valibot.js'),
          arktype: () => import('./src/gen-0-4x/sqlite/arktype/matrix.arktype.js'),
          typebox: () => import('./src/gen-0-4x/sqlite/typebox/matrix.typebox.js'),
        } as Record<string, () => Promise<any>>,
      },
      {
        name: 'nullable',
        table: sqNullable,
        mods: {
          zod: () => import('./src/gen-0-4x/sqlite/zod/nullable.zod.js'),
          valibot: () => import('./src/gen-0-4x/sqlite/valibot/nullable.valibot.js'),
          arktype: () => import('./src/gen-0-4x/sqlite/arktype/nullable.arktype.js'),
          typebox: () => import('./src/gen-0-4x/sqlite/typebox/nullable.typebox.js'),
        } as Record<string, () => Promise<any>>,
      },
    ],
  },
];

const PREFIX: Record<string, string> = { select: 'Select', insert: 'Insert', update: 'Update' };

/**
 * Every column of every fixture, in every library and every mode: 39 + 17 Postgres, 28 + 12 MySQL
 * and 14 + 13 SQLite columns, `matrix` and `nullable`, times four libraries, times three modes.
 *
 * The Postgres numbers are one lower than the v1 pass on both tables, and for the same reason both
 * times: 0.45.2's pg-core has no `bytea` export, so `c_bytea` and `c_bytea_null` are both deleted
 * from this fixture by the edit above.
 *
 * Written out rather than derived from the arrays above, which would make it true by construction
 * and say nothing. It is the check that this stage cannot pass by comparing nothing, and it is not
 * a hypothetical failure: the cross-major stage this one sits beside spent a day comparing 0.45.2
 * against 0.45.2 and was green throughout. A fixture that grows a column fails here and has to be
 * re-measured, which is the intended cost.
 */
const EXPECTED_COMPARISONS = (39 + 17 + 28 + 12 + 14 + 13) * 4 * 3;

// Read off disk rather than through `require.resolve`, whose `exports` map has no `./package.json`
// entry for drizzle-orm. Reading it is also the point: this reports the version of the tree the
// run happened in rather than the version somebody believes was installed.
const version = (pkg: string): string => {
  const v = JSON.parse(readFileSync(`node_modules/${pkg}/package.json`, 'utf8')).version;
  if (typeof v !== 'string' || !v) {
    console.error(`    FAIL: ${pkg} reports no version, so this stage cannot say what it measured.`);
    process.exit(1);
  }
  return v;
};

// `npm init -y` leaves this project CommonJS, where tsx refuses a top-level await.
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

async function main() {
  const drizzle = version('drizzle-orm');
  if (drizzle.split('.')[0] !== '0') {
    console.error(`    FAIL: this tree resolves drizzle-orm ${drizzle}, which is not the 0.4x line.`);
    console.error('          This stage exists because the parity pass near the top of this file');
    console.error('          measures v1 alone. Run against v1 it would measure it twice and pass.');
    process.exit(1);
  }
  const officials = LIB_NAMES.map((lib) => {
    const pkg = `drizzle-${lib}`;
    const v = version(pkg);
    // The 1.0.0 line of each of these targets drizzle-orm v1. Installed here it would either fail
    // to import or compare against the wrong major's rules, and either way the pin above moved
    // without anyone deciding to.
    if (v.split('.')[0] !== '0') {
      console.error(`    FAIL: ${pkg}@${v} is the v1 line, not the companion for drizzle-orm 0.4x.`);
      process.exit(1);
    }
    return `${pkg} ${v}`;
  });
  console.log(`    drizzle-orm ${drizzle} against ${officials.join(', ')}`);

  type Seen = {
    libs: Set<string>;
    modes: Set<string>;
    signatures: Map<string, string>;
    pairings: number;
    detail: string[];
  };
  const observed = new Map<string, Seen>();
  // `at` is every `<mode>/<value>` that actually crashed, so the printed figure is a count of
  // crashes rather than `modes.size * values.size`, which is the same number only while the
  // pattern is a rectangle. It is one today, and the assertion is on the sets either way.
  const crashed = new Map<string, { sides: Set<string>; modes: Set<string>; values: Set<string>; at: Set<string> }>();
  // DRZL's own verdict on a value official crashed on, keyed by crash site then `<mode>/<value>`.
  // The comparison cannot use it, which is not the same thing as nobody looking at it.
  const crashVerdict = new Map<string, Map<string, string>>();
  const recordCrashVerdict = (key: string, mode: string, label: string, verdict: Verdict) => {
    const seen = crashVerdict.get(key) ?? new Map<string, string>();
    seen.set(`${mode}/${label}`, verdict);
    crashVerdict.set(key, seen);
  };
  const recordCrash = (key: string, side: string, mode: string, value: string) => {
    const seen =
      crashed.get(key) ??
      { sides: new Set<string>(), modes: new Set<string>(), values: new Set<string>(), at: new Set<string>() };
    seen.sides.add(side);
    seen.modes.add(mode);
    seen.values.add(value);
    seen.at.add(`${side}/${mode}/${value}`);
    crashed.set(key, seen);
  };
  const findings: string[] = [];
  let totalCompared = 0;
  let pairings = 0;
  // The presence axis, counted apart from the value axis for the reason the v1 pass counts it
  // apart: one can go quiet while the other keeps reporting, and this is the one that was at zero.
  let presenceCompared = 0;
  let presenceCrashed = 0;
  let presenceUnreadable = 0;
  const usedBarren = new Set<string>();
  const usedSelectOptional = new Set<string>();
  const selectOptionalProblems: string[] = [];
  const selectSchemas = new Set<string>();
  let selectKeysInspected = 0;
  const presenceProblems: string[] = [];
  const presenceObserved = new Map<string, Seen>();
  const presenceThrew = new Map<string, { sides: Set<string>; modes: Set<string> }>();
  const recordPresenceCrash = (key: string, side: string, mode: string) => {
    const seen = presenceThrew.get(key) ?? { sides: new Set<string>(), modes: new Set<string>() };
    seen.sides.add(side);
    seen.modes.add(mode);
    presenceThrew.set(key, seen);
  };

  for (const d of DIALECTS) {
    for (const t of d.tables) {
    const loaded: Record<string, any> = {};
    for (const lib of LIB_NAMES) loaded[lib] = await t.mods[lib]();

    for (const mode of MODE_NAMES) {
      // Column names come from the official zod schema regardless of library: every module emits
      // the same set, and zod is the one whose shape is trivially enumerable. Built once per mode
      // rather than once per library, which was four builds of the same object.
      const oShape = OFFICIAL.zod[mode](t.table as never).shape;
      for (const libName of LIB_NAMES) {
        pairings++;
        const lib = LIBS[libName];
        const official = OFFICIAL[libName][mode](t.table as never);
        const mine = loaded[libName][`${PREFIX[mode]}${t.name}Schema`];
        if (!mine) {
          findings.push(`${d.name}/${libName}/${mode}: no ${PREFIX[mode]}${t.name}Schema exported`);
          continue;
        }
        const rows: string[] = [];
        let compared = 0;
        let ledgered = 0;

        for (const k of Object.keys(oShape)) {
          const o = safeField(lib, official, k);
          const m = safeField(lib, mine, k);
          if (!o && !m) {
            // Never a skip. Both sides absent means this column was measured by nothing, and
            // `safeField` returns undefined for a lookup that threw as well as for one that was
            // missing, so the quiet version of this branch reports parity on an exception.
            rows.push(`${k}: neither official nor DRZL yielded a field, so nothing was compared`);
            continue;
          }
          if (!m) { rows.push(`${k}: official has it, DRZL omits it`); continue; }
          if (!o) { rows.push(`${k}: DRZL has it, official omits it`); continue; }
          compared++;
          const looser: string[] = [];
          const tighter: string[] = [];
          // What official accepted, in pool order. Only read when DRZL accepted everything, where
          // it is the complement of the divergence and so names it exactly.
          const officialAccepted: string[] = [];
          let officialTook = false;
          let drzlTook = false;
          // Whether DRZL took the whole pool, which is what the derived signature rests on.
          let drzlAll = true;
          for (const [label, x] of POOL) {
            const a: Verdict = probe(lib, o, x);
            const b: Verdict = probe(lib, m, x);
            // A crash is not a verdict, so this value is not compared for this column. It goes to
            // the THREW list instead, which is asserted from both ends, so it can neither be
            // scored as the other side's answer nor vanish.
            if (a === 'threw' || b === 'threw') {
              if (a === 'threw') recordCrash(`${d.name}/${libName}/${k}`, 'official', mode, label);
              if (b === 'threw') recordCrash(`${d.name}/${libName}/${k}`, 'drzl', mode, label);
              // Not compared, and not unmeasured either: DRZL's answer is pinned against the crash
              // entry and arbitrated against a real database wherever one runs for this dialect.
              // Dropping it here and doing nothing else is what let a null-accepting insert schema
              // on a NOT NULL column sit under a green line on the other pass.
              recordCrashVerdict(`${d.name}/${libName}/${k}`, mode, label, b);
              continue;
            }
            if (a === 'accept') officialAccepted.push(label);
            officialTook ||= a === 'accept';
            drzlTook ||= b === 'accept';
            if (b !== 'accept') drzlAll = false;
            if (a !== b) (b === 'accept' ? looser : tighter).push(label);
          }
          // A column both sides reject every probe for agrees perfectly and proves nothing: the
          // two schemas could be a correct one and a broken one and this loop could not tell them
          // apart. Deliberately outside the ledger below, which says a difference is expected, not
          // that a column need not be measured.
          if (!officialTook && !drzlTook) {
            rows.push(
              `${k}: neither side accepts any pool value, so this column proves nothing.` +
                ' Add a value this column accepts to POOL.'
            );
            continue;
          }
          if (!looser.length && !tighter.length) continue;

          const key = `${d.name}/${k}`;
          const seen: Seen =
            observed.get(key) ??
            { libs: new Set(), modes: new Set(), signatures: new Map(), pairings: 0, detail: [] };
          seen.libs.add(libName);
          seen.modes.add(mode);
          seen.pairings++;
          seen.signatures.set(
            `${mode}/${libName}`,
            drzlAll
              ? allProbes(looser.length, officialAccepted)
              : `L: ${looser.join(', ')} | T: ${tighter.join(', ')}`
          );
          seen.detail.push(`${mode}/${libName} ${looser.length} looser ${tighter.length} tighter`);
          observed.set(key, seen);
          if (ALLOWED[key] || DEFECTS[key]) { ledgered++; continue; }
          rows.push(
            `${k}:` +
              (looser.length ? `\n          DRZL accepts, official rejects: ${looser.join(', ')}` : '') +
              (tighter.length ? `\n          DRZL rejects, official accepts: ${tighter.join(', ')}` : '')
          );
        }

        /**
         * The other axis: whether each side lets the key be missing.
         *
         * Kept apart from the pool loop above rather than folded in as one more probe, because an
         * absence is not a value and every signature in both ledgers is a list of values. Folding
         * it in would also move the `every probe official rejects` shorthand on every column
         * that carries it, which is a statement about what the two schemas do with the pool.
         */
        const oPres = askPresence(lib, official, Object.keys(oShape));
        const mPres = askPresence(lib, mine, Object.keys(oShape));
        const readSide = (r: typeof oPres, side: string) => {
          for (const k of r.barren) {
            const key = `${d.name}/${libName}/${k}`;
            if (PRESENCE_BARREN[key]) { usedBarren.add(key); continue; }
            presenceProblems.push(
              `${d.name}/${t.name}/${mode}/${libName} ${side} accepts no pool value for ${k}, so ` +
                'no object satisfying it can be built, and nothing declares that'
            );
          }
          if (r.control && !r.barren.length) {
            presenceProblems.push(`${d.name}/${t.name}/${mode}/${libName} ${side} ${r.control}`);
          }
        };
        readSide(oPres, 'official');
        readSide(mPres, 'DRZL');
        for (const k of oPres.crashed) recordPresenceCrash(`${d.name}/${libName}/${k}`, 'official', mode);
        for (const k of mPres.crashed) recordPresenceCrash(`${d.name}/${libName}/${k}`, 'drzl', mode);
        for (const k of Object.keys(oShape)) {
          const a = oPres.verdicts.get(k);
          const b = mPres.verdicts.get(k);
          // The absolute half, read off DRZL's side alone and before the two are compared. See the
          // note on SELECT_OPTIONAL: `pg/typebox/n_bit` reaches this line and reaches nothing else,
          // because official crashes on that omission rather than answering it.
          if (mode === 'select' && b) {
            // Counted where the check reads, so the two can never describe different sets.
            selectSchemas.add(`${d.name}/${t.name}/${libName}`);
            selectKeysInspected++;
            if (b === 'optional') {
              const abs = `${d.name}/${libName}/${k}`;
              if (SELECT_OPTIONAL[abs]) usedSelectOptional.add(abs);
              else selectOptionalProblems.push(`${abs}: DRZL's select schema lets this key be missing, and nothing declares it`);
            }
          }
          // Never a skip, and never silently: every column lands in exactly one of the three
          // counters, and the three have to add up to the pairing count further down.
          if (!a || !b) {
            if (oPres.crashed.includes(k) || mPres.crashed.includes(k)) presenceCrashed++;
            else presenceUnreadable++;
            continue;
          }
          presenceCompared++;
          if (a === b) continue;
          const key = `${d.name}/${k}`;
          const seen: Seen =
            presenceObserved.get(key) ??
            { libs: new Set(), modes: new Set(), signatures: new Map(), pairings: 0, detail: [] };
          seen.libs.add(libName);
          seen.modes.add(mode);
          seen.pairings++;
          seen.signatures.set(`${mode}/${libName}`, `official ${a}, DRZL ${b}`);
          seen.detail.push(`${mode}/${libName} official ${a} DRZL ${b}`);
          presenceObserved.set(key, seen);
          if (PRESENCE[key]) { ledgered++; continue; }
          rows.push(`${k}: the key is ${a} for official and ${b} for DRZL`);
        }

        // A run that compared no column at all would otherwise print `parity` and pass.
        if (compared === 0) {
          rows.push('no column was compared on both sides, so this pairing measured nothing');
        }
        totalCompared += compared;
        console.log(
          `    ${d.name.padEnd(7)} ${t.name.padEnd(8)} ${libName.padEnd(8)} ${mode.padEnd(7)} ` +
            `${compared}/${Object.keys(oShape).length} cols compared  ` +
            `${rows.length ? 'DIFFERS' : 'parity'}${ledgered ? ` (${ledgered} in the ledger)` : ''}`
        );
        if (rows.length) {
          for (const r of rows) console.log(`        ${r}`);
          findings.push(...rows.map((r) => `${d.name}/${libName}/${mode} ${r}`));
        }
      }
    }
    }
  }

  const filedAlready = Object.values(DEFECTS).filter((e) => e.filed.startsWith('AC:')).length;
  // As in the v1 pass: which side each waiver runs on, counted rather than asserted.
  const looserWaivers = Object.values(ALLOWED).filter((e) =>
    Object.values(e.divergence).some((s) => s.split('|')[0].replace(/^L:/, '').trim() !== '')
  ).length;
  console.log(`    ${totalCompared} column comparisons across ${pairings} pairings`);
  console.log(
    `    ${selectKeysInspected} select key(s) across ${selectSchemas.size} schema(s) required, bar ` +
      `${Object.keys(SELECT_OPTIONAL).length} declared to let the key go missing: ` +
      Object.keys(SELECT_OPTIONAL).join(', ')
  );
  console.log(
    `    ${presenceCompared} key-presence comparisons asked of the object rather than the field, ` +
      `${presenceCrashed} where a side crashed on the omission and ${presenceUnreadable} with no ` +
      `object to ask about (${Object.keys(PRESENCE_BARREN).join(', ')}); ` +
      `${Object.keys(PRESENCE).length} column(s) where the two disagree`
  );
  // Which columns use the rejection-count shorthand, and how many probes each of them stands for,
  // both read off the declarations. Sentences in the docstring block above used to write those
  // numbers down, and adding five pool values made every one of them wrong at once.
  const SHORTHAND = /^every probe official rejects \((\d+) of them\), and official accepts only: (.*)$/;
  const shorthand = [...Object.entries(ALLOWED), ...Object.entries(DEFECTS)].flatMap(([k, e]) =>
    Object.values(e.divergence)
      .map((d) => SHORTHAND.exec(d))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({
        key: k,
        rejected: Number(m[1]),
        accepted: m[2] === 'nothing in the pool' ? 0 : m[2].split(', ').length,
      }))
  );
  const shorthandCols = [...new Set(shorthand.map((x) => x.key))];
  console.log(
    `    ${Object.keys(ALLOWED).length} documented divergence(s), ${looserWaivers} of them with ` +
      `DRZL accepting something official refuses; ` +
      `${Object.keys(DEFECTS).length} known-defect column(s), ${filedAlready} already filed and ` +
      `${Object.keys(DEFECTS).length - filedAlready} first seen by this stage`
  );
  if (shorthand.length) {
    const span = (ns: number[]) => (Math.min(...ns) === Math.max(...ns) ? `${ns[0]}` : `${Math.min(...ns)} to ${Math.max(...ns)}`);
    console.log(
      `    ${shorthandCols.length} column(s) state their divergence as a rejection count and a ` +
        `complement: ${span(shorthand.map((x) => x.rejected))} rejections against ` +
        `${span(shorthand.map((x) => x.accepted))} label(s) named, which is why the shorthand exists`
    );
  }
  for (const [k, e] of Object.entries(DEFECTS)) {
    console.log(`      ${k}: DRZL emits ${e.drzl}, official emits ${e.official} [${e.filed}]`);
  }
  console.log(
    '    the json-schema generator is not in this comparison: there is no official 0.4x JSON' +
      ' Schema module to compare it against'
  );

  // Both directions. An entry that suppressed nothing describes something nobody can observe, and
  // an entry whose libraries or modes have moved is describing a different defect from the one
  // that is there now.
  const ledgerProblems: string[] = [];
  for (const [map, name, from] of [
    [ALLOWED, 'ALLOWED', observed],
    [DEFECTS, 'DEFECTS', observed],
    // Held to the identical rule, in the identical loop. Two ledgers side by side under different
    // rules is the state this stage was in for a round, and the weaker one absorbed a regression.
    [PRESENCE, 'PRESENCE', presenceObserved],
  ] as const) {
    for (const [key, entry] of Object.entries(map)) {
      const seen = from.get(key);
      if (!seen) {
        ledgerProblems.push(`${name}[${key}] suppressed nothing on this run`);
        continue;
      }
      const gotLibs = [...seen.libs].sort().join(',');
      const gotModes = [...seen.modes].sort().join(',');
      const wantLibs = [...entry.libs].sort().join(',');
      const wantModes = [...entry.modes].sort().join(',');
      if (gotLibs !== wantLibs) {
        ledgerProblems.push(`${name}[${key}] declares libs ${wantLibs}, measured ${gotLibs}`);
      }
      if (gotModes !== wantModes) {
        ledgerProblems.push(`${name}[${key}] declares modes ${wantModes}, measured ${gotModes}`);
      }
      const wantPairings = entry.libs.length * entry.modes.length - (entry.except?.length ?? 0);
      if (seen.pairings !== wantPairings) {
        ledgerProblems.push(
          `${name}[${key}] declares ${wantPairings} pairings, measured ${seen.pairings}: ` +
            seen.detail.join('; ')
        );
      }
      // The exact divergence, both ways. Every pairing has to be claimed by exactly one
      // declaration, and its signature has to match; every declaration has to claim at least one.
      const claimed = new Set<string>();
      for (const [pairing, sig] of seen.signatures) {
        const hits = Object.keys(entry.divergence).filter((d) => pairingMatches(d, pairing));
        if (hits.length !== 1) {
          ledgerProblems.push(
            `${name}[${key}] has ${hits.length} declarations for ${pairing}, needs exactly one. ` +
              `Measured there: ${sig}`
          );
          continue;
        }
        claimed.add(hits[0]);
        const want = entry.divergence[hits[0]];
        if (want === sig) continue;
        // One message for both signature forms. The shorthand had a branch of its own here while
        // it read `every probe official rejects` with no count and no complement, where printing
        // it against a measured `L: ...` list said nothing; it carries both now and reads the same
        // way round as any other signature, so the special case was byte identical to this one.
        ledgerProblems.push(
          `${name}[${key}] on ${pairing} declares\n        ${want}\n      and measured\n        ${sig}`
        );
      }
      for (const d of Object.keys(entry.divergence)) {
        if (!claimed.has(d)) ledgerProblems.push(`${name}[${key}] declaration '${d}' matched no pairing`);
      }
    }
  }
  // Each entry carries its own measured detail, because the two maps it is drawn from are keyed
  // the same way and a lookup in the wrong one reads as undefined. It did: the first version built
  // bare keys and printed `observed.get(k)!.detail`, which threw on a presence-only key and turned
  // a reportable finding into a stack trace.
  const unledgered = [
    ...[...observed.entries()]
      .filter(([k]) => !ALLOWED[k] && !DEFECTS[k])
      .map(([k, seen]) => `${k}: ${seen.detail.join('; ')}`),
    ...[...presenceObserved.entries()]
      .filter(([k]) => !PRESENCE[k])
      .map(([k, seen]) => `${k} (key presence): ${seen.detail.join('; ')}`),
  ];

  // The presence axis, held to the same denominator as the value axis, and to the same THREW
  // ledger for the omissions official crashes on rather than answers.
  if (presenceCompared + presenceCrashed + presenceUnreadable !== EXPECTED_COMPARISONS) {
    presenceProblems.push(
      `${presenceCompared} key-presence comparisons plus ${presenceCrashed} crashed and ` +
        `${presenceUnreadable} unreadable, which is not the ${EXPECTED_COMPARISONS} column ` +
        'pairings the value pool is pushed through'
    );
  }
  for (const key of Object.keys(PRESENCE_BARREN)) {
    if (!usedBarren.has(key)) {
      presenceProblems.push(`PRESENCE_BARREN[${key}] names a column that accepts a pool value now, so delete it`);
    }
  }
  for (const key of Object.keys(SELECT_OPTIONAL)) {
    if (!usedSelectOptional.has(key)) {
      selectOptionalProblems.push(`SELECT_OPTIONAL[${key}] requires its key on select now, so delete it`);
    }
  }
  if (selectSchemas.size !== SELECT_REACH.schemas || selectKeysInspected !== SELECT_REACH.keys) {
    selectOptionalProblems.push(
      `the select check read ${selectSchemas.size} schema(s) and ${selectKeysInspected} key(s), ` +
        `declared ${SELECT_REACH.schemas} and ${SELECT_REACH.keys}. It has no second side to ` +
        'disagree with it, so a shrinking reach is silent unless this fails'
    );
  }
  for (const [key, seen] of presenceThrew) {
    const e = THREW[key];
    if (!e) {
      presenceProblems.push(
        `${key}: ${[...seen.sides].sort().join('/')} crashed on the object with the key omitted ` +
          `in ${[...seen.modes].sort().join(', ')}, and is in no list`
      );
      continue;
    }
    const gotSides = [...seen.sides].sort().join(',');
    if (gotSides !== e.side) {
      presenceProblems.push(`THREW[${key}] declares side ${e.side}, and the omission crashed on ${gotSides}`);
    }
    const gotModes = [...seen.modes].sort().join(',');
    const wantModes = [...e.absentModes].sort().join(',');
    if (gotModes !== wantModes) {
      presenceProblems.push(`THREW[${key}] declares absentModes ${wantModes || 'none'}, measured ${gotModes}`);
    }
  }
  for (const [key, e] of Object.entries(THREW)) {
    if (e.absentModes.length && !presenceThrew.has(key)) {
      presenceProblems.push(
        `THREW[${key}] declares absentModes ${e.absentModes.join(',')} and no omission crashed there`
      );
    }
  }

  /**
   * The MySQL text caps, bracketed rather than stepped past.
   *
   * Two probes per column, not one. One string over the cap only ever proves the cap is below it,
   * so the single probe this replaced pinned `tinytext` to the interval [36, 257] rather than to
   * 255: 36 is the largest pool string under the cap and 257 is where a probe built out of
   * three-byte characters lands. Measured rather than reasoned, by moving the emitted cap and
   * re-running: 257 and 36 both left the run byte identical to green, 258 and 35 both failed it.
   * The same construction left `text` free over [400, 65537] and `mediumtext` over about 16.7
   * million values.
   *
   * The pair brackets it. `floor(cap/3)` three-byte characters plus `cap mod 3` ASCII ones is
   * exactly `cap` bytes and roughly a third of that in UTF-16 units, so DRZL has to take it; one
   * more ASCII character is exactly `cap + 1` bytes, so DRZL has to refuse it. Both stay far under
   * any character cap, so neither is answering a question about characters, and together they pin
   * the byte cap to a single value.
   *
   * A real MySQL 8.4.11 on a utf8mb4 client agrees with both halves, which is what makes them the
   * right expectations rather than today's behaviour written down: for `tinytext`, `text` and
   * `mediumtext` alike, the at-cap string inserts and `octet_length` reads back exactly the cap,
   * while the one-byte-longer string fails with ERROR 1406 "Data too long".
   *
   * Both strings are derived from each column's own cap rather than written down, so a cap that
   * moves moves the pair with it.
   */
  // Read off the runtime rather than written down, so a V8 with a different limit is described
  // correctly instead of being asserted about.
  const MAX_JS_STRING = constants.MAX_STRING_LENGTH;
  const TEXT_CAPS: Record<string, number> = {
    m_tinytext: 255,
    m_text: 65535,
    m_mediumtext: 16777215,
    m_longtext: 4294967295,
  };

  /**
   * Where each MySQL text column's byte cap is actually measured.
   *
   * Computed by this run and compared with the declaration in both directions, because a sentence
   * about who measures what is exactly the kind that goes quietly false. Two of them already have
   * on this branch, and the second was introduced by the fix for the first. `m_longtext` is
   * measured by nothing at all, and deleting every one of its caps from all four generated modules
   * in all three modes leaves both passes byte identical to green.
   *
   * The two things that measure a cap do not measure the same amount of it, and the printed line
   * used to give each of them one word, so `the pool and the byte-cap stage` read as two
   * measurements of the cap when only one of them is. They are named apart now:
   *
   *   `separated`  the pool holds a string this column's byte cap refuses and its UTF-16 count does
   *                not, which is the only kind of string the comparison above can tell the two
   *                counts apart with. It does not pin the cap: moving `m_tinytext`'s emitted cap to
   *                254 or to 256 produces no failure from the pool at all.
   *   `bracketed`  the pair below was built and pushed through, at the cap and one byte over, which
   *                does pin the cap to a single value.
   */
  const CAP_COVERAGE: Record<string, string> = {
    m_tinytext: 'bracketed and separated',
    m_text: 'bracketed and separated',
    m_mediumtext: 'bracketed only',
    m_longtext: 'neither',
  };

  const capProblems: string[] = [];
  const capMeasured: string[] = [];
  const capUnreachable: string[] = [];
  {
    // The `matrix` table by name: `m_tinytext` and its siblings live there, and `nullable` carries
    // its own `m_n_tinytext` with its own cap.
    const mysqlMatrix = DIALECTS.find((d) => d.name === 'mysql')?.tables.find((t) => t.name === 'matrix');
    if (!mysqlMatrix) {
      capProblems.push('the MySQL matrix table is not in this stage, so no byte cap was measured');
    } else {
      const loaded: Record<string, any> = {};
      for (const lib of LIB_NAMES) loaded[lib] = await mysqlMatrix.mods[lib]();
      for (const [col, cap] of Object.entries(TEXT_CAPS)) {
        const wide = Math.floor(cap / 3);
        const rest = cap - wide * 3;
        const units = wide + rest;
        if (units + 1 > MAX_JS_STRING) {
          capUnreachable.push(`${col} (a probe needs ${units + 1} units, over this V8's ${MAX_JS_STRING})`);
          // UTF-8 spends at most 3 bytes per UTF-16 unit, checked over every code point, so no JS
          // string here can carry more than this many bytes. When that is under the cap the cap
          // cannot be exceeded at all, which is stronger than this construction being too long,
          // and it is the state `longtext` is in. Anything else means some other construction
          // reaches the column and this list is hiding it.
          if (MAX_JS_STRING * 3 >= cap) {
            capProblems.push(
              `${col} is listed as unprobeable, but a JS string here can carry ${MAX_JS_STRING * 3} ` +
                `bytes, which is over its ${cap} byte cap. Some construction reaches it and this one does not.`
            );
          }
          continue;
        }
        const atCap = '\u4E00'.repeat(wide) + 'x'.repeat(rest);
        const overCap = `${atCap}x`;
        for (const mode of MODE_NAMES) {
          for (const libName of LIB_NAMES) {
            const lib = LIBS[libName];
            const o = safeField(lib, OFFICIAL[libName][mode](mysqlMatrix.table as never), col);
            const m = safeField(lib, loaded[libName][`${PREFIX[mode]}matrixSchema`], col);
            if (!o || !m) {
              capProblems.push(`${col} has no field on ${mode}/${libName}, so no cap was measured`);
              continue;
            }
            const at = { o: probe(lib, o, atCap), m: probe(lib, m, atCap) };
            const over = { o: probe(lib, o, overCap), m: probe(lib, m, overCap) };
            capMeasured.push(`${col}/${mode}/${libName}/at`, `${col}/${mode}/${libName}/over`);
            // Today's state and the only one that is not a finding, on both halves. Official counts
            // UTF-16 units, so it takes both. DRZL counts bytes, so the cap is where MySQL puts it:
            // `cap` bytes in, `cap + 1` bytes out.
            if (at.o === 'accept' && at.m === 'accept' && over.o === 'accept' && over.m === 'reject') continue;
            capProblems.push(
              `${col} on ${mode}/${libName}: at ${cap} bytes (${units} units) official ${at.o}, ` +
                `DRZL ${at.m}; at ${cap + 1} bytes (${units + 1} units) official ${over.o}, ` +
                `DRZL ${over.m}. Expected both accepted and DRZL alone refusing the second, which ` +
                'is where MySQL 8.4.11 puts the boundary.'
            );
          }
        }
      }
    }
  }
  if (!capMeasured.length) capProblems.push('no MySQL text column had its byte cap measured');

  // The coverage claim, computed rather than asserted in a comment nobody re-runs.
  const poolSeparates = (cap: number) =>
    POOL.some(([, x]) => typeof x === 'string' && Buffer.byteLength(x, 'utf8') > cap && x.length <= cap);
  const coverageSeen: string[] = [];
  for (const [col, cap] of Object.entries(TEXT_CAPS)) {
    const byPool = poolSeparates(cap);
    const byStage = capMeasured.some((probed) => probed.startsWith(`${col}/`));
    const got = byPool && byStage
      ? 'bracketed and separated'
      : byPool
        ? 'separated only'
        : byStage
          ? 'bracketed only'
          : 'neither';
    coverageSeen.push(`${col} ${got}`);
    if (CAP_COVERAGE[col] === got) continue;
    capProblems.push(
      `${col} is declared '${CAP_COVERAGE[col] ?? 'nothing, being absent from CAP_COVERAGE'}'` +
        `, and this run measured '${got}'`
    );
  }
  for (const col of Object.keys(CAP_COVERAGE)) {
    if (col in TEXT_CAPS) continue;
    capProblems.push(`CAP_COVERAGE names ${col}, which has no cap in TEXT_CAPS, so it describes nothing`);
  }

  console.log(
    `    ${capMeasured.length} byte-cap probe(s) bracketing ${Object.keys(TEXT_CAPS).length - capUnreachable.length} ` +
      `MySQL text column(s); ${capUnreachable.length} cannot be probed at all: ${capUnreachable.join(', ')}`
  );
  console.log(
    "    byte caps: 'bracketed' is probed at the cap and one byte over, which pins DRZL's cap to" +
      " one value; 'separated' is the pool holding a string the cap refuses on bytes and takes on" +
      ' characters, which tells the two counts apart without pinning the cap'
  );
  console.log(`    ${coverageSeen.join('; ')}`);

  // The absolute half: what the analyzer makes of these two fixtures on its own.
  const unnamedProblems: string[] = [];
  const unnamedSeen = new Set<string>();
  let analyzed = 0;
  for (const [dialect, file] of [['mysql', 'src/matrix-mysql.ts'], ['sqlite', 'src/matrix-sqlite.ts']]) {
    const a = await new SchemaAnalyzer(file).analyze({});
    const failed = a.issues.filter((i) => i.code === 'DRZL_ANL_IMPORT');
    if (failed.length) {
      unnamedProblems.push(`${file} could not be imported: ${failed.map((i) => i.message).join('; ')}`);
      continue;
    }
    for (const t of a.tables) {
      for (const c of t.columns) {
        analyzed++;
        if (c.tsType !== 'unknown' && c.dbType !== 'UNKNOWN') continue;
        const key = `${dialect}/${t.name}.${c.name}`;
        if (UNNAMED[key]) { unnamedSeen.add(key); continue; }
        unnamedProblems.push(`${key} is analyzed as unknown on 0.4x and is in no list`);
      }
    }
  }
  // A run that analyzed nothing would otherwise report every entry as dead and read as a fix.
  if (!analyzed) unnamedProblems.push('no column was analyzed from the MySQL or SQLite fixture');
  for (const key of Object.keys(UNNAMED)) {
    if (!unnamedSeen.has(key)) {
      unnamedProblems.push(`UNNAMED[${key}] is named on 0.4x now, so delete it here and in DEFECTS`);
    }
  }
  console.log(
    `    ${analyzed} columns analyzed on 0.4x across the MySQL and SQLite fixtures, ` +
      `${unnamedSeen.size} unnamed and filed`
  );

  // The crashes, held to the same rule from both ends as everything else here.
  const crashProblems: string[] = [];
  for (const [key, seen] of crashed) {
    const e = THREW[key];
    if (!e) {
      crashProblems.push(
        `${key}: ${[...seen.sides].sort().join('/')} crashed on ` +
          `${[...seen.values].sort().join(', ')} in ${[...seen.modes].sort().join(', ')}, ` +
          'and is in no list'
      );
      continue;
    }
    const got: Record<string, string> = {
      side: [...seen.sides].sort().join(','),
      modes: [...seen.modes].sort().join(','),
      values: [...seen.values].sort().join(','),
    };
    const want: Record<string, string> = {
      side: e.side,
      modes: [...e.modes].sort().join(','),
      values: [...e.values].sort().join(','),
    };
    for (const f of ['side', 'modes', 'values']) {
      if (got[f] !== want[f]) crashProblems.push(`THREW[${key}] declares ${f} ${want[f]}, measured ${got[f]}`);
    }
  }
  for (const key of Object.keys(THREW)) {
    if (!crashed.has(key)) crashProblems.push(`THREW[${key}] saw no crash on this run`);
  }

  /**
   * What DRZL answered where official could not, held to the declaration in both directions.
   *
   * Without this a crashing official validator is a licence for DRZL to do anything on that value.
   * `c_bit` is `bit({ dimensions: 3 }).notNull()`, and on the v1 pass its Insert and Update schemas
   * were made to accept `null` with that pass staying byte identical to green.
   */
  const declMatches = (decl: string, mode: string, label: string) => {
    const cut = decl.indexOf('/');
    return (decl.slice(0, cut) === '*' || decl.slice(0, cut) === mode) && decl.slice(cut + 1) === label;
  };
  for (const [key, seen] of crashVerdict) {
    const e = THREW[key];
    // An undeclared crash is already a failure above; reporting the same site twice adds nothing.
    if (!e) continue;
    const want = e.modes.length * e.values.length;
    if (seen.size !== want) {
      crashProblems.push(
        `THREW[${key}] declares ${want} crashed probe(s), measured ${seen.size}: ${[...seen.keys()].sort().join(', ')}`
      );
    }
    const claimed = new Set<string>();
    for (const [at, verdict] of seen) {
      const cut = at.indexOf('/');
      const hits = Object.keys(e.drzl).filter((decl) => declMatches(decl, at.slice(0, cut), at.slice(cut + 1)));
      if (hits.length !== 1) {
        crashProblems.push(`THREW[${key}].drzl has ${hits.length} declarations for ${at}, needs exactly one. Measured there: ${verdict}`);
        continue;
      }
      claimed.add(hits[0]);
      if (e.drzl[hits[0]] === verdict) continue;
      crashProblems.push(`THREW[${key}].drzl declares ${e.drzl[hits[0]]} on ${at}, measured ${verdict}`);
    }
    for (const decl of Object.keys(e.drzl)) {
      if (!claimed.has(decl)) crashProblems.push(`THREW[${key}].drzl declaration '${decl}' matched no crashed probe`);
    }
  }

  /**
   * And what says those answers are the right ones.
   *
   * A pinned verdict stops DRZL's behaviour moving unseen; it does not say the pinned value is
   * correct, and on this major it is not: the analyzer cannot name `c_bit`, so DRZL takes a NULL
   * for a NOT NULL column, and takes that column being left out of an insert too. A real Postgres
   * is what says so. The table is built from the fixture column's own `getSQLType()`, the nullable
   * twin has to take a NULL before the NOT NULL twin's refusal counts as anything, and the twin
   * carrying a default has to take an omission while still refusing a NULL before the omission's
   * refusal is read as an answer about the omission.
   *
   * Every probe on this pass is arbitrated, so nothing here rests on a reason for not arbitrating.
   * The one this pass can still produce, a dialect with no engine in this process, is checked
   * against the engine's own `select version()` rather than against the branch that writes it.
   */
  const arbiterProblems: string[] = [];
  {
    // Both Postgres tables, so a crash site on a `nullable` column reaches the same database.
    const pgColumns = [pgTable, pgNullable].flatMap(
      (t) => getTableConfig(t as never).columns as { name: string; notNull: boolean; getSQLType: () => string }[]
    );
    const wanted: { key: string; label: string; value: unknown; dialect: string; column: string }[] = [];
    for (const [key, e] of Object.entries(THREW)) {
      const [dialect, , column] = key.split('/');
      const declared = Object.keys(e.arbiter).sort().join(',');
      const values = [...e.values].sort().join(',');
      if (declared !== values) {
        arbiterProblems.push(`THREW[${key}].arbiter covers ${declared || 'nothing'}, and the crash values are ${values}`);
      }
      for (const label of e.values) {
        const found = POOL.find(([l]) => l === label);
        if (!found) {
          arbiterProblems.push(`THREW[${key}] names the value ${label}, which is not in POOL, so nothing can be asked about it`);
          continue;
        }
        wanted.push({ key, label, value: found[1], dialect, column });
      }
    }
    const probes: DbProbe[] = [];
    for (const w of wanted) {
      if (w.dialect !== 'pg') continue;
      const col = pgColumns.find((c) => c.name === w.column);
      if (!col) {
        arbiterProblems.push(`THREW[${w.key}] names a column the Postgres fixture does not have, so no DDL can be built for it`);
        continue;
      }
      // The pool's `undefined` is an absence and is carried to the database as one: the statement
      // never names the column, rather than binding a NULL where it would have gone.
      probes.push({
        key: w.key,
        sqlType: col.getSQLType(),
        notNull: col.notNull,
        label: w.label,
        absent: w.value === undefined,
        value: w.value,
      });
    }
    const { engine, answers } = await askPostgres(probes);
    // A run where the database answered nothing would otherwise leave every site reading as
    // deliberately unarbitrated.
    if (!probes.length) arbiterProblems.push('no crash site reached a database on this run, so nothing was arbitrated');
    if (engine !== 'pg') {
      arbiterProblems.push(`the in-process engine answers 'select version()' with ${engine}, and every answer below is read as a Postgres one`);
    }
    let arbitrated = 0;
    for (const w of wanted) {
      const e = THREW[w.key];
      const verdicts = [...new Set(
        [...(crashVerdict.get(w.key) ?? new Map<string, string>())]
          .filter(([at]) => at.slice(at.indexOf('/') + 1) === w.label)
          .map(([, v]) => v)
      )].sort();
      let got: string;
      if (w.dialect !== 'pg') {
        got = `no in-process ${w.dialect} engine`;
        // Asserted rather than only computed, against the engine's own name for itself.
        if (engine === w.dialect) {
          arbiterProblems.push(
            `${w.key}/${w.label} is declared unarbitrable for want of a ${w.dialect} engine, and the ` +
              `engine in this process names itself ${engine}`
          );
        }
      } else {
        const a = answers.get(`${w.key}/${w.label}`);
        if (!a) {
          arbiterProblems.push(`${w.key}/${w.label} was sent to the database and came back with no answer`);
          continue;
        }
        if (a.control) {
          arbiterProblems.push(`${w.key}/${w.label}: ${a.control}`);
          continue;
        }
        arbitrated++;
        const asked = w.value === undefined ? 'the column omitted from the insert' : 'it';
        got = a.verdict === 'accept' ? `postgres accepts ${asked}` : `postgres refuses ${asked} (SQLSTATE ${a.code})`;
        // The one rule the declaration cannot talk its way out of. A value the database refuses and
        // DRZL takes is a schema admitting a row the server will not, and it is only not a failure
        // here because the ledger already names it as a defect. Named or not, the run says which
        // probe it was and which map covered it: a defect that is filed is still a defect, and a
        // ledger entry is not a reason to print nothing. `ALLOWED` and `DEFECTS` are read
        // dialect-wide. On this pass that is the shape of the lookup rather than a live guard,
        // since every key here is built as `${dialect}/${column}` and no waiver is library-scoped;
        // the v1 copy of this check is where it does work, and is proven both ways there.
        if (a.verdict === 'refuse' && verdicts.includes('accept')) {
          const named = ALLOWED[`${w.dialect}/${w.column}`]
            ? 'ALLOWED'
            : DEFECTS[`${w.dialect}/${w.column}`]
              ? 'DEFECTS'
              : '';
          if (named) {
            console.log(
              `    ${w.key}/${w.label}: postgres refuses ${asked} and DRZL accepts it, filed as ` +
                `${named}[${w.dialect}/${w.column}] rather than failed here`
            );
          } else {
            arbiterProblems.push(
              `${w.key}/${w.label}: postgres refuses ${asked} and DRZL accepts it, and neither map names ` +
                `${w.dialect}/${w.column}`
            );
          }
        }
      }
      if (e.arbiter[w.label] === got) continue;
      arbiterProblems.push(`THREW[${w.key}].arbiter declares '${e.arbiter[w.label]}' for ${w.label}, and this run got '${got}'`);
    }
    console.log(
      `    ${arbitrated} crash probe(s) arbitrated against a real Postgres, of ` +
        `${wanted.length} across ${Object.keys(THREW).length} crash site(s)`
    );
  }

  const crashCount = [...crashed.values()].reduce((n, c) => n + c.at.size, 0);
  console.log(
    `    ${crashCount} probe(s) crashed instead of returning a verdict, on ${crashed.size} ` +
      `column(s) against ${Object.keys(THREW).length} declared, compared as neither accept nor ` +
      "reject, and DRZL's own verdict on each pinned above"
  );

  if (unledgered.length) {
    console.error('    FAIL: these columns differ from the official 0.4x module and are in neither');
    console.error('          map. A difference that is deliberate goes in ALLOWED with its reason,');
    console.error('          and one that is a DRZL defect goes in DEFECTS naming what it is:');
    for (const k of unledgered) console.error(`      ${k}`);
  }
  if (ledgerProblems.length) {
    console.error('    FAIL: the ledger no longer describes this run. If a defect was fixed, delete');
    console.error('          its entry; if it moved, re-measure it. An entry left behind is a');
    console.error('          sentence about something nobody can observe:');
    for (const p of ledgerProblems) console.error(`      ${p}`);
  }
  if (totalCompared !== EXPECTED_COMPARISONS) {
    const direction = totalCompared < EXPECTED_COMPARISONS ? 'fewer' : 'more';
    console.error(`    FAIL: ${totalCompared} column comparisons, expected ${EXPECTED_COMPARISONS}.`);
    console.error(`          This run compared ${direction} columns than EXPECTED_COMPARISONS says.`);
    if (totalCompared < EXPECTED_COMPARISONS) {
      console.error('          A parity pass that measures fewer columns than it did yesterday is');
      console.error('          the failure this file has been bitten by most, so this is a stop.');
      console.error('          Find what stopped being compared before touching the constant.');
    } else {
      console.error('          A fixture grew. That is fine and it is not automatic: measure the');
      console.error('          new columns, put any difference in ALLOWED or DEFECTS with its');
      console.error('          reason, and then update EXPECTED_COMPARISONS in this file to match.');
    }
  }
  if (crashProblems.length) {
    console.error('    FAIL: a probe crashed where the THREW list does not say one does, or a');
    console.error('          declared crash stopped happening, or DRZL answered something else');
    console.error('          where it did. A crash is not a verdict and must not be compared as');
    console.error('          one, and it is not a reason to stop measuring DRZL either:');
    for (const c of crashProblems) console.error(`      ${c}`);
  }
  if (arbiterProblems.length) {
    console.error('    FAIL: a crash site is no longer settled the way it is declared to be. A');
    console.error('          value official crashes on is still a value DRZL answers, and');
    console.error('          something has to say whether that answer is right:');
    for (const a of arbiterProblems) console.error(`      ${a}`);
  }
  if (unnamedProblems.length) {
    console.error('    FAIL: the unnamed-column list does not describe this run:');
    for (const u of unnamedProblems) console.error(`      ${u}`);
  }
  if (capProblems.length) {
    console.error('    FAIL: a MySQL text column no longer separates a byte budget from a');
    console.error('          character count the way it is documented to:');
    for (const c of capProblems) console.error(`      ${c}`);
  }
  if (findings.length) {
    console.error(`    FAIL: ${findings.length} parity finding(s): a generated schema differs from`);
    console.error('          the first-party module on a value, and no waiver names that');
    console.error('          difference. Looser is not automatically wrong, which is what this');
    console.error('          sentence used to claim. Ask the database which side is right, then');
    console.error('          put the answer in ALLOWED with its measurement, or fix the generator.');
  }
  if (selectOptionalProblems.length) {
    console.error('    FAIL: a select schema lets a key go missing. A select row carries every');
    console.error('          column, so an optional key there is wrong however many libraries agree');
    console.error('          about it:');
    for (const p of selectOptionalProblems) console.error(`      ${p}`);
  }
  if (presenceProblems.length) {
    console.error('    FAIL: the key-presence axis could not measure what it claims to. A column no');
    console.error('          side accepts a value for, an object a side refuses despite being built');
    console.error('          from its own accepted values, and an omission a side crashes on are');
    console.error('          none of them readings, and must not be compared as ones:');
    for (const p of presenceProblems) console.error(`      ${p}`);
  }
  if (
    findings.length ||
    ledgerProblems.length ||
    unledgered.length ||
    crashProblems.length ||
    arbiterProblems.length ||
    unnamedProblems.length ||
    capProblems.length ||
    presenceProblems.length ||
    selectOptionalProblems.length ||
    totalCompared !== EXPECTED_COMPARISONS
  ) {
    process.exit(1);
  }
}
PARITY_0_4X

if ! npx tsx parity-0-4x.ts; then
  echo "FAIL: DRZL's generated validators do not match the official ones on drizzle-orm 0.4x." >&2
  exit 1
fi
cd "$APP"

# ---------------------------------------------------------------------------------------------
# Can the published packages actually be installed?
#
# `@drzl/cli@4.13.0` shipped with a hard dependency on a package added in the same release, whose
# first publish failed because npm trusted publishing has nothing to authenticate against for a
# name that has never existed. Every gate in this file was green: the tarballs were correct, the
# workspace resolved, and `npm install @drzl/cli` failed with a 404 for everyone.
#
# The rule that would have caught it: a workspace dependency that is not yet on the registry has
# to be optional, because an unresolvable optional dependency is skipped rather than failing the
# install. Once it is published it can become a hard dependency like the rest.
# ---------------------------------------------------------------------------------------------
echo "==> workspace dependencies exist on the registry"
cd "$ROOT"
missing=0
for pkg in packages/*/package.json; do
  owner=$(node -p "require('./$pkg').name")
  deps=$(node -p "Object.keys(require('./$pkg').dependencies||{}).filter(d=>d.startsWith('@drzl/')).join(' ')")
  for dep in $deps; do
    if ! npm view "$dep" version >/dev/null 2>&1; then
      echo "    FAIL: $owner depends on $dep, which is not on the registry." >&2
      echo "          A package awaiting its first publish must be an optionalDependency, or" >&2
      echo "          installing $owner fails outright for everyone." >&2
      missing=1
    fi
  done
done
[ "$missing" = 0 ] || exit 1
echo "    every @drzl dependency resolves on npm"

# ---------------------------------------------------------------------------------------------
# Does what npm actually serves carry a provenance attestation?
#
# The release workflow sets NPM_CONFIG_PROVENANCE and grants `id-token: write`, and both of those
# are statements of intent. The attestation is the result, it is produced by a different machine,
# and nothing looked at it. Losing it is silent in exactly the way this whole file exists for: the
# workflow still passes, the packages still publish, and the only difference is that npm stops
# showing where the tarball was built and `npm audit signatures` stops being able to answer.
#
# Measured 2026-08-03, over every version of every package: 203 published, 201 attested. The two
# without are @drzl/generator-json-schema@0.2.0 and @drzl/generator-typebox@0.0.0, and both are a
# package's very first version. That is not a workflow defect and it is not fixable: npm trusted
# publishing authenticates against a package that already exists, so the first version of a new
# name has to be published by hand and cannot carry provenance. Every version published by CI
# since has one.
#
# This asks about the version tagged `latest`, not about the version in this working tree, which
# during a release has not been published yet.
#
# The one exemption is load-bearing rather than tidiness. `pnpm verify:packed` runs as a step in
# release.yml *before* `changeset publish`, so a gate that failed on a package CI has never
# published would abort the job before the publish step, and the CI publish that is the only way
# to attest that package could never run. The repo would be one new package away from a release
# deadlock, and it added one in each of the last two releases.
#
# So the exemption is stated as what it actually needs to be: skip when *no* version of the
# package carries an attestation, which is exactly "CI has never published this". Counting
# versions instead is close but not the same thing, and the difference is a live deadlock shape:
# a package hand-published twice before CI takes over has two versions and no attestation, and
# the documented remediation for a broken release here is a hand publish, so it is the obvious
# way to arm it.
#
# The stronger form also detects more. `drizzle` has 33 versions and none attested, so CI has
# never published it and there is nothing to regress. `eslint-plugin-drizzle` has 251 versions of
# which 239 are attested and `latest` is not, which is a provenance setup that used to work and
# has stopped. Only the second is this gate's business, and a version count cannot tell them
# apart.
#
# Every error is a hard failure. An earlier draft skipped when the version lookup failed, which
# printed "this is a first publish" over a network error and exited 0.
# ---------------------------------------------------------------------------------------------
echo "==> published packages carry a provenance attestation"
names=$(node -e "
  const fs = require('fs');
  const out = [];
  for (const dir of fs.readdirSync('packages')) {
    const file = 'packages/' + dir + '/package.json';
    if (!fs.existsSync(file)) continue;
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!p.private) out.push(p.name);
  }
  process.stdout.write(out.join(' '));
")
cat > "$WORK/check-provenance.mjs" <<'PROVENANCE'
/**
 * One abbreviated packument per package, which is the only response that carries every version's
 * `dist.attestations` in a single request. `npm view` cannot answer this: a range resolves to one
 * version, so asking it per version would be one request per version, and one of the fixtures
 * this is reasoned about has 251 of them.
 */
const [registry, ...names] = process.argv.slice(2);
const base = registry.replace(/\/$/, '');
// The abbreviated document, roughly a third the size of the full one, and it carries `dist`.
const ACCEPT = 'application/vnd.npm.install-v1+json';

let bad = 0;
let notFound = 0;
/**
 * The positive control, and the thing that makes the exemption below safe to draw.
 *
 * `dist.attestations` being absent from a response is not the same observation as the package
 * having no attestation, and the difference decides the verdict: absent reads as "CI has never
 * published this", which is the branch that passes. A mirror configured as `registry` that drops
 * the field, or an abbreviated packument that stops carrying it, would put every package on that
 * branch and the stage would go green having measured nothing. `dist.attestations` is not in the
 * documented `dist` field set for the abbreviated document, so this is a shape npm is entitled to
 * change.
 *
 * So an absence is only allowed to mean anything once this run has seen the field present
 * somewhere. That is a positive observation that the source reports attestations at all.
 */
let attestedVersionsSeen = 0;
/** Verdicts deferred until the control above is known, so nothing prints a reason it cannot back. */
const exempt = [];
for (const name of names) {
  let doc;
  try {
    const res = await fetch(`${base}/${name.replace('/', '%2f')}`, { headers: { accept: ACCEPT } });
    if (res.status === 404) {
      notFound++;
      console.log(`    ${name} has no published version yet, so there is nothing to attest`);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    doc = await res.json();
  } catch (err) {
    // Never a skip. A registry that cannot be read is an unanswered question, not a pass.
    console.error(`    FAIL: could not read ${name} from ${base}: ${err.message}`);
    bad++;
    continue;
  }

  const latest = doc['dist-tags']?.latest;
  const versions = Object.keys(doc.versions ?? {});
  if (!latest || !doc.versions?.[latest]) {
    console.error(`    FAIL: ${name} has no version tagged latest, which npm should never serve.`);
    bad++;
    continue;
  }

  const attested = versions.filter((v) => doc.versions[v].dist?.attestations);
  attestedVersionsSeen += attested.length;
  const predicate = doc.versions[latest].dist?.attestations?.provenance?.predicateType;
  if (predicate) {
    console.log(`    ${name}@${latest}  ${predicate}`);
    continue;
  }
  if (attested.length === 0) {
    exempt.push({ name, latest, versions: versions.length });
    continue;
  }
  console.error(
    `    FAIL: ${name}@${latest} carries no provenance attestation, but ${attested.length} of ` +
      `its ${versions.length} versions do, so this package's provenance used to work and has ` +
      `stopped. Check that release.yml still sets NPM_CONFIG_PROVENANCE and still grants ` +
      `id-token: write, and that this version was published by CI rather than by hand.`
  );
  bad++;
}

// A registry pointed somewhere wrong answers 404 for everything, and every package would then
// take the "not published yet" line and the stage would pass having measured nothing. One
// unpublished package is ordinary; all of them is a broken registry.
if (names.length > 1 && notFound === names.length) {
  console.error(`    FAIL: ${base} answered 404 for all ${names.length} packages. That is a`);
  console.error('          registry pointed at the wrong place, not a workspace that has never');
  console.error('          published anything. Check `npm config get registry` and .npmrc.');
  bad++;
}

if (exempt.length && attestedVersionsSeen === 0) {
  // Nothing in this run carried the field, so "this package has no attestation" and "this source
  // does not report attestations" are the same observation and cannot be told apart. Neither is
  // a pass. Naming the packages matters: if they really are all awaiting a first CI publish, that
  // is the answer, and it needs a person rather than a default.
  console.error(`    FAIL: not one of the ${names.length} package(s) read from ${base} carried a`);
  console.error('          dist.attestations field on any version, so this run cannot tell a');
  console.error('          package that has never been published by CI from a registry that does');
  console.error('          not report attestations at all. Unattested here:');
  for (const e of exempt) console.error(`            ${e.name}@${e.latest} (${e.versions} version(s))`);
  console.error('          Check that `npm config get registry` is registry.npmjs.org and not a');
  console.error('          mirror, then confirm on the package page whether provenance is really');
  console.error('          absent.');
  bad++;
} else {
  for (const e of exempt) {
    console.log(
      `    ${e.name}@${e.latest} has no attestation, and neither does any of its ` +
        `${e.versions} version(s), so CI has never published it. npm trusted publishing ` +
        `cannot authenticate a name that has never existed, so the first publish is made by ` +
        `hand. Failing here would abort the release that would attest it. ` +
        `(${attestedVersionsSeen} attested version(s) seen elsewhere in this run, so the field ` +
        `is being reported.)`
    );
  }
}

if (bad) process.exit(1);
PROVENANCE
if ! node "$WORK/check-provenance.mjs" "$(npm config get registry)" $names; then
  exit 1
fi
cd "$APP"

echo "OK: $count packages packed, installed into an empty project, generated, and the output"
echo "    typechecks under bundler, node16 and nodenext, and is compared column by column and value"
echo "    by value against all four first-party drizzle-orm validator modules on each of three"
echo "    dialects and three modes. Every difference either fails this run or is in one of two"
echo "    ledgers by name: ALLOWED, where the difference is deliberate, or DEFECTS, where DRZL is"
echo "    wrong and it is filed rather than fixed and named on every run with what each side"
echo "    emits. Both ledgers are asserted the same way and in both directions, each entry"
echo "    pinning the exact set of probes it covers, so a stale entry fails as loudly as an"
echo "    unledgered difference. That comparison is the guarantee, and it is not \"at least as"
echo "    strict\": most ledger entries have DRZL accepting something official refuses, the run"
echo "    counts them above, and each says why."
echo "    The four generators are cross-checked against each other on every dialect,"
echo "    checked against a real Postgres, a real SQLite and, where MYSQL_URL is set, a real"
echo "    MySQL, with applyDefaults compared against what the database writes, and described the"
echo "    same way by the analyzer under both drizzle-orm majors, bar the differences that stage"
echo "    names one at a time, three of which are columns 0.4x leaves unnamed. The same column by"
echo "    column comparison runs a second time against the first-party validators for 0.45.2,"
echo "    where the columns known to differ are counted and named above, each with what DRZL"
echo "    emits, what official emits and which filing it is. Where an official validator crashes"
echo "    instead of answering, DRZL's own verdict on that value is pinned rather than dropped,"
echo "    and settled against a real Postgres, which is asked about the column being left out of an"
echo "    insert as well as about the value it is given. The JSON Schema output compiles under ajv"
echo "    in strict mode, agrees with Postgres wherever the zod output does, and speaks as a fifth"
echo "    voice on every CHECK. Every tarball holds the files its manifest names and nothing from"
echo "    the working tree, and every package npm is serving carries a provenance attestation."
