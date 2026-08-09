# The heading the comparison used to run under was "generated output size", four headings after
# the one that announced it. The invocation itself has not moved: the matrix typecheck above
# runs first on purpose, so a compile error is reported as a compile error.
echo "==> differential parity against the official drizzle-orm validators"
if ! npx tsx src/parity.ts | tee -a "$WORK/printed.log"; then
  echo "FAIL: DRZL's generated schemas diverge from the official drizzle-orm validators." >&2
  exit 1
fi
