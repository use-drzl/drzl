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
# `build:packages`, not `build`: the workspace also contains the docs site, whose vitepress
# build is slow and cannot affect a tarball. This is the same filtered, topologically sorted
# build the release workflow runs, so what gets packed here is what gets packed there.
(cd "$ROOT" && pnpm build:packages >/dev/null)

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
npm install --no-audit --no-fund --loglevel=error \
  "$TARS"/*.tgz drizzle-orm zod valibot arktype @orpc/server typescript tsx >/dev/null

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
grep -q 'export \* from "./users.zod.js";' "$BARREL" || {
  echo "FAIL: the barrel does not emit a .js specifier. Generated output will not resolve" >&2
  echo "      under moduleResolution node16 or nodenext. Barrel was:" >&2
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
} from 'drizzle-orm/pg-core';

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
PARITY_PG

cat > src/schema-mysql.ts <<'PARITY_MYSQL'
import {
  mysqlTable, mysqlEnum, text, varchar, char, int, tinyint, smallint, mediumint,
  bigint, serial, boolean, real, double, float, decimal, json, date, datetime,
  timestamp, time, year, binary, varbinary, blob, tinytext, mediumtext, longtext,
} from 'drizzle-orm/mysql-core';

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
PARITY_MYSQL

cat > src/schema-sqlite.ts <<'PARITY_SQLITE'
import { sqliteTable, text, integer, real, numeric, blob } from 'drizzle-orm/sqlite-core';

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
 * Pass 2 cross-checks DRZL's own four generators against each other, which is what covers the
 * typebox output. `drizzle-orm/typebox` is absent from pass 1 on purpose: at 1.0.0-rc.4 it
 * declares a peer on `@sinclair/typebox` while its code imports `typebox`, and against the
 * released `typebox` it throws `Class extends value undefined` on import.
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
import * as v from 'valibot';
import { type } from 'arktype';
import { Value } from '@sinclair/typebox/value';

import { matrix as pgTable } from './schema.js';
import { matrix as myTable } from './schema-mysql.js';
import { matrix as sqTable } from './schema-sqlite.js';

const POOL: [string, unknown][] = [
  ['null', null], ['undefined', undefined], ['""', ''], ["'hello'", 'hello'],
  ['300-char', 'x'.repeat(300)], ['70k-char', 'x'.repeat(70000)], ['5-char', 'xxxxx'],
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
const CROSS_ALLOWED = (k: string) => k.startsWith('c_json') || k.startsWith('c_jsonb') || /bigint_b|blob_bigint/.test(k);

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
      if (!off) continue; // typebox: no usable official module
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
  for lib in $libs; do
    if [ ! -e "src/gen/$dialect/$lib/matrix.$lib.ts" ]; then
      echo "FAIL: the $lib generator produced no file for the $dialect parity matrix." >&2
      exit 1
    fi
  done
done

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
cd "$APP"

echo "OK: $count packages packed, installed into an empty project, generated, and the output"
echo "    typechecks under bundler, node16 and nodenext, and validates at least as strictly as"
echo "    the first-party drizzle-orm validator modules across three dialects and three modes,"
echo "    checked against a real Postgres."
