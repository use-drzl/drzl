---
'@drzl/cli': minor
---

Add `drzl doctor --constraints`: what each side enforces that the other does not, as a ledger.

`doctor` already reports what DRZL cannot type or enforce, one finding at a time. This asks the same
question with both directions side by side, because the two halves are usually confused for each
other and only one of them is something anyone can act on.

**The database enforces it and the schemas do not** is mostly not a defect. A primary key, a unique
index and a foreign key are facts about the *table*: whether a value is already taken, or whether a
referenced row exists, is a question only the database can answer, and no per-row validator can see
it. Listing them is still worth doing, because a reader who believes the emitted schemas are the
whole story is wrong in a way that shows up as a runtime error rather than a validation failure.

**The schemas enforce it and the database does not** is the half nothing surfaced before, and it can
lose data. Measured on 2026-08-11:

```
pgEnum('mood', [...])('native')          sqlType: mood   enumValues: ["sad","ok","happy"]
text('status', { enum: ['draft', ...] })  sqlType: text   enumValues: ["draft","live"]
```

A native `pgEnum` column carries the enum's type name as its SQL type and the database enforces the
set. A Drizzle `text(name, { enum: [...] })` column is a plain `text` column: the generated schema
says `z.enum(['draft', 'live'])`, so the application refuses anything else, and a migration, a psql
session, an admin tool or any other client writes `'banana'` into it without complaint. The set
exists only in your code. A `varchar(20)` carrying a set is the same, because a width is not a set.

Each of those is printed with the `ALTER TABLE ... ADD CONSTRAINT ... CHECK (...)` that would close
it, literals escaped, so the report names the fix rather than only the problem.

`--strict` counts the schema-only side alone. A key or a foreign key that no per-row validator can
check is not a defect anyone can fix, so failing a pipeline over one would be noise.

An unreadable schema is reported as unreadable rather than as clean. The drift ledger over an empty
analysis is empty, which would render as "No drift" and is the most misleading thing this command
could say when the file was never imported; the check is the doctor report's own, so the two commands
agree about what "could not be read" means.

The report claims nothing about a column whose `sqlType` the analyzer could not read. That field
comes from Drizzle's own `getSQLType()` and is left off where it throws, and guessing from the class
name is how a report ends up asserting something it never read.

`doctor`'s existing output is unchanged when the flag is absent.
