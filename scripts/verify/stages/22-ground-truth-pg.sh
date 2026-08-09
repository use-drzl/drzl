echo "==> ground truth: the emitted schemas against a real Postgres"
# Everything above compares DRZL to another library's opinion. Both can be wrong about the same
# column and neither is the authority. PGlite is a real Postgres compiled to wasm, so each probe
# value goes through an actual INSERT and the database answers directly.
#
# What is gated is narrow on purpose: DRZL must never disagree with Postgres where the official
# module agrees. A validator is deliberately stricter than a coercing driver, so most
# disagreements are correct and gating on them would be noise. Disagreeing where official does
# not means DRZL alone is wrong, which is what an over-strict check looks like. Candidate format
# patterns for date, time, macaddr and inet were all discarded because this caught them turning
# away values Postgres accepts.
cp "$HARNESS/ddl.ts" src/ddl.ts

cp "$HARNESS/probes.ts" src/probes.ts

cp "$HARNESS/ground-truth.ts" src/ground-truth.ts

# @electric-sql/pglite is installed with the rest of this tree, far above, because the parity pass
# needs a Postgres too now. It had its own install line here, which was a second install of the
# same package into the same tree.
if ! npx tsx src/ground-truth.ts | tee -a "$WORK/printed.log"; then
  echo "FAIL: a generated schema disagrees with Postgres itself." >&2
  exit 1
fi
