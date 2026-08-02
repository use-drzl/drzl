---
'@drzl/analyzer': minor
'@drzl/cli': minor
---

Warn when a column gets a validator that accepts anything

`tsType: 'unknown'` is the exact shape two real bugs took: `.array()` and `pgEnum` columns came
back untyped on drizzle-orm 0.4x, every generator emitted a validator accepting any value, and
nothing anywhere said so. The only way to find out was to read the generated file.

`verify-packed.sh` now fails on it, which protects this repository and does nothing for a user
whose schema uses a column type DRZL has not modelled. That is the case where it matters most,
because their validators are silently open and nobody has told them.

The analyzer now reports `DRZL_ANL_UNKNOWN_COLUMN` per column, and the CLI prints a summary after
analysis, naming the column and its SQL type. It stays a warning: the rest of the schema still
generates and the generated code is still useful.

The condition is "the emitted validator will be wide", not "the type is unknown". A `json` column
is also untyped and is not wide, since the generators emit the JSON value space for it. A
`customType` is wide, and gets a hint pointing at `.$type<T>()` with `typedColumns`, which is the
documented fix.
