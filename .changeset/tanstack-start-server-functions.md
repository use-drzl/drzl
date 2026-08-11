---
'@drzl/generator-tanstack-start': minor
'@drzl/cli': minor
---

Add `@drzl/generator-tanstack-start`: TanStack Start server functions generated from a Drizzle
schema, one module per table, reads on `GET` and writes on `POST`.

The cleanest fit of any target DRZL generates for, and measured rather than assumed. Against
`@tanstack/react-start` 1.168.42 on 2026-08-11, `createServerFn().validator(schema)` takes any
Standard Schema and is properly variance-aware in both directions: the handler receives the schema's
output, so a date column's `string -> Date` transform does real work at the boundary, and the caller
supplies its input, so a date crosses the wire as an ISO string and passing a `Date` from the caller
is a compile error. zod, valibot and arktype were each compiled through it, transform included, and
all three behave identically. No adapter, no cast, no per-library escape.

That is worth recording because the sibling case does not behave that way: TanStack Form's validator
constraint is invariant, since the Standard Schema input type sits in a property, so no schema shape
removes the cast documented on the Form example.

What the generator decides that a hand-writer gets wrong is the method. `createServerFn` defaults to
`GET`, which is right for a read and wrong for every write: a mutation behind a cacheable verb is one
an intermediary is entitled to replay.

One constraint the tests now pin: Start type-checks both ends of a server function for
serialisability, the validator's input and the handler's return value, and a type of `unknown` fails
either way with `SerializationError<"Type may not be serializable">`. That is reachable from a real
schema, because a `customType` column with no `$type<T>()` reaches the schema as `unknown`. Named in
the generator's docs, and asserted by a case that fails if Start ever stops refusing it.

`@drzl/cli` gains the `tanstack-start` kind. Like `next`, it has a single mode: it emits no schemas
of its own, so the options builder forces `validation.useShared` and derives `validation.importPath`
from the sibling validation generator's own `path`. The new package is an `optionalDependency` for
this release only, for the reason the other three new generators already are.
