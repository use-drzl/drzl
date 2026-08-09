echo "==> round trip: the Select schemas against what Postgres hands back"
cp "$HARNESS/round-trip.ts" src/round-trip.ts

# The stage prints its own verdict and exits non-zero on it. This line says only that it did not
# finish, because a crash is not a verdict: earlier runs died on a PGlite protocol error and on a
# connection pointed at an empty database, and both were announced here as a Select schema
# rejecting a row, which is a specific accusation neither run was in a position to make.
if ! npx tsx src/round-trip.ts | tee -a "$WORK/printed.log"; then
  echo "FAIL: the Select round trip did not pass. Its own output above says why." >&2
  exit 1
fi
