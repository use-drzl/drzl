---
'@drzl/generator-service': patch
---

MySQL and SingleStore services stop calling RETURNING the dialect does not have

`dataAccess: 'drizzle'` emitted `.returning()` unconditionally, and drizzle's MySQL and
SingleStore insert/update builders have no such method on either major (0.45.2 and 1.0.0-rc.4,
measured), so the emitted service failed tsc against every schema of these dialects: the whole
dialect was unusable. The emission now keys on the dialect the analyzer already records and
emits what the dialect really offers, measured on MySQL 8.4.11 through mysql2 identically on
both majors: create inserts through `$returningId()`, which reports AUTO_INCREMENT and
`$defaultFn` keys as `[{ id }]` and nothing for a caller-supplied key, where the input already
carries the value, then reads the created row back by that key; update writes and reads the row
back (awaiting the builder yields `[ResultSetHeader, ...]`, never rows); delete never used
RETURNING and is unchanged. Method signatures are identical across dialects, so routers built
on these services do not change. A `generatedAlwaysAs` primary key is the one shape the dialect
cannot round-trip, and create for such a table throws with an explanation instead of returning
undefined. Postgres, SQLite, stub and unknown-dialect output is byte-identical to before,
proved by generating both from the same analyses and diffing. Red-first: 12 failing tests (tsc
red on both majors plus a runtime TypeError through the emitted service), green after, with the
runtime contract asserted against a real MySQL 8.4.11 and the sqlite emission proved healthy
against a real better-sqlite3 on both majors.
