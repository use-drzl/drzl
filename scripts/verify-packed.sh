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
cat > "$APP/src/db/schema.ts" <<'SCHEMA'
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  email: text('email').notNull(),
  balance: real('balance'),
});

export const posts = sqliteTable('posts', {
  slug: text('slug').primaryKey(),
  title: text('title').notNull(),
  authorId: integer('author_id'),
});
SCHEMA

cat > "$APP/drzl.config.ts" <<'CONFIG'
export default {
  schema: './src/db/schema.ts',
  generators: [{ kind: 'zod', path: './src/generated/zod' }],
};
CONFIG

cd "$APP"
npm init -y >/dev/null
# npm rather than pnpm on purpose: a consumer is unlikely to share this repo's package manager,
# and npm's flat layout is the harsher test of whether `dependencies` are actually declared.
npm install --no-audit --no-fund --loglevel=error \
  "$TARS"/*.tgz drizzle-orm zod typescript >/dev/null

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

echo "OK: $count packages packed, installed into an empty project, generated, and the output"
echo "    typechecks under bundler, node16 and nodenext."
