# ---------------------------------------------------------------------------------------------
# `drzl doctor`, against the analyzer it is reporting on.
#
# A doctor that under-reports is worse than none, because it tells the reader their schema is
# fine when it is not, and nothing about a green run would say otherwise. So the assertion is not
# that doctor prints something; it is that the set of columns doctor calls untypeable is exactly
# the set the analyzer raised `DRZL_ANL_UNKNOWN_COLUMN` for. A filter that drifts on either side
# fails here rather than in a user's schema.
#
# Both directions matter and neither is the obvious one. Doctor missing a column the analyzer
# flagged is silence about a real defect. Doctor naming a column the analyzer did not is a report
# that sends someone to fix nothing, which is how a tool stops being read.
echo "==> doctor names exactly the columns the analyzer cannot type"
# Its own fixture, because the app schema has nothing wrong with it. Run against that, both sets
# are empty, the equality holds trivially and the stage reports success having compared nothing.
# That is the failure this gate has been bitten by more than any other, so the assertion below
# refuses an empty set as well as a mismatched one.
#
# A `customType` is the honest case to build it from: it has no runtime shape any analyzer can
# read, on either drizzle major, so it is untypeable by construction rather than by omission and
# no future arm will quietly fix it and make this vacuous again.
cp "$FIXTURES/doctor-fixture.schema.ts" src/db/doctor-fixture.ts

npx drzl analyze src/db/doctor-fixture.ts --json > "$WORK/analyze.json"
npx drzl doctor src/db/doctor-fixture.ts --json > "$WORK/doctor.json"

node "$HARNESS/doctor-vs-analyzer.mjs" "$WORK/analyze.json" "$WORK/doctor.json" \
  || { echo "FAIL: doctor and the analyzer disagree about which columns cannot be typed." >&2; exit 1; }

# The exit codes are the contract a CI job depends on, and nothing else here reads one from the
# packed artifact. `doctor` reports without failing a pipeline, `--strict` turns findings into a
# failure, and an unreadable schema is a different answer from either.
doctor_code() { npx drzl doctor "$@" >/dev/null 2>&1; echo $?; }
got_plain=$(doctor_code src/db/doctor-fixture.ts)
got_missing=$(doctor_code no-such-schema.ts)
if [ "$got_plain" != 0 ]; then
  echo "FAIL: drzl doctor exited $got_plain on a readable schema. A doctor that fails a build" >&2
  echo "      for reporting is a doctor nobody leaves switched on." >&2
  exit 1
fi
if [ "$got_missing" != 1 ]; then
  echo "FAIL: drzl doctor exited $got_missing on a schema that does not exist, expected 1." >&2
  exit 1
fi
echo "    exit codes: 0 on a readable schema, 1 on one it cannot read"
