# @drzl/generator-pothos

Generate a [Pothos](https://pothos-graphql.dev) schema builder from a Drizzle schema: one object type
per table, each checked against the row type it came from.

## Why this and not the SDL

DRZL already emits GraphQL SDL. SDL is a string: it describes a schema and cannot be extended, so a
resolver written against it is checked by nothing. A Pothos builder is code, and
`t.exposeString('emial')` is a compile error here where it silently returns `undefined` there. That
is the whole reason to emit one.

Both generators agree exactly on which GraphQL type each column gets. The same column described two
ways by two DRZL generators is worse than either description on its own.

## Install

```bash
npm install -D @drzl/generator-pothos
npm install @pothos/core graphql
```

```ts
// drzl.config.ts
export default {
  schema: './src/db/schema.ts',
  generators: [{ kind: 'pothos', path: 'src/graphql' }],
};
```

## Nullability is stated on every field

Pothos defaults every field to nullable, so a `NOT NULL` column written as a bare
`t.exposeString('email')` reaches clients as `String`. The obvious fix,
`defaultFieldNullability: false` on the builder, does not compile: that option is legal only on a
builder with no type parameter, which runs in v3 compatibility. On a v4 generic, which is what a
generated builder is, it types as `never` because there it exists only to opt *into* nullable. The
runtime default is nullable in both shapes, so the central switch is unavailable exactly where it
would help.

Every emitted field therefore says which it is, which also lets a reader see a column's nullability
without knowing anything about the builder.

## Scalars

`Int` only where declared bounds prove 32 bits, `Float` otherwise, since graphql-js refuses 2^31 and
an unbounded integer column must not fail reads. `DateTime`, `BigInt` and `JSON` are registered
scalars written into the emitted tree rather than pulled from a dependency. `BigInt` travels as a
string, because `JSON.stringify(1n)` throws and a number loses precision past 2^53.

Stub resolvers throw rather than returning an empty array: a caller reading `[]` cannot tell "no
rows" from "nobody wrote this yet".

Full documentation: https://use-drzl.github.io/drzl/generators/pothos

## Licence

Apache-2.0. Generated output is yours under your own project's licence.
