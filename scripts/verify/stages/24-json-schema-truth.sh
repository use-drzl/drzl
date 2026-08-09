cp "$HARNESS/json-schema-truth.ts" src/json-schema-truth.ts

echo "==> ground truth: the emitted JSON Schema against a real Postgres"
if ! npx tsx src/json-schema-truth.ts; then
  echo "FAIL: the emitted JSON Schema disagrees with Postgres itself." >&2
  exit 1
fi
