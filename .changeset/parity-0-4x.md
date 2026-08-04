---
---

Test-only. Adds the parity comparison for the drizzle-orm 0.4x path, and changes no source:
`git diff master..HEAD -- 'packages/*/src'` is empty.

The differential parity stage installs `drizzle-orm@1.0.0-rc.4`, so its 36 parity lines said
nothing about 0.45.2, which is what `npm install drizzle-orm` still serves. The 54 analyzer fields
filed by the cross-major diff were filed precisely because no gate could show that changing the
0.4x path was right.

That gate now exists. The 0.4x tree the cross-major stage already stands up also installs
`drizzle-zod@0.8.3`, `drizzle-valibot@0.4.2`, `drizzle-arktype@0.1.3` and `drizzle-typebox@0.3.3`,
generates all four libraries for all three dialects, and pushes the same pool of values through
DRZL's output and the first-party one column by column: 972 comparisons across 36 pairings, none of
which had any coverage on this major before. The pool now lives in one file both passes import, so
a value added for one major is answered by the other.

Twenty-two columns are known to differ and are carried in an explicit ledger, each stating its
libraries, its modes, what DRZL emits, what official emits, and which defect it is. Eight were
already filed by the cross-major diff. Fourteen are new, and they are new mostly because that
diff's fixture is Postgres plus four MySQL text columns, so no MySQL float, no MySQL binary, no
MySQL year and no SQLite column of any kind had ever been measured against a first-party validator
on 0.4x.

The ledger is asserted in both directions: a difference in neither map fails the stage, and an
entry that suppresses nothing, or whose libraries or modes have moved, fails it too. So fixing one
of these defects fails the gate until its entry goes, rather than passing quietly.
