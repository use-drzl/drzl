cp "$HARNESS/openapi-valid.ts" src/openapi-valid.ts

echo "==> the emitted OpenAPI document against the specification"
if ! npx tsx src/openapi-valid.ts; then
  echo "FAIL: the emitted OpenAPI document is not a valid OpenAPI document." >&2
  exit 1
fi
