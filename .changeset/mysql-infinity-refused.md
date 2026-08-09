---
'@drzl/analyzer': patch
'@drzl/validation-core': patch
'@drzl/generator-valibot': patch
'@drzl/generator-arktype': patch
---

The valibot and ArkType generators refuse `Infinity` and `-Infinity` on a MySQL or SingleStore
`float`, `double` and `real`, which the server refuses too.

An infinity is a value the schema has to answer for per dialect rather than once, and until now the
analyzer only ever said yes. Postgres genuinely stores both in a `real` and a `double precision` and
hands them back on SELECT, so all four generators accept them there and that does not change. A real
MySQL 8.4.11 in `STRICT_TRANS_TABLES` stores neither, in any of the three columns: measured on the
binary prepared path, which is the one that puts the real IEEE double on the wire, `float`, `double`
and `real` all answer `ER_WARN_DATA_OUT_OF_RANGE` for `Infinity`, `-Infinity` and `NaN` alike, while
`double` and `real` take 1e300 and 3.4028235e38 unchanged. The column carried no flag at all for
that, and an absent flag reads the same as an unmeasured one.

**The mechanism is the magnitude bound, doing this by accident.** Measured on the installed
libraries: `z.number()` and `Type.Number()` refuse a non-finite number with no bound at all, so zod
and TypeBox were never affected. `v.number()` and ArkType's `number` take both infinities, and only
a range holds them back, one end each, so `v.maxValue(n)` refuses `+Infinity` whatever `n` is and
`number >= 0` still accepts it. MySQL's `float` carries the float32 range and was therefore already
right; its `double` and `real` carry no finite bound, because every finite JS number fits in an
8 byte float and no finite bound on one is truthful, and those are what leaked. Unlike the `NaN`
leak this repeats, no union arm was needed: a bare `number` takes an infinity wherever it stands, so
the two libraries leaked in `select`, `insert` and `update`, on the object and through a field
pulled out of the schema.

**What changes.** `@drzl/analyzer` now states the refusal outright, as `allowsNaN: false` and
`allowsInfinity: false` on the MySQL and SingleStore `float`, `double` and `real` columns, on both
the drizzle 0.4x class-name path and the v1 codec path. That is a third state rather than the
absence of the first, and `@drzl/validation-core` gains `nonFiniteRefused` to read it: `true` is
stored and returned, `false` is offered and refused, absent is unstated. The valibot generator emits
`v.check((val) => Number.isFinite(val), 'a finite number')` and the ArkType generator a `.narrow`
with the same predicate, in both cases only where no bound already refuses both ends. On ArkType
that replaces the narrower `NaN` narrow on the same columns rather than joining it, since
`Number.isFinite` is false for `NaN` too.

**Postgres does not move, and neither does SQLite.** A Postgres `real` and `double precision` still
accept `NaN` and both infinities in every mode, nullable or not. SQLite is deliberately untouched
and is a third answer rather than MySQL's: a real SQLite 3.53.4 stores both infinities in a `real`
and hands them back, and silently turns `NaN` into NULL, so its column still states neither flag and
its emitted output is unchanged. MySQL's `decimal` is untouched for a similar reason: on the same
prepared path the server silently stored `0.00` for all three where the text path answers `Incorrect
decimal value`, and "refuses" is only half true of a column that accepted the row.

The zod, TypeBox, Effect and JSON Schema generators do not change. The first two already refused
both infinities everywhere, Effect builds on `Schema.Finite` unconditionally, and JSON has neither
value to express. Generated output is byte identical everywhere else: master's analyzer and
generators run beside these over the same schemas produced 80 emitted file pairs, of which the 8
that differ are exactly valibot and ArkType on MySQL and SingleStore, on both drizzle majors.
