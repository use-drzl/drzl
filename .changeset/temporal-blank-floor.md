---
'@drzl/analyzer': patch
'@drzl/validation-core': patch
---

A temporal column carried as text no longer accepts a blank string

`date({ mode: 'string' })`, `timestamp({ mode: 'string' })`, `time()` and `interval()` were typed
`string` and stated nothing else, so every generator emitted a bare string and the schema accepted
`''`. Postgres refuses `''` for every one of those types, so the schema admitted a write the
database will not take. `''` is what an untouched form control submits, which is how it reaches an
insert.

The check is a floor, not a shape, and deliberately so. A date-shaped pattern turns away rows the
server stores: Postgres reads `'today'`, `'January 8, 1999'`, `'01/08/1999'` and `'20200101'` as
dates, which is why `format` has never carried a date entry. What survives is `\S`, unanchored, so
it means "holds at least one non-whitespace character". Measured through PGlite, every Postgres
temporal type refuses `''` and `' '` and accepts a valid value with surrounding whitespace, so this
refuses exactly the set the server refuses and nothing else.

Which columns carry it is decided per engine and per type, because the servers do not agree:

- **Postgres** marks `date`, `time`, `timetz`, `timestamp`, `timestamptz` and `interval`.
- **MySQL** marks `date`, `datetime` and `timestamp`, and deliberately **not** `time`. Measured on
  8.4.11 in `STRICT_TRANS_TABLES`, a `time` column accepts `''` and stores `00:00:00`, silently,
  with `SHOW WARNINGS` empty. Refusing there would be stricter than the server.
- **SQLite** marks nothing, since it stores whatever text it is given, and SingleStore, mssql and
  Cockroach are unmarked because no server of theirs was measured.

The marker is set on both drizzle majors, through the codec on 1.x and the class name on 0.4x, and
a test asserts the two describe every column in the grid identically. Every generator picks it up
through the existing format mechanism, so zod, valibot, ArkType, TypeBox, Effect and JSON Schema all
state it without a change of their own.

The date modes of the same columns are untouched: those are a `Date`, not a string.
