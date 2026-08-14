---
'@drzl/cli': minor
---

Skip a `watch` rebuild that would change nothing.

Every save re-ran every generator over every table, and that is most of what a rebuild costs.
Measured on a warm process: about 6.9 ms per table of generation on top of a fixed cost, so a sixty
table schema spends roughly 450 ms regenerating and a larger one proportionally more. Analysis is
around 35 ms of that, so re-analysing on every save is not the part worth avoiding.

Plenty of saves change nothing a generator reads. A comment, a reformat, an edit to a helper beside
the tables, or a column name typed and deleted again all re-trigger the watcher and all produce
byte-identical output. `EmitPlan` already declines to *write* an unchanged file, so nothing lands on
disk either way; what it does not avoid is producing the content to compare, which is the expensive
half.

`watch` now fingerprints what a generator reads, which is the dialect, tables, enums and relations,
together with the generator configuration, and skips the rebuild when both match the previous one.
`issues` is deliberately excluded: a warning changes what `doctor` prints and never changes an
emitted file, so folding it in would make a rebuild that produced identical output look different.
Object keys are sorted before hashing, because the analyzer builds its objects by walking drizzle's
own structures and two runs are not guaranteed to agree on key order.

The first build is never skipped. A watcher that started, printed its watch list and wrote nothing is
a failure this command has had before, for a different reason.

**This is half of incremental watch, and the changeset says so rather than letting it read as the
whole.** Regenerating only the tables that moved would need every generator to accept a subset of the
analysis while still emitting a complete barrel, which is a change to the contract all twenty-seven
of them implement. Skipping a rebuild that would change nothing needs no such thing, and covers the
case that happens most while editing.
