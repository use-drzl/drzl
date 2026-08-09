cp "$HARNESS/checks-truth.ts" src/checks-truth.ts

echo "==> ground truth: the emitted CHECK constraints against a real Postgres"
if ! npx tsx src/checks-truth.ts | tee -a "$WORK/printed.log"; then
  echo "FAIL: a generated CHECK disagrees with Postgres." >&2
  exit 1
fi
