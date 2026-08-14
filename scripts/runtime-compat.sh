#!/usr/bin/env bash
#
# Bun and Deno, against the artefact a consumer installs.
#
# Two surfaces fail independently here. The emitted schemas run inside a user's application, and a
# Hono app on Bun or a Deno worker is exactly the audience the route generators target. The CLI runs
# at build time, and it loads config and schema modules through jiti, calls `fs.globSync`, and
# resolves a formatter through `createRequire`. None of that is exercised by `pnpm -r test`, which
# imports from source and runs only on Node, nor by verify-packed.sh, which runs only on Node.
#
# What this gate is really for is the byte comparison. A developer who generates under Bun and a CI
# job that checks under Node must not disagree, and they did: Bun's resolver answers a missing
# package by installing it from npm, so `@biomejs/biome` was auto-installed mid-generate and
# reformatted the output on a project that had never depended on it. `drzl generate --check` under
# Node then called every file out of date. Nothing else in CI would have noticed, because nothing
# else in CI runs anything on Bun.
#
# Packs what is already built rather than building it, so a local run iterates in seconds. Run
# `pnpm build:packages` first, which is what the CI job does.
#
# Run locally with: bash scripts/runtime-compat.sh   (needs bun and deno on PATH)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
TARS="$WORK/tars"
APP="$WORK/app"
mkdir -p "$TARS" "$APP/src/db"

for tool in bun deno; do
  command -v "$tool" >/dev/null || { echo "FAIL: $tool is not on PATH." >&2; exit 1; }
done
echo "==> runtimes"
echo "    node $(node --version)"
echo "    bun  $(bun --version)"
echo "    deno $(deno --version | head -1)"

