---
'@drzl/analyzer': patch
---

`decimal` and `numeric` are typed by their mode on drizzle-orm 0.4x, instead of every mode being a
number.

Drizzle gives each mode its own class, and the class-name path folded all three into one regex,
`/Decimal|Numeric|Float|Double|Real/i`, which answered `number` for every one of them. Two of the
three then rejected every row the database hands back, and their insert schemas rejected the value
the driver wants. Read back through `db.select()` from a real MySQL 8.4.11 over mysql2, on a
`decimal(10,2)` holding `'1234.56'` and a `decimal(20,0)` holding `'9007199254740993'`:

```
mode              class                 driver returns     0.4x said   0.4x says
(default/string)  MySqlDecimal          '1234.56'          number      string
mode: 'number'    MySqlDecimalNumber    1234.56            number      number
mode: 'bigint'    MySqlDecimalBigInt    9007199254740993n  number      bigint
```

The same three modes measured identically on Postgres through PGlite and on SQLite through
better-sqlite3, and official `drizzle-zod` 0.8.3 accepts exactly those three types on the same three
columns and refuses the other two on each.

**What changes for you.** On drizzle-orm 0.4x:

- MySQL and SingleStore `decimal()` and `decimal({ mode: 'string' })` emit a string schema, matching
  `numeric` on Postgres, which has been a string here for exactly this reason.
- MySQL and SingleStore `decimal({ mode: 'bigint' })` emit a bigint schema.
- SQLite `numeric({ mode: 'number' })` and `numeric({ mode: 'bigint' })` were `unknown`, so their
  validators accepted anything; they now emit a number and a bigint schema.
- Postgres `numeric({ mode: 'bigint' })` was already a bigint but was labelled `dbType: 'BIGINT'`,
  picked up from the arm meant for `bigint` columns. It is `'NUMERIC'` now. Nothing generated
  changes: `dbType` is read outside the analyzer only by `isIntegerColumn`, which asks whether it is
  exactly `'INTEGER'`.

**What does not change.** `decimal({ mode: 'number' })` and `numeric({ mode: 'number' })` stay
numbers on every dialect; that mode was the one the old answer got right. Nothing on drizzle-orm v1
moves, since `describeV1Column` already reads the mode off `dataType` and got all three right. The
`numeric` format check stays attached on v1 only, so a 0.4x string schema is a bare string and still
takes `'hello'`, as the Postgres one already did.
