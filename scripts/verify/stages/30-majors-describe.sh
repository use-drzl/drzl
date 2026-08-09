cp "$HARNESS/describe-columns.ts" describe-columns.ts

echo "==> describing the same three schema files under both drizzle-orm majors"
cp src/schema.ts src/matrix.ts src/mysql-text.ts "$NEW/src/"
cp describe-columns.ts "$NEW/describe-columns.ts"
npx tsx describe-columns.ts src/schema.ts src/matrix.ts src/mysql-text.ts > "$WORK/cols-0.4x.json"
( cd "$NEW" && npx tsx describe-columns.ts src/schema.ts src/matrix.ts src/mysql-text.ts ) > "$WORK/cols-v1.json"

cp "$HARNESS/cross-major.ts" cross-major.ts

OLD_JSON="$WORK/cols-0.4x.json" NEW_JSON="$WORK/cols-v1.json" npx tsx cross-major.ts | tee -a "$WORK/printed.log" || {
  echo "FAIL: the analyzer is not consistent across drizzle-orm majors." >&2
  exit 1
}
