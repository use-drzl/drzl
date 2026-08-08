---
'@drzl/analyzer': patch
'@drzl/generator-zod': patch
'@drzl/generator-valibot': patch
'@drzl/generator-arktype': patch
'@drzl/generator-typebox': patch
'@drzl/generator-effect': patch
'@drzl/generator-json-schema': patch
---

Unsigned integer columns get the range they actually hold

`int('x', { unsigned: true })` emitted the signed range, `gte(-2147483648).lte(2147483647)`,
so the select schema refused every stored value in [2^31, 2^32-1] on a column shape MySQL
users reach for constantly. The whole family had the same defect, differently per major. On
drizzle-orm 0.4x the flag lives only in `config.unsigned` and no range table read it, so every
width kept its signed bounds and `serial`, unsigned by its own definition, had no bounds at
all: an auto-increment column accepted -1. On drizzle v1 the `uint16`/`uint24`/`uint32`
semantics had no arm and fell to the implicit-decimal path, `integer: false` with
+/-9999999999, and `uint64` fell back to the class table's signed int64 range, so
`bigint({ mode: 'bigint', unsigned: true })` refused 18446744073709551615n, a value the driver
really returns.

The analyzer now answers every unsigned width on both majors with the type's own range:
tinyint [0, 255], smallint [0, 65535], mediumint [0, 16777215], int [0, 4294967295], bigint in
number mode [0, 9007199254740991], the safe-integer ceiling the number wire imposes, and
bigint in bigint mode [0, 18446744073709551615], representable because the value is a bigint,
which is how 18446744073709551615n lands in emitted literals. `serial` takes the number-mode
answer with a BIGINT label on both majors. `bigint({ mode: 'string', unsigned: true })` stays
the string the driver returns: v1 spells it `string uint64` and the string-mode arm keyed on
`int64` alone. SingleStore ships the same builders and takes the same table, which also closes
a signed gap: its tinyint and mediumint carried no range on 0.4x while v1 stated `int8` and
`int24` for the same columns. Postgres and SQLite have no unsigned spelling and are untouched,
asserted by test.

Measured against a live MySQL 8.4.11 in STRICT_TRANS_TABLES: every ceiling stores and comes
back, value for value, through mysql2 under both majors, and -1 and each ceiling plus one are
refused with ER_WARN_DATA_OUT_OF_RANGE. A CHECK on an unsigned column still folds into the
bound in its wire's spelling: `.gte(10).lte(4294967295)` on the number wire, `.gte(10n)` on
the bigint wire. Official drizzle-zod, drizzle-valibot, drizzle-arktype and drizzle-typebox
answer the same probes identically on both majors, so the fixed schemas agree with first-party
behavior on every unsigned width, including the safe-integer ceiling for number mode and for
serial. The JSON Schema generator also narrows its bigint pattern on unsigned columns, from
`^-?\d+$` to `^\d+$`: the sign is the one half of the range a pattern can state exactly.
