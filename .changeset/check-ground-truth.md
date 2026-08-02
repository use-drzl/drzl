---
'@drzl/analyzer': minor
---

Give json columns the JSON value space, and stop losing SQLite's mode columns

Every generator has a branch for `shape: { kind: 'json' }` that emits a real definition of what
JSON can hold. Nothing ever set that shape outside the drizzle v1 path, so a plain `json()` column
landed on `tsType: 'any'` and the branch never ran. The emitted validator was `z.any()`, which
accepts `undefined`, `NaN`, `Infinity`, a bigint, a Date and a Buffer, none of which survive a
round trip through a json column. It is now `z.json()`.

SQLite spells a mode as a distinct class rather than as config, so `text({ mode: 'json' })` is a
`SQLiteTextJson` and `blob({ mode: 'bigint' })` is a `SQLiteBigInt`. Neither matched any arm of
the class-name map, so both came back `UNKNOWN`, which is wider still than `any`.

Found by the untyped-column warning firing on a json column, which was correct.
