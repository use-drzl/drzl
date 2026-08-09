cp "$HARNESS/sqlite-truth.ts" src/sqlite-truth.ts

# `node:sqlite` is still flagged experimental, and its warning is not news here.
echo "==> ground truth: the emitted CHECK constraints against a real SQLite"
if ! npx tsx --disable-warning=ExperimentalWarning src/sqlite-truth.ts | tee -a "$WORK/printed.log"; then
  echo "FAIL: a generated CHECK disagrees with SQLite." >&2
  exit 1
fi

cd "$APP"
