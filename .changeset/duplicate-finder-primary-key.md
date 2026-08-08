---
'@drzl/validation-core': patch
'@drzl/generator-zod': patch
'@drzl/generator-valibot': patch
'@drzl/generator-arktype': patch
'@drzl/generator-typebox': patch
'@drzl/generator-effect': patch
---

The duplicate finder now covers the primary key, which is the collision seed data actually has

`findDuplicate<table>` scanned only the declared unique constraints, so two rows carrying the
same explicit primary key sailed through and failed at the database with
`duplicate key value violates unique constraint "users_pkey"` (23505, measured on Postgres 17),
and a table whose only key is its primary key, a natural key like `skus.code`, got no finder at
all. The database enforces a primary key with a unique index and its own error calls it a unique
constraint, so the finder treats it as one: the key is checked first, named `<table>_pkey` the
way Postgres names it, and reported like any other collision. Rows that leave a generated key to
the database are untouched, because an absent or null column already skips a constraint, exactly
as a unique index skips NULLs. Emitted output changes only where `duplicateFinder: true` is set.
