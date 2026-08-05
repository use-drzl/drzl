---
'@drzl/analyzer': patch
---

A MySQL or SingleStore enum column is described as the string it is, on drizzle-orm 0.4x.

Those two dialects give an enum its own column class and state no `codec`, so the class-name map is
the only path, and it had an arm for `PgEnumColumn` and none for the other two. The column came back
`tsType: 'unknown'` while carrying a full `enumValues` array.

**The emitted validator was never wrong.** Every generator reads `enumValues` before it reads
`tsType`, so a MySQL enum column has always produced a real enum of exactly its members. What was
wrong was the description, and the description reached you anyway, through the untyped-column
warning:

```
Column "m_enum" on table "t" has no known type (SQL type enum('a','b','c')),
so its validator will accept any value.
```

The emitted schema accepted exactly three values. A warning that is wrong about the one column it
names teaches you to skip the true ones, which is the cost this fix is really paying off.

Nothing about the generated output changes. `drizzle-orm@1.0.0-rc.4` already answered `string` for
the same column, so the two majors now agree, and the cross-major diff that carried the
disagreement has one fewer filed defect.
