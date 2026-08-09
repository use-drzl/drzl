cp "$HARNESS/json-schema-valid.ts" src/json-schema-valid.ts

echo "==> the emitted JSON Schema compiles as a schema"
if ! npx tsx src/json-schema-valid.ts; then
  echo "FAIL: the emitted JSON Schema output is not something a validator can read." >&2
  exit 1
fi
