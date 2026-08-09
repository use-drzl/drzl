# ---------------------------------------------------------------------------------------------
# The same differential parity as the stage near the top of this gate, on the other major.
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

cp "$HARNESS/parity-pool.ts" src/pool.ts

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


cp "$HARNESS/parity-0-4x.ts" parity-0-4x.ts

if ! npx tsx parity-0-4x.ts | tee -a "$WORK/printed.log"; then
  echo "FAIL: DRZL's generated validators do not match the official ones on drizzle-orm 0.4x." >&2
  exit 1
fi
cd "$APP"
