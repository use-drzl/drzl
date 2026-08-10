# GraphQL Generator

Generates a GraphQL schema from your Drizzle schema: per table, the object type, create and
update input types and enum types as SDL `typeDefs` strings, resolver stubs that throw until
you replace them, enum value maps carrying the database spellings, and dependency-free scalar
configs for `DateTime`, `BigInt` and `JSON`. A barrel joins everything into one
`{ typeDefs, resolvers }` pair. The resolvers stay yours.

```bash
npm install -D @drzl/generator-graphql
```

`@drzl/cli` depends on it, so installing the CLI already brought it along; the line above is for
using the generator on its own. `drzl generate` tells you which package to install if it is ever
missing. The generated code imports **nothing**: serving the schema takes any builder that accepts
`{ typeDefs, resolvers }`.

## SDL text and plain objects, not GraphQLSchema instances

Settled from the registry and from measurement rather than taste.

From the registry (checked 2026-08-08): `graphql@latest` is **17.0.2**, and the server
ecosystem has not followed. `@apollo/server` 5.5.1 peers on `graphql ^16.11.0` and
`graphql-yoga` 5.21.2 on `^15.2.0 || ^16.0.0`, while `@graphql-tools/schema` 10.0.38 spans
`^14 || ^15 || ^16 || ^17`. Emitted code that imported graphql would have to pick a side of
that split, would impose a peer range, and would drag a second copy into any tree that picked
the other side, where graphql-js throws `Cannot use ... from another module or realm` the
moment the two meet. SDL strings and plain objects have no side to pick: **your** graphql
builds the schema, whichever major it is.

From measurement: graphql 17 renamed the scalar hooks. Execution reads `coerceOutputValue`,
`coerceInputValue` and `coerceInputLiteral` where 16 reads `serialize`, `parseValue` and
`parseLiteral`. A plain scalar config naming only the legacy three, handed to
`makeExecutableSchema` on 17.0.2, measures broken in the quiet way: variables skip
`parseValue` and the raw JSON value reaches the resolver, and a skipped `serialize` let a real
bigint escape into the response. The emitted configs therefore name every hook **twice**, one
function per pair, which measures correct on 16.14.2 and 17.0.2 through all three paths.

## What it emits

| File         | What it is                                                                     |
| ------------ | ------------------------------------------------------------------------------ |
| `<table>.ts` | row and input TypeScript interfaces, the table's SDL, and its resolver stubs   |
| `scalars.ts` | `DateTimeScalar`, `BigIntScalar`, `JSONScalar`: plain configs, both hook names |
| `index.ts`   | the barrel: `typeDefs` (scalars + tables + `Query` + `Mutation`) and `resolvers` |

The barrel owns the `Query` and `Mutation` types, because a bare type set without a `Query`
type is not a valid schema (`assertValidSchema`: "Query root type must be provided", measured)
and SDL cannot spell an empty `type Query {}` to extend later. Per table:

- `Query`: `users: [Users!]!` and, for a keyed table, `usersById(id: Int!): Users` (nullable
  result: a miss is `null`, not an error). A composite key becomes a multi-argument field,
  every column named and typed.
- `Mutation`, for writable tables: `createUsers(input: CreateUsersInput!): Users!`,
  `updateUsers(id: Int!, input: UpdateUsersInput!): Users!`, `deleteUsers(id: Int!): Boolean!`.
  A keyless table keeps only `create` (nothing can address one row); a read-only table
  (materialized view) gets no mutations and no input types at all.

Every stub throws `Not implemented: Query.users. Replace this stub with your data layer.`,
which is the write-stubs-throw discipline of the route generators: the error proves the field
exists and resolves, and the path in the GraphQL error names it.

## Using it

```ts
import { makeExecutableSchema } from '@graphql-tools/schema';
import { typeDefs, resolvers, type Users } from './graphql/index.js';

export const schema = makeExecutableSchema({
  typeDefs,
  resolvers: {
    ...resolvers,
    Query: { ...resolvers.Query, users: (): Promise<Users[]> => db.select().from(users) },
  },
});
```