echo "==> packing publishable packages"
for dir in "$ROOT"/packages/*/; do
  private="$(node -e "process.stdout.write(String(!!require('$dir/package.json').private))")"
  [ "$private" = "true" ] && continue
  (cd "$dir" && pnpm pack --pack-destination "$TARS" >/dev/null)
done
echo "    packed $(ls "$TARS" | wc -l) package(s)"

# npm rather than pnpm, and an empty project rather than this workspace: a consumer shares neither.
echo "==> installing them into an empty project"
cd "$APP"
npm init -y >/dev/null 2>&1
node -e "
  const fs = require('fs');
  const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  p.type = 'module';
  delete p.main;
  fs.writeFileSync('package.json', JSON.stringify(p, null, 2));
"
npm install --no-audit --no-fund --loglevel=error --legacy-peer-deps \
  "$TARS"/*.tgz drizzle-orm zod valibot arktype @sinclair/typebox effect ajv ajv-formats >/dev/null

# A CHECK constraint and an enum, because those are what a validator can lose while still importing.
cat > src/db/schema.ts <<'SCHEMA'
import { sql } from 'drizzle-orm';
import { check, integer, pgEnum, pgTable, serial, text, varchar } from 'drizzle-orm/pg-core';

export const roleEnum = pgEnum('role', ['admin', 'editor', 'viewer']);

export const authors = pgTable(
  'authors',
  {
    id: serial('id').primaryKey(),
    handle: varchar('handle', { length: 20 }).notNull(),
    email: text('email').notNull(),
    age: integer('age').notNull(),
    role: roleEnum('role').notNull(),
  },
  (t) => [check('author_adult', sql`${t.age} >= 18`)]
);
SCHEMA

# `importExtension: 'ts'` because Deno resolves neither the default `.js` specifiers nor the
# extensionless form without `--unstable-sloppy-imports`, which is what docs/guide/runtimes.md
# tells a Deno reader. Generating with it here is also what keeps that instruction honest.
cat > drzl.config.ts <<'CONFIG'
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: 'src/db/schema.ts',
  outDir: 'src/generated',
  importExtension: 'ts',
  generators: [
    { kind: 'zod', path: 'src/generated/zod' },
    { kind: 'valibot', path: 'src/generated/valibot' },
    { kind: 'arktype', path: 'src/generated/arktype' },
    { kind: 'typebox', path: 'src/generated/typebox' },
    { kind: 'effect', path: 'src/generated/effect' },
    { kind: 'json-schema', path: 'src/generated/json-schema' },
  ],
});
CONFIG

CLI=node_modules/@drzl/cli/dist/cli.js

echo "==> drzl generate under node, bun and deno"
for runtime in node bun deno; do
  rm -rf src/generated
  case "$runtime" in
    node) node "$CLI" generate >/dev/null ;;
    bun) bun "$CLI" generate >/dev/null ;;
    deno) deno run -A "$CLI" generate >/dev/null ;;
  esac
  cp -r src/generated "$WORK/out-$runtime"
  echo "    $runtime generated $(find "$WORK/out-$runtime" -type f | wc -l) file(s)"
done

for runtime in bun deno; do
  if ! diff -r "$WORK/out-node" "$WORK/out-$runtime" > "$WORK/diff-$runtime.txt" 2>&1; then
    echo "FAIL: $runtime emitted different bytes from node." >&2
    echo "      Generated output must not depend on which runtime ran the generator." >&2
    head -40 "$WORK/diff-$runtime.txt" >&2
    exit 1
  fi
  echo "    $runtime output is byte-identical to node"
done

# The file count quoted in docs/guide/runtimes.md, read back and compared against this run.
#
# That paragraph had already rotted once. It described "all 14 generators" and "47 files" long after
# the config above had been cut to six generators, and nothing noticed, because the page credits this
# script with re-measuring it while no gate ever read the page. A number in prose that nothing
# compares is a number that goes stale silently, so this compares it.
#
# Matched with awk on a literal substring rather than a regex: `grep` is ugrep on at least one
# maintainer's machine and rejects patterns GNU grep accepts, and a detector that silently matches
# nothing would pass this check forever.
emitted=$(find "$WORK/out-node" -type f | wc -l | tr -d ' ')
documented=$(awk '
  {
    marker = "the emitted tree is **"
    i = index($0, marker)
    if (i > 0) {
      rest = substr($0, i + length(marker))
      n = ""
      for (j = 1; j <= length(rest); j++) {
        c = substr(rest, j, 1)
        if (c >= "0" && c <= "9") { n = n c } else { break }
      }
      if (n != "") { print n; exit }
    }
  }' "$ROOT/docs/guide/runtimes.md")

if [ -z "$documented" ]; then
  echo "FAIL: no file count found in docs/guide/runtimes.md." >&2
  echo "      This check looks for the literal text 'the emitted tree is **' followed by digits." >&2
  echo "      If that sentence was reworded, reword this matcher with it rather than deleting it." >&2
  exit 1
fi

if [ "$emitted" != "$documented" ]; then
  echo "FAIL: docs/guide/runtimes.md says the emitted tree is $documented files, this run wrote $emitted." >&2
  echo "      Update the page, or the config above changed and the page has not caught up." >&2
  exit 1
fi
echo "    docs/guide/runtimes.md quotes $documented files, which is what this run wrote"

# Importing proves nothing about behaviour, so each generator gets a value it must accept and two it
# must reject. `badRange` is well typed and violates the CHECK constraint, which is what separates
# "the module loaded" from "the schema still validates".
cat > exec-emitted.ts <<'HARNESS'
import * as zodMod from './src/generated/zod/index.ts';
import * as valibotMod from './src/generated/valibot/index.ts';
import * as arktypeMod from './src/generated/arktype/index.ts';
import * as typeboxMod from './src/generated/typebox/index.ts';
import * as effectMod from './src/generated/effect/index.ts';
import * as jsonSchemaMod from './src/generated/json-schema/index.ts';
import * as v from 'valibot';
import { ArkErrors } from 'arktype';
import { Value } from '@sinclair/typebox/value';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const good = { handle: 'alice', email: 'alice@example.com', age: 30, role: 'admin' };
const badType = { handle: 'ab', email: 'x', age: 'not-a-number', role: 'nope' };
const badRange = { ...good, age: 5 };

const runtime = typeof (globalThis as any).Bun !== 'undefined' ? 'bun' : 'deno';

const checks: Record<string, (val: unknown) => boolean> = {
  zod: (val) => (zodMod as any).InsertauthorsSchema.safeParse(val).success,
  valibot: (val) => v.safeParse((valibotMod as any).InsertauthorsSchema, val).success,
  // A failed arktype call returns an ArkErrors instance; a success returns the parsed object.
  arktype: (val) => !((arktypeMod as any).InsertauthorsSchema(val) instanceof ArkErrors),
  typebox: (val) => Value.Check((typeboxMod as any).InsertauthorsSchema, val),
  effect: (val) =>
    ((effectMod as any).StandardInsertauthorsSchema['~standard'].validate(val) as any).issues ===
    undefined,
  'json-schema': (val) => {
    const ajv = new (Ajv2020 as any)({ strict: false });
    (addFormats as any)(ajv);
    return ajv.validate((jsonSchemaMod as any).InsertauthorsSchema, val) === true;
  },
};

let failures = 0;
for (const [name, check] of Object.entries(checks)) {
  for (const [label, val, want] of [
    ['good', good, true],
    ['badType', badType, false],
    ['badRange', badRange, false],
  ] as const) {
    let got: unknown;
    try {
      got = check(val);
    } catch (e) {
      got = 'threw: ' + String((e as any)?.message ?? e);
    }
    if (got !== want) {
      failures++;
      console.error(`FAIL ${runtime} ${name} ${label}: wanted ${want}, got ${got}`);
    }
  }
}
console.log(`    ${runtime}: ${Object.keys(checks).length - failures} generator(s) validating`);
if (failures > 0) process.exit(1);
HARNESS

echo "==> the emitted schemas validate under bun and deno"
bun exec-emitted.ts
deno run -A exec-emitted.ts

# The CLI's own commands, on a runtime that is not Node. `analyze --json` is compared byte for byte
# because it is the analyzer's whole output and the thing every generator is built on.
echo "==> CLI commands under bun and deno"
for runtime in node bun deno; do
  case "$runtime" in
    node) node "$CLI" analyze src/db/schema.ts --json > "$WORK/analyze-$runtime.json" ;;
    bun) bun "$CLI" analyze src/db/schema.ts --json > "$WORK/analyze-$runtime.json" ;;
    deno) deno run -A "$CLI" analyze src/db/schema.ts --json > "$WORK/analyze-$runtime.json" ;;
  esac
done
for runtime in bun deno; do
  if ! cmp -s "$WORK/analyze-node.json" "$WORK/analyze-$runtime.json"; then
    echo "FAIL: drzl analyze --json differs between node and $runtime." >&2
    exit 1
  fi
  echo "    $runtime analyze --json is byte-identical to node"
done
for runtime in bun deno; do
  case "$runtime" in
    bun) bun "$CLI" doctor >/dev/null && bun "$CLI" generate --check >/dev/null ;;
    deno) deno run -A "$CLI" doctor >/dev/null && deno run -A "$CLI" generate --check >/dev/null ;;
  esac
  echo "    $runtime ran doctor and generate --check"
done

echo "==> runtime compatibility holds"
