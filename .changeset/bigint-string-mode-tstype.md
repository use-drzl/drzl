---
'@drzl/analyzer': patch
---

Type a v1 `bigint({ mode: 'string' })` column as the string the driver returns, so its generated
select schemas stop rejecting every row

Drizzle 1.0.0-rc.4 stamps `dataType: 'string int64'` on the string mode, with codec
`bigint:string` on pg and mysql and no codec at all on singlestore and mssql, measured off real
columns (`PgBigIntString`, `MySqlBigIntString`, `SingleStoreBigIntString`, `MsSqlBigInt`). The
int64 arm keyed tsType on `js === 'bigint'` alone, so this shape came back `number`, and every
generator keys on tsType, so every emitted select schema refused every value the column returns
and every insert schema refused the string the driver wants.

The driver side was measured rather than assumed: the `bigint:string` codec casts the column to
text on the wire and registers no normalize, where `bigint` normalizes with `BigInt` and
`bigint:number` with `Number`, and a live read through PGlite on the same rc hands back `'123'`
and `'9223372036854775807'` as JS strings. `drizzle-orm/zod` at the same rc agrees, accepting
'123' and refusing both `123` and `123n`.

The shape carries no numeric facts, mirroring `string numeric`: `isIntegerColumn` reads "min and
max both present" as an integer column, and the generators' string arms state none. Bounding the
string by digits pattern and int64 range, as the official generator does, is a recorded follow-up.

v1-only: drizzle-orm 0.45.2 spells `PgBigIntConfig<'number' | 'bigint'>` and branches only on
`mode === "number"`, so 0.4x has no string mode, and a type-invalid `mode: 'string'` there
silently builds the `PgBigInt64` bigint mode, which really does return a bigint and keeps its
class-map answer.
