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

Every entry, in both passes, pins the exact set of probes it covers: which values DRZL accepts and
official refuses, and which the other way. A difference in neither map fails the stage, an entry
that suppresses nothing fails it, and an entry whose divergence has changed at all fails it with
the measured signature printed. A waiver that asserted only "something differs here" absorbed
regressions on its own column: a `char(4)` schema with its length check deleted, a `TINYTEXT`
schema tightened from 255 bytes to 3, and a `m_tinytext` regression on the v1 side all passed
before this and are all named now.

Two things the pool could not see are now measured. A probe that crashes is no longer scored as a
rejection: official's TypeBox module emits `Type.RegExp` with a `maxLength` for a few columns and
TypeBox reads `value.length` with no type guard, so `null` crashes the check instead of failing it.
Eighteen such probes on v1 and six on 0.4x were being counted as official rejections; they are now
recorded and asserted as crashes. And the MySQL text family reported parity on both majors while
four filed fields sat on it, because no string in the pool separated a byte budget from a character
count. Which caps a pool can separate is arithmetic: UTF-8 spends at most 3 bytes per UTF-16 unit,
so a separating probe needs more than cap/3 units. The pool now carries 100 emoji for the 255 byte
caps and 22000 CJK characters for the 65535 byte ones, `mediumtext` needs a 10.7 MiB string and is
measured on its own, and `longtext` needs more units than V8 will put in a string, so it has no
probe at all and the stage says so. A real MySQL 8 settles every direction: `tinytext`, `text` and
`blob` all refuse what official accepts.

Both passes are now held to the same standard, which took three rounds because each one closed a
hole on the pass being built and left it open on the pass beside it. The v1 waivers carry `libs`,
`modes` and a pairing count as well as the signature, so a regression confined to insert and update
cannot hide behind a matching select; the v1 pass has the byte-cap stage, which is where its
`m_mediumtext` divergence was found sitting under a green parity line; it asserts its own resolved
`drizzle-orm` major and a written-out comparison total, neither of which it had; and the seven
cross-generator waivers carry signatures too, so the line claiming all four generators agree on
every column and value now says how many documented differences it is standing on. That line was
false at HEAD: seven columns disagree on five values each, and every row was being discarded unread.
