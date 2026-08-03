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
# So this packs all ten packages, installs them into an empty project, runs the README's headline
# command, and typechecks the emitted tree under every moduleResolution TypeScript still supports.
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
  ['0', 0], ['1', 1], ['1.5', 1.5], ['-1', -1], ['200', 200], ['40000', 40000],
  ['9000000', 9000000], ['2147483648', 2147483648], ['9007199254740993', 9007199254740993],
  ['1900', 1900], ['2500', 2500], ['NaN', NaN], ['Infinity', Infinity],
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
 * Keyed `<library>/<column>`; a bare column name applies to every library.
 */
const ALLOWED: Record<string, string> = {
  // Binary payloads are typed as Uint8Array rather than Buffer. A Buffer is a Uint8Array, so
  // nothing official accepts is turned away. The wider check needs no `@types/node`, survives a
  // runtime where `Buffer` is undefined, and makes bytea and blob validate the same way.
  c_bytea: 'Uint8Array accepted where official demands a Buffer',
  s_blob_buf: 'as c_bytea',
  // `coerceDates` defaults to coercing on insert and update, which is a documented DRZL option
  // and is what `coerceDates: 'none'` turns off to match official exactly. Only strings and
  // numbers are coerced: null, booleans and arrays are rejected, which `z.coerce.date()` accepts.
  c_date_d: 'coerceDates accepts a date string or epoch number on write',
  c_ts_d: 'as c_date_d',
  m_date: 'as c_date_d',
  m_datetime: 'as c_date_d',
  m_ts: 'as c_date_d',
  s_int_ts: 'as c_date_d',
  s_int_ts_ms: 'as c_date_d',
  // Official emits `Type.String({ format: 'uuid' })`, and TypeBox fails a format it has no entry
  // for rather than ignoring it, so that schema rejects every valid uuid in any project that has
  // not populated `FormatRegistry` first. This generator emits a pattern, which needs no setup.
  'typebox/c_uuid': 'official uses an unregistered `format`, which rejects every uuid',
  // A character limit counts *characters*; official counts `.length`, which is UTF-16 units, so
  // it refuses three emoji in a `char(4)` the database accepts. Measured against Postgres.
  c_char: 'character limit counts code points; official counts UTF-16 units',
  m_char: 'as c_char',
  // Stricter than official, and verified against Postgres itself through PGlite: a `numeric`
  // column is a string, and a bare string schema accepts 'hello' where the database rejects it.
  // Official accepts all of these; the database does not.
  c_numeric: 'numeric format enforced; official accepts any string, Postgres does not',
  c_decimal: 'as c_numeric',
  m_decimal: 'as c_numeric',
  // Stricter than official, in DRZL's favour.
  'valibot/c_json': 'DRZL rejects Infinity and non-plain objects; official accepts both',
  'valibot/c_jsonb': 'as valibot/c_json',
  'valibot/c_jsonb_typed': 'as valibot/c_json',
  'valibot/c_point': 'v.strictTuple rejects a third element; official v.tuple ignores extras',
  'valibot/c_geometry': 'as valibot/c_point',
  // ArkType states a bigint range through a narrow predicate built with its builder API. This
  // generator emits one string per field, and the string DSL's comparators take numeric literals.
  'arktype/c_bigint_b': 'ArkType cannot bound a bigint in its string DSL',
  'arktype/s_blob_bigint': 'as arktype/c_bigint_b',
};

const allowed = (lib: string, col: string) => ALLOWED[`${lib}/${col}`] ?? ALLOWED[col];

/** Cross-generator gaps that follow from what each library can express, not from a defect. */
const CROSS_ALLOWED = (k: string) =>
  k.startsWith('c_json') ||
  k.startsWith('c_jsonb') ||
  /bigint_b|blob_bigint/.test(k) ||
  // zod and valibot count code points for a character limit; TypeBox and ArkType state a length
  // declaratively with no predicate to hook, so they keep the UTF-16 form and stay approximate for
  // astral text. A capability difference between the libraries, not a defect in one generator.
  k === 'c_char';

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
    libs: ['zod'],
    mods: { zod: () => import('./gen/mysql/zod/matrix.zod.js') } as Record<string, () => Promise<any>>,
  },
  {
    name: 'sqlite',
    table: sqTable,
    libs: ['zod'],
    mods: { zod: () => import('./gen/sqlite/zod/matrix.zod.js') } as Record<string, () => Promise<any>>,
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

      for (const k of Object.keys(oShape)) {
        const o = safeField(lib, official, k);
        const m = safeField(lib, mine, k);
        if (!o && !m) continue;
        if (!m) {
          if (allowed(libName, k)) { waived++; continue; }
          rows.push(`        ${k}: official has it, DRZL omits it`);
          continue;
        }
        if (!o) {
          if (allowed(libName, k)) { waived++; continue; }
          rows.push(`        ${k}: DRZL has it, official omits it`);
          continue;
        }
        const looser: string[] = [];
        const tighter: string[] = [];
        for (const [label, x] of POOL) {
          const a = safeOk(lib, o, x);
          const b = safeOk(lib, m, x);
          if (a !== b) (b ? looser : tighter).push(label);
        }
        if (!looser.length && !tighter.length) continue;
        if (allowed(libName, k)) { waived++; continue; }
        rows.push(
          `        ${k}:` +
            (looser.length ? `\n          DRZL accepts, official rejects: ${looser.join(', ')}` : '') +
            (tighter.length ? `\n          DRZL rejects, official accepts: ${tighter.join(', ')}` : '')
        );
      }

      console.log(
        `    ${d.name.padEnd(7)} ${libName.padEnd(8)} ${mode.padEnd(7)} ` +
          `${Object.keys(oShape).length} cols  ${rows.length ? 'DIFFERS' : 'parity'}` +
          `${waived ? ` (${waived} waived)` : ''}`
      );
      if (rows.length) {
        console.log(rows.join('\n'));
        findings += rows.length;
      }
    }
  }

  // Pass 2, on the dialect that has all four generators.
  if (d.libs.length === 4) {
    const oShape = OFFICIAL.zod.select(d.table as never).shape;
    const disagreements: string[] = [];
    for (const k of Object.keys(oShape)) {
      if (CROSS_ALLOWED(k)) continue;
      const fields: Record<string, any> = {};
      for (const lib of d.libs) fields[lib] = safeField(LIBS[lib], loaded[lib].SelectmatrixSchema, k);
      const absent = Object.entries(fields).filter(([, f]) => !f).map(([n]) => n);
      if (absent.length) {
        disagreements.push(`        ${k}: missing from ${absent.join(', ')}`);
        continue;
      }
      for (const [label, x] of POOL) {
        const verdicts = d.libs.map((n) => [n, safeOk(LIBS[n], fields[n], x)] as const);
        const yes = verdicts.filter(([, r]) => r).map(([n]) => n);
        const no = verdicts.filter(([, r]) => !r).map(([n]) => n);
        if (yes.length && no.length) {
          disagreements.push(`        ${k} on ${label}: ${yes.join('/')} accept, ${no.join('/')} reject`);
        }
      }
    }
    if (disagreements.length) {
      console.log('    the four generators disagree with each other:');
      console.log(disagreements.join('\n'));
      findings += disagreements.length;
    } else {
      console.log('    all four generators agree with each other on every column and value');
    }
  }
}