`graphql-yoga` (`createSchema({ typeDefs, resolvers })`) and Apollo Server
(`new ApolloServer({ typeDefs, resolvers })`) take the same pair; both were checked against the
registry above and yoga was measured end to end (16.14.2, over HTTP, scalar configs and enum
maps live).

Plain `buildSchema(typeDefs)` accepts the SDL too, and the tests prove it on both majors, but
it takes no resolvers, so custom scalar behaviour and enum value maps do not attach. On
graphql 16 you can `Object.assign` the emitted configs onto `schema.getType('DateTime')`
(measured working); on 17 that patch does **not** take for variables (measured), so reach for a
resolver-accepting builder there.

## The scalar mapping, measured

| Column                                | GraphQL | Why                                                                    |
| ------------------------------------- | ------- | ---------------------------------------------------------------------- |
| `integer`/`smallint` with proven 32-bit bounds | `Int!` | graphql-js refuses 2^31 on all three paths (measured)          |
| integer without proven bounds (SQLite, `bigint { mode: 'number' }`) | `Float!` | `Int` at serialize would refuse values the database returns |
| `real`, `double precision`            | `Float!` | double precision by spec                                              |
| `numeric`/`decimal` (string mode)     | `String!` | the wire is a string; no precision is invented                       |
| `boolean`                             | `Boolean!` |                                                                     |
| `text`/`varchar`/`char`, `interval`, `inet`, `cidr`, `macaddr`, `time`, `bit` | `String!` | strings on the wire |
| `uuid`                                | `ID!`   | GraphQL's opaque identifier; measured: any string passes, integer input coerces to its digits, `1.5` refused. It does not validate the uuid shape |
| `date`/`timestamp` (`mode: 'date'`)   | `DateTime!` | strict ISO 8601 string in, real `Date` to the resolver, `toISOString()` out; `new Date('1')` is 2001, hence strict |
| `bigint` (`mode: 'bigint'`)           | `BigInt!` | decimal digit string on the wire, the shared route policy (below)    |
| `json`/`jsonb`, untyped columns       | `JSON!` | passthrough scalar; inline literals rebuilt from the AST               |
| `bytea`/`blob`                        | `JSON!` | GraphQL has no binary type; the module says so and your resolver picks an encoding |
| `point`/`line` (tuple modes), `vector` | `[Float!]!` | fixed length not expressible in SDL                              |
| `.array()` columns                    | `[T]!` lists | element stays **nullable**: Postgres arrays admit NULL elements, and a null under `[T!]` nulls the whole field with an error (measured) |

The `BigInt` scalar carries the route generators' bigint-as-digits policy into GraphQL's two
input paths, which are different code paths and were measured separately:

- a **variable** must be a digit string. A JSON number has already been rounded by
  `JSON.parse` before GraphQL sees it (2^53+1 arrives as 2^53, measured), so numbers are
  refused rather than silently rounded.
- an **inline integer literal** is accepted losslessly, because the AST carries its raw digits
  as a string: `big: 9007199254740993` reaches the resolver as `"9007199254740993"` exactly
  (measured on 16.14.2 and 17.0.2).
- serialize takes a real `bigint` or a digit string and emits the digits; anything else throws
  rather than rounding.

## The enum policy, both directions

A GraphQL enum member must be a Name (`[_A-Za-z][_0-9A-Za-z]*`), must not be `true`, `false`
or `null`, and must not start with `__`. Postgres enum values are none of that reliably:
measured, `in-progress` is an SDL syntax error, `2fa` lexes as a malformed number, and
`with space` is worse, it silently parses as **two** members.

