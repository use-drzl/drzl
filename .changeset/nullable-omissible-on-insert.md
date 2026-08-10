---
'@drzl/generator-json-schema': patch
'@drzl/generator-nestjs': patch
'@drzl/generator-fastify': patch
'@drzl/generator-graphql': patch
---

A nullable column with no default may be omitted on insert, because the database allows it

Two generators required a nullable column that has no default to be present in an insert body, on
the stated reasoning that null is a value and omitting the key is not sending null. That reasoning
is wrong, and the disagreement was settled by asking a real Postgres (PGlite) rather than by
argument. Against a table with a nullable no-default column and a `NOT NULL` one:

```
omit the nullable columns      ACCEPTED, stored row reads NULL
send explicit NULLs            ACCEPTED, same stored row
omit the NOT NULL column       refused: null value in column "email" violates not-null constraint
```

So an `INSERT` that omits a nullable column is a row the database will happily write, and a schema
that refuses it is stricter than the table it describes. The rule is now stated the way the database
states it: a column is optional on insert exactly when the database can produce a row without it,
which means a default, or nullability.

What changed:

- `@drzl/generator-json-schema` no longer lists a nullable no-default column in the insert schema's
  `required` array. `@drzl/generator-fastify` inlines this builder, so its request schemas inherit
  the correction and `POST` bodies that omit such a column are accepted rather than answered 400.
- `@drzl/generator-nestjs` marks the field optional in all three library spellings and the class
  field with it, so `Create<T>Dto` reads `bio?: string | null` instead of `bio!: string | null`.
- `@drzl/generator-graphql` is unchanged in behaviour. Its create inputs already marked such a
  column omittable, and the module comment that called this an inexpressible divergence from the
  other generators is no longer true, because there is no divergence left to be inexpressible.

The other ten generators already answered this way and are untouched. All fourteen were generated
from the same table to confirm one answer: zod, valibot, arktype, TypeBox, Effect, Hono, Express,
tRPC, oRPC and NestJS all spell the column optional, JSON Schema and Fastify require only the
`NOT NULL` column, and GraphQL exposes it as `String` rather than `String!`.

Unaffected: update schemas, where everything was already optional; select schemas, where the
database guarantees the column is present and it stays required; and a column carrying an
`IS NOT NULL` `CHECK`, which the shared column reader reports as not nullable before any schema is
built, so it is still required on insert.

Two of the NestJS assertions guarding the old rule were passing without checking anything: a lazy
`[\s\S]*?` run against the whole emitted file bridges from the create class into the select class,
where the required spelling legitimately lives, and matches there. They now slice the region under
test out first, and the counter-case is asserted beside each: the `NOT NULL` column is still
required, at the schema, at the runtime and at the type level.
