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
  "$TARS"/*.tgz drizzle-orm@"$DRIZZLE_0_4X" zod tsx >/dev/null

# The same tarballs and the other major. `zod` because the generate step below runs in the 0.4x
# tree; this one only analyzes, and installing the same set keeps the two trees differing in
# exactly one thing.
# --legacy-peer-deps for the same reason as the parity install above: this tree also holds the
# generator-effect tarball beside drizzle rc.4, whose optional effect peers are disjoint.
( cd "$NEW" && npm init -y >/dev/null 2>&1 && npm install --no-audit --no-fund --loglevel=error --legacy-peer-deps \
  "$TARS"/*.tgz drizzle-orm@"$DRIZZLE_V1" zod tsx >/dev/null )

# Written once and analyzed under both majors, so the comparison below is about the analyzer
# rather than about two schemas that happen to differ. Every type here exists in both.
cp "$FIXTURES/cross-major.schema.ts" src/schema.ts

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
# `maxBytes`, which was false, and the fixture below is what refutes it. Four columns and a varchar key,
# all of which import on both majors.
cp "$FIXTURES/mysql-text.schema.ts" src/mysql-text.ts

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
sed -e 's/ bytea,//' -e '/c_bytea/d' -e '/bigint_s/d' "$PARITY/src/schema.ts" > src/matrix.ts
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
# The mode-string bigint columns need their own check, because they fail differently from bytea:
# 0.4x has no string mode and does not complain about one, it builds the same PgBigInt64 the
# bigint mode builds. So a delete that stopped matching would leave this pass comparing a
# bigint-wire column under the name the v1 pass uses for a string-wire one, with both passes
# green. The cmp above cannot catch that: bytea already satisfies it.
if grep -q 'bigint_s' src/matrix.ts; then
  echo "FAIL: a mode-string bigint column survived the edit above. 0.4x builds it as the bigint" >&2
  echo "      mode without complaint, so this pass would compare a different column than the v1" >&2
  echo "      pass does, under the same name, and both would still pass." >&2
  exit 1
fi

cp "$FIXTURES/old-major.drzl.config.ts" drzl.config.ts

echo "==> generating against drizzle-orm 0.4x"
npx drzl generate --config drzl.config.ts >/dev/null
