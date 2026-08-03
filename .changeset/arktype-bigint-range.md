---
'@drzl/generator-arktype': minor
---

Bound bigint columns in the arktype output, which accepted values no int64 can hold

A `bigint({ mode: 'bigint' })` column emitted the bare ArkType type `bigint` and nothing else, so
the generated schema accepted `2n ** 70n`. zod, valibot and typebox all bound the same column, and
so does `drizzle-orm/arktype`, which made this the one place where DRZL's output was *looser* than
the first-party validator rather than stricter. On Postgres, MySQL and SQLite alike, a row this
schema passed could be one the database refuses.

The reason it was left unstated was half right. ArkType's string DSL genuinely cannot carry the
bound: `type('bigint >= -9223372036854775808n')` throws "Comparator >= must be followed by a
corresponding literal", and the same bound written as a number rounds, since 9223372036854775807
is not representable as a double. But `.narrow` can carry it, and this generator already used
`.narrow` for every `varchar(n)` character cap and every MySQL byte cap. Bigint columns now use
the same mechanism, and a `CHECK` folds into the bound exactly as it does for a number column.

Null still passes, matching SQL and matching the existing cap narrows. An array column bounds its
element rather than the array. A bound that could only be rendered as a syntax error, such as a
fractional one, is left off rather than emitted, because a module ArkType cannot parse throws at
import and takes whatever imported it down.

**What changes for you.** Generated arktype schemas for `bigint`, `bigserial` and SQLite
`blob({ mode: 'bigint' })` columns now reject a bigint outside the int64 range. If you were
relying on a value larger than the column can store passing validation, it will now be refused,
which is the behaviour the zod, valibot and typebox generators already had, and the behaviour of
`drizzle-orm/arktype` itself.
