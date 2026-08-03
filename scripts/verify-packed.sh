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

# Every generator kind, not just zod. Covering one of five is how the published oRPC generator
# came to emit routers that fail `tsc --strict` while this guard stayed green.
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
# The claim DRZL makes is that its generated schemas are at least as strict as the first-party
# `drizzle-orm/{zod,valibot,arktype}` modules. That is a claim about behaviour, so it is measured
# by behaviour: generate for the same table, then push the same pool of values through both
# schemas column by column and compare the verdicts. Reading the emitted source cannot do this,
# because a schema that parses and a schema that validates look identical as text.
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

// Every CHECK form the shared parser claims to understand, so Postgres can be asked whether the
// emitted constraint means the same thing. CHECK support is DRZL's main advantage over the
// first-party validators and until now it was verified only against its own emitted strings.
// Nullable on purpose, like the matrix table: each probe inserts one column.
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
import { sqliteTable, text, integer, real, numeric, blob, check } from 'drizzle-orm/sqlite-core';
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
import * as v from 'valibot';
import { type } from 'arktype';
import { Value } from '@sinclair/typebox/value';

import { matrix as pgTable } from './schema.js';
import { matrix as myTable } from './schema-mysql.js';
import { matrix as sqTable } from './schema-sqlite.js';

const POOL: [string, unknown][] = [
  ['null', null], ['undefined', undefined], ['""', ''], ["'hello'", 'hello'],
  ['300-char', 'x'.repeat(300)], ['70k-char', 'x'.repeat(70000)], ['5-char', 'xxxxx'],
  // Astral-plane characters, which tell a code-point count from a UTF-16 `.length`. Without them
  // the pool cannot see the difference, which is exactly how the `varchar(n)` bug survived.
  ['3 emoji', '\u{1F44D}\u{1F44D}\u{1F44D}'],
  ['5 emoji', '\u{1F44D}\u{1F44D}\u{1F44D}\u{1F44D}\u{1F44D}'],
  // Astral-plane characters, where a code-point count and a UTF-16 `.length` disagree.
  // Postgres counts characters for `varchar(n)`, so a 3-emoji string fits in a varchar(5)
  // that every library's `.max(5)` refuses.
  ['3 emoji', '\u{1F44D}\u{1F44D}\u{1F44D}'],
  ['5 emoji', '\u{1F44D}\u{1F44D}\u{1F44D}\u{1F44D}\u{1F44D}'],
  ["'not-a-uuid'", 'not-a-uuid'], ['uuid', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
  ["'zzz'", 'zzz'], ["'a'", 'a'], ["'happy'", 'happy'],
  // A member of the `varchar({ enum: ['x', 'y'] })` fixture column. Without it the pool held no
  // value that column accepts, so both sides rejected all of it and the comparison agreed while
  // measuring nothing. The vacuity check below is what found it.
  ["'x'", 'x'],
  ['0', 0], ['1', 1], ['1.5', 1.5], ['-1', -1], ['200', 200], ['40000', 40000],
  ['9000000', 9000000], ['2147483648', 2147483648], ['9007199254740993', 9007199254740993],
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
  ['Buffer', Buffer.from('ab')], ['Uint8Array', new Uint8Array([1, 2])],
  ["'999.999.999.999'", '999.999.999.999'], ["'10.0.0.1'", '10.0.0.1'],
  ['{x:1,y:2}', { x: 1, y: 2 }], ["'12.5'", '12.5'], ["'0101'", '0101'], ["'010'", '010'],
];

type Lib = { field: (s: any, k: string) => any; ok: (f: any, x: unknown) => boolean };

const LIBS: Record<string, Lib> = {
  zod: { field: (s, k) => s.shape[k], ok: (f, x) => f.safeParse(x).success },
  valibot: { field: (s, k) => s.entries[k], ok: (f, x) => v.safeParse(f, x).success },
  arktype: { field: (s, k) => s.get(k), ok: (f, x) => !(f(x) instanceof type.errors) },
  typebox: { field: (s, k) => s.properties[k], ok: (f, x) => Value.Check(f, x) },
};

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

const safeOk = (lib: Lib, f: any, x: unknown) => {
  try {
    return lib.ok(f, x);
  } catch {
    return false;
  }
};
const safeField = (lib: Lib, s: any, k: string) => {
  try {
    return lib.field(s, k);
  } catch {
    return undefined;
  }
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
const ALLOWED: Record<string, string> = {
  // Binary payloads are typed as Uint8Array rather than Buffer. A Buffer is a Uint8Array, so
  // nothing official accepts is turned away. The wider check needs no `@types/node`, survives a
  // runtime where `Buffer` is undefined, and makes bytea and blob validate the same way.
  'pg/c_bytea': 'Uint8Array accepted where official demands a Buffer',
  'sqlite/s_blob_buf': 'as pg/c_bytea',
  // `coerceDates` defaults to coercing on insert and update, which is a documented DRZL option
  // and is what `coerceDates: 'none'` turns off to match official exactly. Only strings and
  // numbers are coerced: null, booleans and arrays are rejected, which `z.coerce.date()` accepts.
  'pg/c_date_d': 'coerceDates accepts a date string or epoch number on write',
  'pg/c_ts_d': 'as pg/c_date_d',
  'mysql/m_date': 'as pg/c_date_d',
  'mysql/m_datetime': 'as pg/c_date_d',
  'mysql/m_ts': 'as pg/c_date_d',
  'sqlite/s_int_ts': 'as pg/c_date_d',
  'sqlite/s_int_ts_ms': 'as pg/c_date_d',
  // Official emits `Type.String({ format: 'uuid' })`, and TypeBox fails a format it has no entry
  // for rather than ignoring it, so that schema rejects every valid uuid in any project that has
  // not populated `FormatRegistry` first. This generator emits a pattern, which needs no setup.
  'pg/typebox/c_uuid': 'official uses an unregistered `format`, which rejects every uuid',
  // A character limit counts *characters*; official counts `.length`, which is UTF-16 units, so
  // it refuses three emoji in a `char(4)` the database accepts. Measured against Postgres.
  'pg/c_char': 'character limit counts code points; official counts UTF-16 units',
  'mysql/m_char': 'as pg/c_char',
  // Stricter than official, and verified against Postgres itself through PGlite: a `numeric`
  // column is a string, and a bare string schema accepts 'hello' where the database rejects it.
  // Official accepts all of these; the database does not.
  'pg/c_numeric': 'numeric format enforced; official accepts any string, Postgres does not',
  'pg/c_decimal': 'as pg/c_numeric',
  'mysql/m_decimal': 'as pg/c_numeric',
  // Stricter than official, in DRZL's favour.
  'pg/valibot/c_json': 'DRZL rejects Infinity and non-plain objects; official accepts both',
  'pg/valibot/c_jsonb': 'as pg/valibot/c_json',
  'pg/valibot/c_jsonb_typed': 'as pg/valibot/c_json',
  'mysql/valibot/m_json': 'as pg/valibot/c_json',
  'sqlite/valibot/s_text_json': 'as pg/valibot/c_json',
  'sqlite/valibot/s_blob_json': 'as pg/valibot/c_json',
  // A `blob()` with no mode is Drizzle's json mode, not its buffer mode, so this is the same
  // column shape as s_blob_json and gets the same reasoning. `s_blob_buf` above is the buffer one.
  'sqlite/valibot/s_blob': 'as pg/valibot/c_json; a bare blob() is Drizzle json mode',
  'pg/valibot/c_point': 'v.strictTuple rejects a third element; official v.tuple ignores extras',
  'pg/valibot/c_geometry': 'as pg/valibot/c_point',
  // Official emits `Type.RegExp`, whose check runs `RegExp.prototype.test` against the raw value,
  // and `test` stringifies what it is given: `[]` becomes '' and matches `^[01]*$`. So official
  // accepts an empty array for a binary column. This generator emits a `string` carrying a
  // `pattern`, which refuses a non-string before the pattern is consulted. Postgres masks the
  // same hole on `c_bit` only because that column has a `minLength` an array cannot satisfy.
  'mysql/typebox/m_binary': 'official Type.RegExp accepts a non-string whose string form matches',
  'mysql/typebox/m_varbinary': 'as mysql/typebox/m_binary',
  // No arktype bigint entry. There were three, reading "ArkType cannot bound a bigint in its
  // string DSL", and only half of that was true: the DSL cannot state the bound, but a narrow can,
  // and this generator already used narrows for every character cap. It was the one place in this
  // whole gate where DRZL was looser than the first-party module, waived on all three dialects.
  // The generator now bounds bigint columns and all four agree.
};

const usedWaivers = new Set<string>();
const allowed = (dialect: string, lib: string, col: string) => {
  for (const key of [`${dialect}/${lib}/${col}`, `${dialect}/${col}`]) {
    if (ALLOWED[key]) {
      usedWaivers.add(key);
      return ALLOWED[key];
    }
  }
  return undefined;
};

/**
 * Cross-generator gaps that follow from what each library can express, not from a defect in one
 * generator. Keyed `<dialect>/<column>` and carrying its reason, for the same reason ALLOWED is.
 */
const CROSS_ALLOWED: Record<string, string> = {
  // ArkType's string DSL has no recursive JSON value, so this generator emits
  // `number | object | string | boolean | null`, which takes NaN, Infinity and any object at all.
  // The other three build a real JSON value check. A capability difference between the libraries:
  // official `drizzle-orm/arktype` produces the same widening, which is why this shows up here and
  // not against official.
  'pg/c_json': "arktype's string DSL cannot state a recursive JSON value",
  'pg/c_jsonb': 'as pg/c_json',
  'pg/c_jsonb_typed': 'as pg/c_json',
  'mysql/m_json': 'as pg/c_json',
  'sqlite/s_text_json': 'as pg/c_json',
  'sqlite/s_blob_json': 'as pg/c_json',
  'sqlite/s_blob': 'as pg/c_json; a bare blob() is Drizzle json mode',
  // No bigint entry either, for the reason given in ALLOWED: arktype now bounds a bigint with a
  // narrow, so the four generators agree about `c_bigint_b`, `m_bigint_b` and `s_blob_bigint`.
  // No `c_char` entry. There was one, reading "zod and valibot count code points; TypeBox and
  // ArkType count UTF-16 units", and it had been dead since arktype and typebox were changed to
  // count code points as well. All four now emit a `[...v].length` predicate and agree on every
  // probe including astral text, so there is nothing to waive. It survived because the waiver was
  // marked used by the column merely existing; see the note at the crossAllowed call site.
};

const usedCrossWaivers = new Set<string>();
const crossAllowed = (dialect: string, col: string) => {
  const key = `${dialect}/${col}`;
  if (!CROSS_ALLOWED[key]) return false;
  usedCrossWaivers.add(key);
  return true;
};

const DIALECTS = [
  {
    name: 'pg',
    table: pgTable,
    libs: ['zod', 'valibot', 'arktype', 'typebox'],
    mods: {
      zod: () => import('./gen/pg/zod/matrix.zod.js'),
      valibot: () => import('./gen/pg/valibot/matrix.valibot.js'),
      arktype: () => import('./gen/pg/arktype/matrix.arktype.js'),
      typebox: () => import('./gen/pg/typebox/matrix.typebox.js'),
    } as Record<string, () => Promise<any>>,
  },
  {
    name: 'mysql',
    table: myTable,
    libs: ['zod', 'valibot', 'arktype', 'typebox'],
    mods: {
      zod: () => import('./gen/mysql/zod/matrix.zod.js'),
      valibot: () => import('./gen/mysql/valibot/matrix.valibot.js'),
      arktype: () => import('./gen/mysql/arktype/matrix.arktype.js'),
      typebox: () => import('./gen/mysql/typebox/matrix.typebox.js'),
    } as Record<string, () => Promise<any>>,
  },
  {
    name: 'sqlite',
    table: sqTable,
    libs: ['zod', 'valibot', 'arktype', 'typebox'],
    mods: {
      zod: () => import('./gen/sqlite/zod/matrix.zod.js'),
      valibot: () => import('./gen/sqlite/valibot/matrix.valibot.js'),
      arktype: () => import('./gen/sqlite/arktype/matrix.arktype.js'),
      typebox: () => import('./gen/sqlite/typebox/matrix.typebox.js'),
    } as Record<string, () => Promise<any>>,
  },
];

const PREFIX = { select: 'Select', insert: 'Insert', update: 'Update' } as const;
let findings = 0;

for (const d of DIALECTS) {
  const loaded: Record<string, any> = {};
  for (const lib of d.libs) loaded[lib] = await d.mods[lib]();

  for (const mode of ['select', 'insert', 'update'] as const) {
    for (const libName of d.libs) {
      const off = OFFICIAL[libName]?.[mode];
      if (!off) continue;
      const lib = LIBS[libName];
      const official = off(d.table as never);
      const mine = loaded[libName][`${PREFIX[mode]}matrixSchema`];
      if (!mine) {
        console.log(`    ${d.name}/${libName}/${mode}: no ${PREFIX[mode]}matrixSchema exported`);
        findings++;
        continue;
      }

      // Column names come from the zod schema regardless of library: every generator emits the
      // same set, and zod is the one whose shape is trivially enumerable.
      const oShape = OFFICIAL.zod[mode](d.table as never).shape;
      const rows: string[] = [];
      let waived = 0;
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
          if (allowed(d.name, libName, k)) { waived++; continue; }
          rows.push(`        ${k}: official has it, DRZL omits it`);
          continue;
        }
        if (!o) {
          if (allowed(d.name, libName, k)) { waived++; continue; }
          rows.push(`        ${k}: DRZL has it, official omits it`);
          continue;
        }
        compared++;
        const looser: string[] = [];
        const tighter: string[] = [];
        let officialTook = false;
        let drzlTook = false;
        for (const [label, x] of POOL) {
          const a = safeOk(lib, o, x);
          const b = safeOk(lib, m, x);
          officialTook ||= a;
          drzlTook ||= b;
          if (a !== b) (b ? looser : tighter).push(label);
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
        if (allowed(d.name, libName, k)) { waived++; continue; }
        rows.push(
          `        ${k}:` +
            (looser.length ? `\n          DRZL accepts, official rejects: ${looser.join(', ')}` : '') +
            (tighter.length ? `\n          DRZL rejects, official accepts: ${tighter.join(', ')}` : '')
        );
      }

      // A run that compared no column at all would otherwise print `parity` and pass. That is the
      // shape of failure this file has been bitten by most: the stage was green because it had
      // measured nothing, not because there was nothing to find.
      if (compared === 0) {
        rows.push('        no column was compared on both sides, so this pairing measured nothing');
      }

      console.log(
        `    ${d.name.padEnd(7)} ${libName.padEnd(8)} ${mode.padEnd(7)} ` +
          `${compared}/${Object.keys(oShape).length} cols compared  ${rows.length ? 'DIFFERS' : 'parity'}` +
          `${waived ? ` (${waived} waived)` : ''}`
      );
      if (rows.length) {
        console.log(rows.join('\n'));
        findings += rows.length;
      }
    }
  }

  // Pass 2, on every dialect that has all four generators, which is now all three.
  if (d.libs.length === 4) {
    const oShape = OFFICIAL.zod.select(d.table as never).shape;
    const disagreements: string[] = [];
    for (const k of Object.keys(oShape)) {
      const fields: Record<string, any> = {};
      for (const lib of d.libs) fields[lib] = safeField(LIBS[lib], loaded[lib].SelectmatrixSchema, k);
      const found: string[] = [];
      const absent = Object.entries(fields).filter(([, f]) => !f).map(([n]) => n);
      if (absent.length) {
        found.push(`        ${k}: missing from ${absent.join(', ')}`);
      } else {
        for (const [label, x] of POOL) {
          const verdicts = d.libs.map((n) => [n, safeOk(LIBS[n], fields[n], x)] as const);
          const yes = verdicts.filter(([, r]) => r).map(([n]) => n);
          const no = verdicts.filter(([, r]) => !r).map(([n]) => n);
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
      if (crossAllowed(d.name, k)) continue;
      disagreements.push(...found);
    }
    if (disagreements.length) {
      console.log(`    the four ${d.name} generators disagree with each other:`);
      console.log(disagreements.join('\n'));
      findings += disagreements.length;
    } else {
      console.log(`    all four ${d.name} generators agree with each other on every column and value`);
    }
  }
}

// A waiver that suppresses nothing is not harmless. It is a sentence claiming a divergence exists
// and is fine, sitting next to the divergences that really do, and the next person to widen this
// file reads it as covered ground. Every key above has to earn its place on this run or be
// deleted, which is also the only thing standing between this list and being used as a way to
// make a failure go away.
const deadWaivers = [
  ...Object.keys(ALLOWED).filter((k) => !usedWaivers.has(k)).map((k) => `ALLOWED[${k}]`),
  ...Object.keys(CROSS_ALLOWED).filter((k) => !usedCrossWaivers.has(k)).map((k) => `CROSS_ALLOWED[${k}]`),
];
if (deadWaivers.length) {
  console.error('FAIL: these waivers suppressed nothing on this run, so they describe a');
  console.error('      divergence that no longer happens. Delete them rather than keeping a');
  console.error('      reason for something nobody can observe:');
  for (const k of deadWaivers) console.error(`      ${k}`);
}

if (findings) {
  console.error(`FAIL: ${findings} parity finding(s). A generated schema looser than the`);
  console.error('      first-party module accepts rows the database will reject.');
}

// Counted separately and exited on together, so one run reports both rather than hiding the
// second behind the first. A dead waiver is not a looser schema and must not be described as one.
if (findings || deadWaivers.length) process.exit(1);
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
npm install --no-audit --no-fund --loglevel=error \
  "$TARS"/*.tgz drizzle-orm@1.0.0-rc.4 zod valibot arktype @sinclair/typebox tsx typescript \
  ajv@^8.17.1 ajv-formats@^3.0.1 >/dev/null

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
    for f in matrix.schema.ts checked.schema.ts defaulted.schema.ts components.ts index.ts; do
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
  // back. Somewhere outside the include above, so the stage's own run does not compile them.
  for (const col of cols) {
    const one = new RegExp(`^\\s*"${col}\\??":`);
    const withCol = lines.filter((l) => !drop.test(l) || one.test(l));
    if (withCol.length !== kept.length + MODES) {
      console.error(`FAIL: restoring ${col} into the ${dialect} copy did not put back ${MODES} lines.`);
      process.exit(1);
    }
    fs.writeFileSync(`src/carve-probe/${dialect}-${col}.ts`, withCol.join('\n'));
  }
}
CARVE
cat > tsconfig.gen.json <<'EOF'
{
  "compilerOptions": {
    "strict": true, "noEmit": true, "target": "es2022",
    "module": "nodenext", "moduleResolution": "nodenext", "skipLibCheck": true
  },
  "include": [
    "src/gen/**/*.ts", "src/gen-tsc/**/*.ts",
    "src/schema.ts", "src/schema-mysql.ts", "src/schema-sqlite.ts"
  ],
  "exclude": [
    "src/gen/pg/arktype/matrix.arktype.ts",
    "src/gen/mysql/arktype/matrix.arktype.ts",
    "src/gen/pg/arktype/index.ts",
    "src/gen/mysql/arktype/index.ts"
  ]
}
EOF
# The originals are excluded because the copies stand in for them, and their barrels with them:
# `exclude` only filters the entry list, so `index.ts` re-exporting the matrix module would pull
# the original straight back in. Those barrels are four re-export lines on pg and three on mysql,
# and the copies cover the modules they name. What is given up with them is narrow and worth
# saying: the barrel is no longer the thing that pulls its modules in here, so a barrel line
# naming a module that does not exist would not be caught by this stage.
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
# Compiled one at a time on purpose. TypeScript's instantiation budget is global to a compilation,
# so a single run over all three probes would report only the first to exhaust it and the other two
# would look resolved.
carve_dead=0
for probe in src/carve-probe/*.ts; do
  if npx tsc --strict --noEmit --target es2022 --module nodenext --moduleResolution nodenext \
      --skipLibCheck "$probe" >/dev/null 2>&1; then
    echo "FAIL: $probe compiles, so that column no longer needs carving out of the typecheck." >&2
    echo "      Delete it from CARVED above rather than leaving a column excluded for a defect" >&2
    echo "      that has been fixed." >&2
    carve_dead=1
  fi
done
[ "$carve_dead" = 0 ] || exit 1
echo "    each carved column still fails on its own, so the carve-out is still earning it"

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
# table. Measured rather than guessed, because a budget raised to make a number fit is worth
# nothing: on the original 62 columns arktype emits 223 bytes per column, up from 213, and those
# ten bytes are the bigint bound and the array element walk, both of them constraints that were
# missing. The two new columns cost 1803 bytes of module, about 900 each, four times the average,
# because a nullable capped array is the longest thing this generator emits and it is emitted once
# per mode. So the mixed average moved to 244 without any generator emitting more for the same
# input, which is the same effect recorded above for the CHECK columns. The figures reconcile:
# 13827 without the table, plus 1803 for the module and the 37-byte barrel line naming it,
# is the 15667 this script prints.
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
 * **What is gated**: DRZL must never disagree with Postgres where the official module agrees. A
 * validator is deliberately stricter than a coercing driver, so most disagreements are correct
 * and gating on them would be noise, but disagreeing where official does not means DRZL alone is
 * wrong. That is the assertion, and it is the one that catches an over-strict check: candidate
 * patterns for `date`, `time`, `macaddr` and `inet` were all discarded because this caught them
 * turning away values Postgres accepts.
 */
import { PGlite } from '@electric-sql/pglite';
import { createSelectSchema } from 'drizzle-orm/zod';
import { matrix } from './schema.js';
import { SelectmatrixSchema as drzl } from './gen/pg/zod/matrix.zod.js';
import { DDL } from './ddl.js';
// Shared with the JSON Schema ground-truth stage, so the two ask the database the same questions
// rather than two copies of them that have drifted apart.
import { MATRIX_POOL as POOL } from './probes.js';

const db = new PGlite();
await db.exec(DDL);

const official: any = createSelectSchema(matrix);
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

const drzlOnly = rows.filter((r) => r.drzl !== r.db && r.off === r.db);
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

await db.close();
GROUND_TRUTH

npm install --no-audit --no-fund --loglevel=error @electric-sql/pglite >/dev/null
if ! npx tsx src/ground-truth.ts; then
  echo "FAIL: a generated schema disagrees with Postgres itself." >&2
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

if ! npx tsx src/checks-truth.ts; then
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

if ! npx tsx src/defaults-truth.ts; then
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

if ! npx tsx src/mysql-truth.ts; then
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
if ! npx tsx --disable-warning=ExperimentalWarning src/sqlite-truth.ts; then
  echo "FAIL: a generated CHECK disagrees with SQLite." >&2
  exit 1
fi

cd "$APP"

# ---------------------------------------------------------------------------------------------
# The other drizzle major.
#
# Everything above pins drizzle-orm@1.0.0-rc.4, and every generator's own tests build fake column
# objects. Between them, nothing in this repository ever ran against 0.4x, which is the version
# the analyzer itself depends on and the one nearly every user has installed.
#
# What that hid: 0.4x models `.array()` by wrapping the column in a `PgArray` whose `baseColumn`
# is the element, while v1 leaves the class alone and raises `dimensions`. The analyzer read only
# the v1 signal, so on 0.4x every array column came back `unknown` in all five generators. The
# fixture above contains three array columns and the gate was green the whole time.
#
# This stage is deliberately narrow: it does not repeat parity or ground truth, it asserts that
# the analyzer still has an opinion about every column. A type it cannot name is the shape that
# failure takes.
# ---------------------------------------------------------------------------------------------
echo "==> generating against drizzle-orm 0.4x"
OLD="$WORK/old-major"
rm -rf "$OLD"; mkdir -p "$OLD/src"
cd "$OLD"
npm init -y >/dev/null 2>&1
npm install --no-audit --no-fund --loglevel=error \
  "$TARS"/*.tgz drizzle-orm@0.45.2 zod tsx >/dev/null

# Written once and analyzed under both majors, so the comparison below is about the analyzer
# rather than about two schemas that happen to differ. Every type here exists in both.
cat > src/schema.ts <<'OLD_SCHEMA'
import {
  pgTable, pgEnum, text, integer, smallint, bigint, varchar, char, timestamp, date,
  boolean, numeric, doublePrecision, uuid, json, jsonb,
} from 'drizzle-orm/pg-core';

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
OLD_SCHEMA

# The same file, analyzed by the v1 project, so the two runs can be compared directly.
cp src/schema.ts "$APP/src/cross-major.ts"

cat > drzl.config.ts <<'OLD_CONFIG'
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: 'src/schema.ts',
  outDir: 'src/gen',
  generators: [{ kind: 'zod', path: 'src/gen/zod' }],
});
OLD_CONFIG

npx drzl generate --config drzl.config.ts >/dev/null

cat > describe-columns.ts <<'DESCRIBE'
import { SchemaAnalyzer } from '@drzl/analyzer';

// What the analyzer claims about each column, reduced to the facts every generator reads.
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

async function main() {
  const file = process.argv[2];
  const a = await new SchemaAnalyzer(file).analyze({});
  const cols = a.tables.find((t) => t.name === 'rows')?.columns ?? [];
  const out = cols.map((c) => ({
    name: c.name,
    tsType: c.tsType,
    dbType: c.dbType,
    nullable: c.nullable,
    arrayDimensions: c.arrayDimensions ?? 0,
    enumValues: c.enumValues ?? null,
    maxLength: c.maxLength ?? null,
    min: c.min ?? null,
    max: c.max ?? null,
    format: c.format ?? null,
    shape: c.shape?.kind ?? null,
  }));
  console.log(JSON.stringify(out, null, 1));
}
DESCRIBE

cp describe-columns.ts "$APP/describe-columns.ts"
npx tsx describe-columns.ts src/schema.ts > "$WORK/cols-0.4x.json"
( cd "$APP" && npx tsx describe-columns.ts src/cross-major.ts ) > "$WORK/cols-v1.json"

cat > cross-major.ts <<'CROSS'
import { readFileSync } from 'node:fs';

/**
 * The same schema, analyzed under both drizzle majors, has to describe the same columns.
 *
 * This is the systematic form of the bug that prompted the stage: the analyzer read v1's array
 * signal and not 0.4x's, so `.array()` columns were `unknown` on the version most people have.
 * A per-column diff catches every instance of that shape at once, including the ones nobody has
 * thought to write a test for.
 *
 * Anything genuinely different between the majors belongs here, named, with a reason. An empty
 * list is the claim that the analyzer is version independent.
 *
 * This catches divergence. It cannot catch both majors being wrong the same way, which is why the
 * unnamed-column check below is separate rather than folded in: removing the analyzer's
 * `PgEnumColumn` arm makes both majors report `unknown`, so this comparison stays silent and that
 * one fires. Measured, not assumed.
 */
const ALLOWED: Record<string, string> = {};

const a = JSON.parse(readFileSync(process.env.OLD_JSON!, 'utf8'));
const b = JSON.parse(readFileSync(process.env.NEW_JSON!, 'utf8'));
const key = (c: any) => c.name;
const byName = (rows: any[]) => new Map(rows.map((c) => [key(c), c]));
const old = byName(a);
const now = byName(b);

const names = [...new Set([...old.keys(), ...now.keys()])];
const diffs: string[] = [];
for (const n of names) {
  const l = old.get(n);
  const r = now.get(n);
  if (!l || !r) {
    diffs.push(`${n}: present on ${l ? '0.4x' : 'v1'} only`);
    continue;
  }
  for (const f of Object.keys(l)) {
    const lv = JSON.stringify(l[f]);
    const rv = JSON.stringify(r[f]);
    if (lv === rv) continue;
    const waiver = ALLOWED[`${n}.${f}`];
    if (waiver) continue;
    diffs.push(`${n}.${f}: 0.4x ${lv}, v1 ${rv}`);
  }
}

console.log(`    ${names.length} columns compared across both drizzle majors`);
if (diffs.length) {
  console.error('    FAIL: the analyzer describes the same schema differently per major:');
  for (const d of diffs) console.error(`      ${d}`);
  console.error('\n    A generator reads these fields, so a difference here is a different schema.');
  process.exit(1);
}
CROSS

OLD_JSON="$WORK/cols-0.4x.json" NEW_JSON="$WORK/cols-v1.json" npx tsx cross-major.ts || {
  echo "FAIL: the analyzer is not consistent across drizzle-orm majors." >&2
  exit 1
}

cat > check-old.ts <<'OLD_CHECK'
import { SchemaAnalyzer } from '@drzl/analyzer';

// `npm init -y` leaves the project CommonJS, where tsx refuses a top-level await.
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

async function main() {
const a = await new SchemaAnalyzer('src/schema.ts').analyze({});
const cols = a.tables.find((t) => t.name === 'rows')?.columns ?? [];
if (!cols.length) {
  console.error('FAIL: no columns analyzed on drizzle-orm 0.4x at all.');
  process.exit(1);
}

// A column the analyzer cannot name is the shape this failure takes: nothing throws, the
// generators emit `z.unknown()`, and every row validates.
const vague = cols.filter((c) => c.tsType === 'unknown' || c.dbType === 'UNKNOWN');
const arrays = cols.filter((c) => c.name.match(/^(tags|scores|moods|grid)$/));
const notArrays = arrays.filter((c) => !c.arrayDimensions);

console.log(`    ${cols.length} columns analyzed on drizzle-orm 0.4x, ${vague.length} unnamed`);

let bad = 0;
if (vague.length) {
  console.error('    FAIL: analyzed as unknown on 0.4x:');
  for (const c of vague) console.error(`      ${c.name} (${c.dbType})`);
  bad++;
}
if (notArrays.length) {
  console.error('    FAIL: an .array() column carries no dimension:');
  for (const c of notArrays) console.error(`      ${c.name}`);
  bad++;
}
const grid = cols.find((c) => c.name === 'grid');
if (grid && grid.arrayDimensions !== 2) {
  console.error(`    FAIL: text().array().array() reported ${grid.arrayDimensions} dimensions, not 2`);
  bad++;
}
if (bad) process.exit(1);
}
OLD_CHECK

if ! npx tsx check-old.ts; then
  echo "FAIL: the analyzer loses column types on drizzle-orm 0.4x." >&2
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
echo "    typechecks under bundler, node16 and nodenext, and validates at least as strictly as"
echo "    all four first-party drizzle-orm validator modules on each of three dialects and three"
echo "    modes, with the four generators cross-checked against each other on every dialect,"
echo "    checked against a real Postgres, a real SQLite and, where MYSQL_URL is set, a real"
echo "    MySQL, with applyDefaults compared against what the database writes, and analyzed with"
echo "    no column left unnamed on either drizzle-orm major. The JSON Schema output compiles"
echo "    under ajv in strict mode, agrees with Postgres wherever the zod output does, and speaks"
echo "    as a fifth voice on every CHECK. Every tarball holds the files its manifest names and"
echo "    nothing from the working tree, and every package npm is serving carries a provenance"
echo "    attestation."