if (findings) {
  console.error(`FAIL: ${findings} parity finding(s). A generated schema looser than the`);
  console.error('      first-party module accepts rows the database will reject.');
  process.exit(1);
}
PARITY_HARNESS

# drizzle-orm is pinned: the parity target is a specific release, and a floating one would turn
# an upstream change into a mysterious failure here rather than a deliberate re-measurement.
npm install --no-audit --no-fund --loglevel=error \
  "$TARS"/*.tgz drizzle-orm@1.0.0-rc.4 zod valibot arktype @sinclair/typebox tsx >/dev/null

for dialect in pg mysql sqlite; do
  case "$dialect" in
    pg)     schema=src/schema.ts;        libs="zod valibot arktype typebox" ;;
    mysql)  schema=src/schema-mysql.ts;  libs="zod" ;;
    sqlite) schema=src/schema-sqlite.ts; libs="zod" ;;
  esac
  gens=""
  for lib in $libs; do gens="$gens    { kind: '$lib', path: 'src/gen/$dialect/$lib' },"$'\n'; done
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
done

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
report_size src/gen/pg/zod      zod      420  || size_fail=1
report_size src/gen/pg/valibot  valibot  540  || size_fail=1
report_size src/gen/pg/arktype  arktype  240  || size_fail=1
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

const POOL: [string, unknown][] = [
  ['0', 0], ['1.5', 1.5], ['-1', -1], ['40000', 40000], ['2147483648', 2147483648],
  ['1e9', 1e9], ['1e300', 1e300], ['9007199254740993', 9007199254740993],
  ['NaN', NaN], ['Infinity', Infinity],
  ["''", ''], ["'hello'", 'hello'], ['300-char', 'x'.repeat(300)],
  // Astral-plane characters, where a code-point count and a UTF-16 `.length` disagree. Postgres
  // counts *characters* for `varchar(n)`, so a 3-emoji string fits in a `varchar(5)` that every
  // library's `.max(5)` refuses. Without these in the pool the gate cannot see that.
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
import { DDL } from './ddl';
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
import * as v from 'valibot';
import { type } from 'arktype';
import { Value } from '@sinclair/typebox/value';
import { createUpdateSchema } from 'drizzle-orm/zod';
import { checked } from './schema';

const db = new PGlite();
await db.exec(DDL);

const official: any = createUpdateSchema(checked);
const drzl: any = drzlUpdate;

/**
 * Values chosen to sit on both sides of every bound, since a probe pool that never lands on a
 * boundary cannot tell `>` from `>=`. That distinction is most of what a CHECK says.
 */
const PROBES: Record<string, unknown[]> = {
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
const RUNNERS: Record<string, (o: unknown) => boolean> = {
  zod: (o) => drzlUpdate.safeParse(o).success,
  valibot: (o) => v.safeParse(vUpdate as never, o).success,
  arktype: (o) => !((aUpdate as any)(o) instanceof type.errors),
  typebox: (o) => Value.Check(tUpdate as never, o),
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
  console.error('\n    FAIL: the four generators disagree about a CHECK:');
  for (const line of split.slice(0, 20)) console.error(line);
  console.error('\n    One of them is dropping a constraint the parser read.');
  await db.close();
  process.exit(1);
}
console.log('    all four generators agree on every CHECK probe');

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
cd "$APP"

echo "OK: $count packages packed, installed into an empty project, generated, and the output"
echo "    typechecks under bundler, node16 and nodenext, and validates at least as strictly as"
echo "    the first-party drizzle-orm validator modules across three dialects and three modes,"
echo "    checked against a real Postgres, a real SQLite and, where MYSQL_URL is set, a real"
echo "    MySQL, with applyDefaults compared against what the database writes, and analyzed with"
echo "    no column left unnamed on either drizzle-orm major."
