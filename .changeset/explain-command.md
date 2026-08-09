---
'@drzl/cli': minor
---

`drzl explain <table>`: what DRZL understood about one table

When a generated schema is wrong, nothing said where it went wrong. `drzl analyze` prints the whole
`Analysis` for the whole schema as JSON and points at nothing in it, and `drzl doctor` prints only
the findings, across every table, and is silent about a table that is fine. Neither answers "did
DRZL misread this column, drop this CHECK, or fail to follow this relation".

`drzl explain users` prints, for one table: the resolved TypeScript type and the declared SQL type
per column, with the array depth on the first (a `text[]` reads as `string[]`, not `string`);
nullability, the key, the unique constraints, the foreign keys and the relations; and every measured
fact the validation generators act on, which is the range, whether the values are whole, whether the
column stores `NaN` and the infinities, the declared width or byte cap, the format, the enum
members, the structured shape and the default.

Two sections exist for the silent half. Every declared CHECK is shown **as parsed**, with the
verdict a generated schema gives it and, where nothing enforces it, the shared parser's own reason.
And a "Not understood" section collects, in one place, every CHECK clause nothing enforces, every
column with no known type, and every relation the analyzer could not follow. All three produce a
generated file that exists, compiles and checks less than the database does, with nothing anywhere
saying so.

A fact the generators deliberately do not state is marked and explained rather than listed as
though it were enforced: a `varchar(32)` narrowed by `CHECK (label IN ('a','b'))` never reaches the
schema as a width, and a `defaultNow()` makes the field optional on insert without any schema
stating what it becomes. Those verdicts are read off `tableConstraints` in `@drzl/validation-core`,
which is the same function the emitted constraint ledger is built from, so the report and the
generated modules cannot disagree.

A table is found by its database name, its schema-qualified name (`reporting.users`, and
`public.users` for the default schema) or its TypeScript export name, exact first and then ignoring
case. A name reaching two tables is refused with both of them named rather than resolved silently.
A name reaching none lists the tables there are, with the near miss. A table your config's
`include`/`exclude` removes is still found and still explained, with a line saying the config
removes it, because that is the answer to "why is there no file for this table".

With no table argument it prints one line per table with a count of what `explain` would report as
not understood for each, which on a large schema is what says where to look.

`--json` writes one document with the envelope merged in at the top level and the same information
under stable keys, `--quiet` keeps the report and drops only the hints, and it exits `0` when it
explained the table and `1` when the name reaches no table or more than one, or when there is no
schema to read. It writes nothing, ever.