So: a member that is already a valid name keeps its database spelling verbatim (`admin` stays
`admin`). The rest are renamed: uppercased, runs of other characters to `_`, a digit-led name
prefixed with `_` (`in-progress` becomes `IN_PROGRESS`, `2fa` becomes `_2FA`), each carrying a
`"Database value: ..."` description in the SDL. The module then emits a value map for exactly
the renamed members (`TasksStatusEnum: { IN_PROGRESS: 'in-progress', _2FA: '2fa' }`), and
graphql-js does both directions itself once the map is applied, measured at execution:

- a resolver returning the database value `'in-progress'` serializes to `IN_PROGRESS` in the
  response;
- an input of `IN_PROGRESS`, as a variable or an inline literal, reaches the resolver as
  `'in-progress'`;
- unmapped members keep name-as-value (partial maps measured), an outsider is refused naming
  the enum, and the database spelling where the name belongs is refused too.

The emitted TypeScript types tell the truth: the input interface types `status` as
`'todo' | 'in-progress' | '2fa'`, the values your resolver actually receives.

Two values that rename onto one name (`a-b` and `a b`) cannot share a map, so such a column
falls back to `String` carrying the database values verbatim, with a note in the module naming
them.

## Nullability, and what GraphQL cannot say

Output types spell `notNull` as `!`. Input types lean on the one thing GraphQL does natively
that JSON bodies cannot: **absent and explicit null are different values**. Measured through an
executed mutation, on variables and inline literals alike: `{ bio: null }` reaches the resolver
with the key present and `null`, `{}` reaches it with no key at all.

- Create inputs mark required-no-default columns `Type!`; defaulted and nullable columns are
  omittable.
- Update inputs make every field optional and exclude the primary key columns (the shared
  `updateColumns` rule), so there is no `id` field to smuggle a re-key through.

One divergence is documented rather than papered over: the DTO generators' presence rule
("a nullable column with no default is required on insert, null spelled out") is
**inexpressible** in GraphQL. An input field is either non-null-and-required or omittable;
there is no required-but-nullable. The same limit runs the other way on updates: explicit null
on a non-nullable column cannot be refused by the schema and is left to the database, which
refuses it anyway.

## A column name GraphQL cannot spell

GraphQL fields have no quoted-name escape hatch. A column called `cover url` is exposed as
`cover_url`; the module emits an output field resolver mapping it back to the row property
(`parent['cover url']`), and on create and update inputs the value arrives under `cover_url`
for your resolver to write back. The module carries a note saying exactly that.

## Options

| Option                   | Default  | Meaning                                                             |
| ------------------------ | -------- | ------------------------------------------------------------------- |
| `path`                   | `outDir` | where to write                                                      |
| `naming.routerSuffix`    | `''`     | appended to the table name for the file name (`'Gql'` writes `usersGql.ts`) |
| `naming.procedureCase`   |          | casing for file names (`kebab` writes `users-gql.ts`)               |
| `importExtension`        | `'js'`   | how the barrel's relative specifiers spell their extension          |
| `format`, `outputHeader` |          | as every other generator                                            |

`validation` is not read on this kind at all, and the config warns if you set it: the emitted
schema is GraphQL SDL, GraphQL's own type language, so there is no library to choose and no
shared schema module to import. `includeRelations` and `databaseInjection` warn too: relation
fields on a GraphQL type are resolvers you write against your own data layer, and there are no
handlers to inject a database into.

## A runnable config

```ts
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: 'src/db/schema.ts',
  outDir: 'src/graphql',
  generators: [{ kind: 'graphql', path: 'src/graphql' }],
});
```

```bash
npx drzl generate
npx drzl watch --pipeline generate-graphql
```

## See also

- [Hono Generator](/generators/hono), [Express Generator](/generators/express) and
  [Fastify Generator](/generators/fastify), the route generators whose wire policies (strict
  ISO dates, bigint as digits) this generator carries into GraphQL
- [NestJS Generator](/generators/nestjs), the other emit-the-shapes-keep-the-handlers kind
- [Adapters (Overview)](/adapters/overview)
