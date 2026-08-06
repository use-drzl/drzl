---
---

Test-only. Adds a fuzzer that builds every column drizzle can build and reports the ones the
analyzer cannot name. Changes no source: `git diff master..HEAD -- 'packages/*/src'` is empty.

Every serious analyzer defect fixed this month was a column that came back `unknown`, or one typed
as something the driver never produces: arrays, enums, `point` and `line`, `binary`, the decimal
modes, gel's temporal family, the mssql and cockroach boolean and string families. Each was found
because somebody happened to look at that column.

The builder list is read from drizzle's own exports rather than written down, because a hand-written
list would inherit exactly the blind spot this exists to find. Both majors are covered, since they
describe columns through different mechanisms and most defects lived on one major only. A column
class that no generated column reached is reported as a coverage gap rather than passing silently.

`pnpm --filter @drzl/analyzer fuzz` reports. `fuzz:gate` compares against a recorded baseline and
fails on anything new, and on any baseline entry that stops reproducing so the file cannot rot into
a list of things that used to be wrong.
