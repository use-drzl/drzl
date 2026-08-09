cp "$HARNESS/check-old.ts" check-old.ts

echo "==> the analyzer keeps its column types on drizzle-orm 0.4x"
if ! npx tsx check-old.ts; then
  echo "FAIL: the analyzer loses column types on drizzle-orm 0.4x." >&2
  exit 1
fi
