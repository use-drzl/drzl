# Pothos

`@drzl/generator-pothos` emits a [Pothos](https://pothos-graphql.dev) schema builder from your
Drizzle schema: one object type per table, each checked against the row type it came from.

## Why this and not the SDL

DRZL already emits [GraphQL SDL](/generators/graphql). SDL is a string. It describes a schema and
cannot be extended, so a resolver written against it is checked by nothing: return the wrong shape,
misspell a field, and you find out at runtime.

A Pothos builder is code. `t.exposeString('emial')` is a compile error here, and silently returns
`undefined` from a hand-written resolver against SDL. That is the whole reason to emit one.

The two generators agree exactly on which GraphQL type each column gets, deliberately: the same
column described two ways by two DRZL generators is worse than either description on its own.

## Setup

```ts
// drzl.config.ts
export default {
  schema: './src/db/schema.ts',
  generators: [{ kind: 'pothos', path: 'src/graphql' }],
};
```

```bash
npm install -D @drzl/generator-pothos
npm install @pothos/core graphql
```

Like the [seed](/generators/seed) and [fast-check](/generators/fast-check) generators, this reads
nothing from a validation generator. The object types are checked against row interfaces it writes
itself.

## What is emitted

- `builder.ts` holds the builder and a `Row` interface per table. One module, not one per table,
  because `SchemaBuilder<{ Objects: ... }>` names every type in a single generic: split up, each
  object module would import the builder and the builder would import each row type, which is a
  cycle.
- One module per table, calling `builder.objectType('Users', { fields: ... })`.
- `index.ts` pulls them in, adds a query field per table and calls `builder.toSchema()`.

```ts
import { schema } from './graphql';
```

## Nullability is stated on every field, and that is not verbosity

Pothos defaults every field to **nullable**. A `NOT NULL` column written as a bare
`t.exposeString('email')` reaches clients as `String`, and every one of them null-checks a field
that cannot be null.

The obvious fix is `defaultFieldNullability: false` on the builder. It does not compile:

```
error TS2353: Object literal may only specify known properties, and
'defaultFieldNullability' does not exist in type 'RemoveNeverKeys<SchemaBuilderOptions<...>>'
```

That option is legal only on a builder with no type parameter, which runs in Pothos's v3
compatibility mode. On a v4 generic, which is what a generated builder is, it types as `never`,
because there it exists only to opt *into* nullable. Removing it and running the schema shows the
runtime default is nullable in both shapes, so the central switch is unavailable exactly where it
would be useful.

So every field says which it is:

```ts
email: t.exposeString('email', { nullable: false }),
bio: t.exposeString('bio', { nullable: true }),
```

A reader sees a column's nullability without knowing anything about the builder, which is worth the
extra words on its own.

## Scalars

| Column        | GraphQL   | Why                                                             |
| ------------- | --------- | --------------------------------------------------------------- |
| bounded int32 | `Int`     | Only where declared bounds prove 32 bits                        |
| other numbers | `Float`   | graphql-js refuses 2^31, so an unbounded integer must not be `Int` |
| uuid          | `ID`      |                                                                 |
| `Date`        | `DateTime`| A registered scalar, ISO 8601 in UTC                            |
| `bigint`      | `BigInt`  | A registered scalar, decimal digits as a string                 |
| json          | `JSON`    | A registered scalar, passed through                             |

`BigInt` travels as a string because `JSON.stringify(1n)` throws and a number loses precision past
2^53. The scalars are written into the emitted tree rather than pulled from `graphql-scalars`, which
would be a dependency for three short definitions.

An enum column is a `String` rather than a GraphQL enum, because a GraphQL enum member must be a
valid name and a database enum value need not be: `'in progress'` and `'2xl'` are both legal in
Postgres and neither is a legal GraphQL enum value.

## The stub resolvers throw

```ts
users: t.field({
  type: ['Users'],
  nullable: false,
  resolve: () => {
    throw new Error('Not implemented: resolve users. Return the rows.');
  },
}),
```

Not an empty array. A caller reading `[]` cannot tell "no rows" from "nobody wrote this yet".

## Options

| Option                 | Default  | What it does                                 |
| ---------------------- | -------- | ---------------------------------------------- |
| `path`                 | `outDir` | Where the modules are written                 |
| `naming.routerSuffix`  | none     | Appended to each module name and type name    |
| `naming.procedureCase` | none     | Casing for file names and identifiers         |
