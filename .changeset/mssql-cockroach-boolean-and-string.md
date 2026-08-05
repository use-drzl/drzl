---
'@drzl/analyzer': patch
---

`mssql` and `cockroach` columns no longer lose their boolean and string families to `unknown`.

Both cores arrived with Drizzle v1 and neither had a fixture anywhere in this repository. Measured
by running the real analyzer over a real `mssqlTable` and a real `cockroachTable` on
drizzle-orm 1.0.0-rc.4: **7 of 23 mssql columns and 6 of 27 cockroach columns came back
`tsType: 'unknown'`**, and all thirteen were booleans or strings.

```
mssql       flag(bit) name(varchar) nname(nvarchar) code(char) ncode(nchar) body(text) nbody(ntext)
cockroach   flag(boolean) name(varchar) code(char) body(text) str(string) tags(text[])
```

`describeV1Column` recognised a v1 column by its `codec` or by the semantic half of its `dataType`.
Swept across every column builder the two cores export, 22 and 27 of them, **not one states a
codec**, and those thirteen state a bare `dataType` with no semantic half either: a `bit` says
`boolean`, and `varchar`/`nvarchar`/`char`/`nchar`/`text`/`ntext`/`string` all say `string`. That is
indistinguishable from a Drizzle 0.4x column, so all thirteen fell to the class-name path, which has
arms for Pg, MySql, SingleStore and Gel and none for these two. `drizzle:entityKind` is now a third
v1 marker, sound for exactly these two because `mssql-core` and `cockroach-core` ship only on v1:
the strings `MsSql` and `Cockroach` appear nowhere in the installed 0.45.2 package.

The emitted validators accepted every value for those columns. Executed, not read, across all five
generators, against values two real servers handed back or refused: 25 of 50 mssql probes and 25 of
60 cockroach probes were wrong before, and 0 of each after. SQL Server 2022 refuses `'yes'` for a
`bit` and refuses a 121st character in a `varchar(120)`; CockroachDB v24.3 refuses `1` for a `bool`
and refuses a bare string for a `string[]`. Every one of those was accepted by the generated select
and insert schemas in zod, valibot, arktype, typebox and JSON Schema.

A cockroach `real` is also now bounded where Postgres bounds one rather than where MySQL does.
`information_schema` reports its `crdb_sql_type` as `FLOAT4` and it speaks the Postgres wire
protocol, so it carries the Postgres read-back this package already records: measured on v24.3,
inserting the largest finite float32 makes the column hand back `3.4028235e+38`, a *larger* double,
so the MySQL bound refused a row the column had just returned. MSSQL keeps MySQL's bound, which is
where falling through already put it and which SQL Server 2022 confirms: a `real` stores
`3.4028234663852886e38` and refuses the next candidate up with an arithmetic overflow.

**What changes for you.** If you generate from an mssql or cockroach schema, those columns now
produce a real validator instead of one that accepts anything, and the `DRZL_ANL_UNKNOWN_COLUMN`
warning they raised is gone. Input that only ever validated because nothing was checking it will
now be rejected, which is the point. No other dialect is affected: the new marker only matches
class names those two cores own.
