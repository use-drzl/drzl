# @drzl/generator-graphql

Generate a GraphQL schema from a Drizzle schema: per table, the object type, create and update
inputs and enum types as SDL `typeDefs` strings, resolver stubs that throw until you wire them,
enum value maps carrying the database spellings, and dependency-free scalar configs for
`DateTime`, `BigInt` and `JSON`. A barrel joins it all into one `{ typeDefs, resolvers }` pair.

## Why SDL text and plain objects, not GraphQLSchema instances

Settled from the registry and from measurement. `graphql@latest` is 17.0.2 while Apollo Server
pins `graphql ^16.11.0` and graphql-yoga `^15.2 || ^16`, so emitted code importing graphql
would pick a side of that split and risk graphql-js's "another module or realm" error. SDL
strings and plain objects have no side to pick: your own graphql builds the schema, and the
generated modules import nothing at runtime. The scalar configs name every hook twice, because
graphql 17 renamed them and a legacy-only config measures broken there.

## Install

```bash
npm install -D @drzl/generator-graphql
```

The generated code imports nothing. To serve the schema you need a builder that takes
`{ typeDefs, resolvers }`: `@graphql-tools/schema`, graphql-yoga or Apollo Server.

## Configure

```ts
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: 'src/db/schema.ts',
  outDir: 'src/graphql',
  generators: [{ kind: 'graphql', path: 'src/graphql' }],
});
```

## Consume

```ts
import { makeExecutableSchema } from '@graphql-tools/schema';
import { typeDefs, resolvers } from './graphql/index.js';

export const schema = makeExecutableSchema({
  typeDefs,
  resolvers: {
    ...resolvers,
    Query: { ...resolvers.Query, users: () => db.select().from(users) },
  },
});
```

Every emitted resolver is a stub that throws, which is the proof the field exists and resolves;
replace them one by one, the way the override above does.

## The mapping, measured

`Int` only where the declared bounds prove 32 bits (graphql-js refuses 2^31 on all three
coercion paths, so an unbounded integer column is `Float` rather than a read-path failure).
`bigint` is a `BigInt` scalar crossing as decimal digit strings: an inline integer literal is
lossless (the AST carries raw digits, 9007199254740993 survives exactly) while a JSON number
variable is refused, because JSON.parse already rounded it. `Date` columns are a strict-ISO
`DateTime` scalar handing your resolver a real `Date`. `numeric` in string mode stays
`String`; `uuid` is `ID`; `json`/`jsonb` and any column DRZL cannot type ride a passthrough
`JSON` scalar. Arrays are lists with nullable elements, because Postgres arrays admit NULL
elements and a null under `[T!]` nulls the whole field with an error. Enum members keep their
database spelling where it is a valid GraphQL name; the rest are renamed (`in-progress`
becomes `IN_PROGRESS`) with a value map, so both directions execute correctly, measured.

Keyless tables get a list field and `create` only; composite keys become multi-argument byId
fields; read-only tables get no mutations and no input types.

## Docs

https://use-drzl.github.io/drzl/generators/graphql

## License

Apache-2.0
