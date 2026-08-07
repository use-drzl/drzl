---
'@drzl/generator-arktype': patch
---

The ArkType generator refuses `NaN` on a column that stores none, through the optional and nullable
arms where it used to let one through.

`NaN` is a value the schema has to answer for per dialect rather than once. Postgres genuinely
stores it in a `real`, a `double precision` and a `numeric`, and hands it back on SELECT, so all
four generators accept it there and that does not change. A real MySQL 8.4 stores it nowhere:
`float` and `double` refuse it outright, and `decimal(10,2)` silently writes `0.00` with an empty
`SHOW WARNINGS`. SQLite turns it into NULL. The analyzer already says which is which, with
`allowsNaN` on the column, and until now the ArkType generator only read that flag in the direction
that adds `NaN` and never in the direction that keeps it out.

**The mechanism was ArkType's, and it was invisible in the emitted text.** A bounded number stops
refusing `NaN` the moment it becomes one branch of a union beside a unit branch, while still
refusing an infinity and everything out of range. Both wrappers this generator emits are that
union. `(min <= number <= max | null)` for a nullable column is one, and it accepts `NaN` on the
object itself. The `?` on an optional key is the other: the object still refuses a present `NaN`,
but `schema.get(key)` hands back `T | undefined`, and that type accepts it. Since `update` is the
mode where every key is optional, one MySQL `float` column disagreed with the other three
generators there and agreed with them in `select` and `insert`.

`NaN` alone, because it is the one value that compares false against both ends of a range. Integer
columns were never affected: `number.integer` states integrality as a predicate, which `NaN` fails
inside a union exactly as it does outside one.

**What changes.** On a column the analyzer marks as storing no `NaN`, which is every MySQL,
SingleStore and SQLite float and every `numeric` in number mode outside Postgres, the emitted
ArkType field now carries a `.narrow` refusing `NaN`, in every mode and through both wrappers. The
narrow reaches array elements the same way every other narrow in this generator does, and an
applied default moves onto the Type beside it rather than being dropped.

**Postgres does not move.** A `real`, a `double precision` and a `numeric` in number mode still
accept `NaN` and, where the width allows, both infinities, in `select`, `insert` and `update`,
nullable or not. No Postgres column gains the narrow, so the generated Postgres output is unchanged
byte for byte.

Two things this deliberately does not change. An unbounded MySQL or SQLite `double` still accepts
both infinities, because ArkType's bare `number` does and that is a separate, already-documented
divergence from zod and TypeBox rather than this leak: it is present in `select` and `insert` too,
where nothing is optional. And a `decimal` column is a string in Drizzle's number-free mode and is
governed by its pattern, not by this.

The zod, valibot, TypeBox and JSON Schema generators do not change. All four already refused `NaN`
on these columns.
