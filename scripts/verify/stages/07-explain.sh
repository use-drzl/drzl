# ---------------------------------------------------------------------------------------------
# `drzl explain`, against the `drzl doctor` that reports the same silences.
#
# The two commands answer the same question from opposite ends and share none of the code that
# answers it: `doctor` calls `parseCheck` itself and filters the analyzer's issues, while `explain`
# reads `tableConstraints`, which is what the emitted constraint ledger is built from. So a drift
# in either one is a drift between them, and this is the only place the two are compared.
#
# The assertion is not that `explain` prints something. It is that the things it lists as not
# understood about `invoices` are exactly the things `doctor` reports about `invoices`: the same
# untypeable column, and the same CHECK that no generator translates. `explain` going quiet about
# either is the silence both commands exist to prevent, and a green run would not otherwise say so.
echo "==> explain and doctor agree about what is not understood"
npx drzl explain invoices -s src/db/doctor-fixture.ts --json > "$WORK/explain.json"

node "$HARNESS/explain-vs-doctor.mjs" "$WORK/doctor.json" "$WORK/explain.json" \
  || { echo "FAIL: explain and doctor disagree about what DRZL could not use." >&2; exit 1; }

# The exit codes are what a script reads. A table that is there, a table that is not, and a name
# that reaches two tables are three different answers, and only the packed artifact can be asked.
cp "$FIXTURES/two-schemas.schema.ts" src/db/two-schemas.ts

explain_code() { npx drzl explain "$@" >/dev/null 2>&1; echo $?; }
got_found=$(explain_code invoices -s src/db/doctor-fixture.ts)
got_missing=$(explain_code no_such_table -s src/db/doctor-fixture.ts)
got_ambiguous=$(explain_code users -s src/db/two-schemas.ts)
if [ "$got_found" != 0 ] || [ "$got_missing" != 1 ] || [ "$got_ambiguous" != 1 ]; then
  echo "FAIL: drzl explain exited $got_found on a table that exists, $got_missing on one that" >&2
  echo "      does not, and $got_ambiguous on a name reaching two tables. Expected 0, 1, 1." >&2
  exit 1
fi
echo "    exit codes: 0 explained, 1 no such table, 1 ambiguous name"
rm -f src/db/two-schemas.ts
rm -f src/db/doctor-fixture.ts
