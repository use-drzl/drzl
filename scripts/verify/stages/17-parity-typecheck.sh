# ---------------------------------------------------------------------------------------------
# Does the parity matrix output compile?
#
# The typecheck stage far above runs on a two-table users/posts schema with no arrays, no bigint
# and no capped column, so the only generated code this gate ever put through `tsc` was its
# simplest. The 40-column matrix, which exists precisely to hold the awkward types, was generated,
# executed and then thrown away without a compiler ever looking at it.
#
# What that hid: the arktype generator emitted `type("(bigint[] | null)").narrow((v, ctx) => ...
# v >= -9223372036854775808n ...)` for a nullable bigint array, which is TS2365, `>=` cannot be
# applied to `bigint[]`. Every runtime check in this gate passed it, because a narrow that throws
# is caught and read as a rejection, and rejection was the answer for most probe values anyway.
# ---------------------------------------------------------------------------------------------
echo "==> typechecking the parity matrix output"
# Three columns are carved out of this stage, not two modules, for one defect that predates the
# branch. Each claim below was measured, after two earlier attempts at this comment asserted
# mechanisms that turned out not to exist.
#
# `c_numeric` and `c_decimal` on Postgres, and `m_decimal` on MySQL, each fail TS2589 on their own,
# in a file holding nothing else. The arktype generator states a numeric format as a bare regex
# literal inside the type expression, and that literal is around 200 characters that ArkType parses
# in the type system. It is the one emitted construct expensive enough to exhaust the instantiation
# budget by itself.
#
# What it is *not*, each checked rather than assumed:
#
#   - Not this branch's doing. Rewriting the emitted pg file back to the exact form the generator
#     produced before the bigint bound and before the array fix reproduces it at the same position.
#   - Not the narrows. Stripping every `.narrow(...)` from the pg matrix, leaving the same 40
#     fields, fails identically at (7,40).
#   - Not the number of fields. Every one of the 40 pg fields compiles alone except those two, and
#     the first 10 compile together with or without their narrows.
#   - Not the table size. sqlite's matrix is clean because it has no numeric-format column, not
#     because it has 14 columns: SQLite `numeric` carries no format and emits a plain `"string"`.
#
# So the repair is to stop putting a 200-character regex in the type expression, not to change how
# a whole-table object is emitted. That is reported separately and not done here.
#
# The carve-out is by column, so the other 38 pg and 28 mysql columns are still compiled: the two
# modules are copied with exactly those field lines dropped, and the copy is what this stage
# checks.
#
# Two things have to stay true of an exclusion, and only the first of them used to be checked:
# that it still covers what it says, and that it is still needed at all. The inline line count
# below is the first. The probes are the second, and they are the reason this is not a waiver that
# outlives its defect: each carved column is put back on its own, and the result has to still fail
# to compile. Simulating the generator fix, by making those three columns emit `"string"`, used to
# leave them silently un-typechecked for ever with the stage printing that everything compiles.
mkdir -p src/gen-tsc src/carve-probe
node "$HARNESS/carve-matrix.mjs"
# The originals are excluded because the copies stand in for them, and their barrels with them.
# Those barrels are four re-export lines on pg and three on mysql, and the copies cover the modules
# they name. What is given up is narrow and worth saying: the barrel is no longer the thing that
# pulls its modules in here, so a barrel line naming a module that does not exist would not be
# caught by this stage.
if ! npx tsc -p tsconfig.gen.json; then
  echo "FAIL: the parity matrix output does not compile under tsc --strict." >&2
  echo "      Generated code that does not typecheck is not usable output, however it behaves" >&2
  echo "      at runtime." >&2
  exit 1
fi
echo "    every generator's matrix output compiles under --strict, module nodenext"

# The other direction: does each carved column still earn its carve?
#
# A count of removed lines says the exclusion still matches the emitted shape. It says nothing
# about whether the defect is still there, so the day the generator stops putting a regex in the
# type expression, these columns would stay out of the typecheck for ever and this stage would go
# on printing that everything compiles. That is the same stale-waiver shape as the cross-generator
# list further up, which had exactly this hole in the opposite direction.
#
# Compiled one at a time because the question is per column and a compilation answers per run. A
# combined run over all three probes gives one exit code for the union of them, which is nonzero
# while any single column still fails, so the one that had been fixed would be masked by the two
# that had not. That is the whole point of the check, so it cannot be run in a form that cannot
# express the answer. It is not about errors going unreported: this compiler names all three.
#
# The number of probes is asserted against what the carve script wrote, and each probe's output has
# to actually contain TS2589. Both because "no news is good news" is how this check would otherwise
# read an empty directory and an unrelated compile error alike: an unexpanded glob makes tsc fail
# on a path that does not exist, and any nonzero exit used to count as proof the carve was earning
# its place, so a genuinely broken column carved out of the main compile was certified by the
# guard meant to police it.
expected_probes=$(cat carve-manifest.txt)
actual_probes=$(find src/carve-probe -name '*.ts' | wc -l)
if [ "$actual_probes" != "$expected_probes" ]; then
  echo "FAIL: $actual_probes carve probe(s) on disk, $expected_probes expected from CARVED." >&2
  echo "      This check cannot report on a column it never compiled." >&2
  exit 1
fi
carve_dead=0
for probe in $(find src/carve-probe -name '*.ts' | sort); do
  # `--pretty false`, because the branch below matches `error TS2589` as one contiguous string and
  # a colourising tsc puts an escape sequence between the two words. In a terminal that sets
  # FORCE_COLOR this carve-out reported "fails, but not with the TS2589 this carve-out exists for"
  # while printing an error that plainly was TS2589. CI never saw it, since a pipe is not a tty
  # there, so the check was wrong only on the machines a person runs it from. Asking tsc not to
  # colourise is the fix at the cause; setting NO_COLOR in the environment is a fix at the symptom
  # and leaves the next matcher on tsc output exposed.
  out=$(npx tsc --pretty false --strict --noEmit --target es2022 --module nodenext \
      --moduleResolution nodenext --skipLibCheck "$probe" 2>&1 || true)
  case "$out" in
    *"error TS2589"*) ;;
    '')
      echo "FAIL: $probe compiles, so that column no longer needs carving out of the typecheck." >&2
      echo "      Delete it from CARVED above rather than leaving a column excluded for a defect" >&2
      echo "      that has been fixed." >&2
      carve_dead=1
      ;;
    *)
      echo "FAIL: $probe fails, but not with the TS2589 this carve-out exists for:" >&2
      echo "$out" | head -5 >&2
      echo "      That error is being hidden from the main typecheck by an exclusion written for" >&2
      echo "      a different defect. Fix it, or carve it out deliberately and say so." >&2
      carve_dead=1
      ;;
  esac
done
[ "$carve_dead" = 0 ] || exit 1
echo "    all $expected_probes carved column(s) still fail with TS2589, so the carve-out is earning it"
