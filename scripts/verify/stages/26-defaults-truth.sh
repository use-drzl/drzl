cp "$HARNESS/defaults-truth.ts" src/defaults-truth.ts

echo "==> ground truth: applyDefaults against what a real Postgres writes"
if ! npx tsx src/defaults-truth.ts | tee -a "$WORK/printed.log"; then
  echo "FAIL: applyDefaults does not reproduce the database's defaults." >&2
  exit 1
fi
