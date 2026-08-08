# @drzl/generator-graphql

## 0.1.0

### Minor Changes

- 1ee27d3: A GraphQL schema generator: SDL typeDefs, resolver stubs that throw, and plain-object scalar
  configs and enum value maps that any GraphQL server can consume.

  `@drzl/generator-graphql` emits one module per table with the object type, create and update
  input types and enum types as an SDL string, TypeScript row and input interfaces typed with the
  database values, and resolver stubs that throw `Not implemented` until replaced, plus a
  `scalars.ts` carrying `DateTimeScalar`, `BigIntScalar` and `JSONScalar` and an `index.ts`
  barrel composing everything into one `{ typeDefs, resolvers }` pair with the `Query` and
  `Mutation` types (a bare type set without a Query type fails `assertValidSchema`, measured, so
  the barrel owns them). Keyless tables get a list field and `create` only, composite keys become
  multi-argument byId fields, and read-only tables get no mutations and no input types.

  The plan left the target artifact open, and it was settled from the registry and a measured
  grid rather than taste. Registry: `graphql@latest` is 17.0.2 while `@apollo/server` 5.5.1 pins
  `graphql ^16.11.0` and `graphql-yoga` 5.21.2 pins `^15.2.0 || ^16.0.0`, with
  `@graphql-tools/schema` 10.0.38 spanning 14 through 17; emitted code importing graphql would
  pick a side of that split and risk graphql-js's "another module or realm" error when two copies
  meet. So the emission is SDL text plus plain objects with ZERO runtime imports and no peer on
  graphql at all: the consumer's own graphql builds the schema, whichever major it is. Measured
  on both majors: graphql 17 renamed the scalar hooks (serialize/parseValue/parseLiteral became
  coerceOutputValue/coerceInputValue/coerceInputLiteral), and a legacy-named plain config on 17
  silently skips parseValue for variables and can skip serialize, letting a raw bigint escape
  into the response; the emitted configs name every hook twice, which measures correct on
  16.14.2 and 17.0.2 through all three coercion paths.

  Scalar mapping, each row measured: `Int` only where the analyzer's declared bounds prove the
  column fits 32 bits, because graphql-js refuses 2^31 on serialize, variables and literals
  alike, so an unbounded integer column (SQLite's 64-bit `integer`, `bigint { mode: 'number' }`)
  is `Float` rather than a read-path failure. `bigint` is a `BigInt` scalar carrying the route
  generators' digits-string policy: a JSON number variable is refused because JSON.parse has
  already rounded it (2^53+1 arrives as 2^53), while an inline integer literal is accepted
  losslessly because the AST carries raw digits (9007199254740993 survives exactly). Date
  columns are a strict-ISO `DateTime` scalar handing the resolver a real `Date`; numeric-as-
  string stays `String` with no invented precision; `uuid` is `ID` (measured: serializes strings
  unchanged, coerces integer input to digits, refuses 1.5, does not validate the uuid shape);
  `json`/`jsonb` and untypeable columns are a passthrough `JSON` scalar; arrays are lists with
  NULLABLE elements, because Postgres arrays admit NULL elements and a null under `[T!]` nulls
  the whole field with an error (measured).

  The enum landmine is handled in both directions. `in-progress` is an SDL syntax error, `2fa`
  lexes as a malformed number and `with space` silently parses as two members (all measured), so
  members that are valid GraphQL names keep their database spelling verbatim and the rest are
  renamed with a "Database value" description, with a value map emitted for exactly the renamed
  members. Proven at execution on both majors: a resolver returning `in-progress` serializes to
  `IN_PROGRESS`, an input of `IN_PROGRESS` (variable or literal) reaches the resolver as
  `in-progress`, unmapped members keep name-as-value, and outsiders are refused naming the enum.
  Two values renaming onto one name fall back to String with a note. A column name that is not a
  GraphQL Name (`cover url`) is exposed renamed with an emitted output field resolver mapping it
  back to the row property.

  Input nullability leans on the one thing GraphQL does natively that JSON bodies cannot:
  explicit null and absent are different values in the coerced args, proven through an executed
  mutation on variables and literals alike. Create inputs mark required-no-default columns
  `Type!`; update inputs are all-optional with the primary key excluded via the shared
  `updateColumns`. One divergence is documented rather than papered over: GraphQL cannot spell
  the DTO generators' required-but-nullable presence rule, and cannot refuse explicit null on a
  non-nullable update field, so both are stated as inexpressible and left to the database.

  The runtime suite builds the emitted pair with the real `makeExecutableSchema`, passes
  `assertValidSchema`, and executes: stub throws carrying the field path, unknown fields refused
  at validation, wrong-typed input refused by GraphQL naming the path, the enum and both custom
  scalars round-tripped through variables AND inline literals (different code paths, and on 17
  different hook names), the full introspection query, and a second suite doing the same SDL,
  execution and scalar attachment on graphql 16 through an install alias.

  On `@drzl/cli`: a new `graphql` generator kind, wired into both `generate` and `watch` through
  one shared options builder with a byte-for-byte branch-parity spec, and a `generate-graphql`
  pipeline name for `watch --pipeline`. `databaseInjection` is refused with a warning (the
  resolvers are stubs), and so are `includeRelations` (relation fields are resolvers the
  consumer writes) and the whole `validation` block (the schema is GraphQL SDL, its own type
  language, so unlike the nestjs kind not even `library` is read). `@drzl/generator-graphql` is
  an **optional** dependency of the CLI, like the tRPC, Hono, Express, Fastify, NestJS, effect
  and json-schema generators: a package that has never been published cannot publish through
  npm's trusted-publisher OIDC flow, so its first version goes out by hand, and naming it as a
  hard dependency in the same release would break `npm i @drzl/cli` for everyone until it exists.

### Patch Changes

- Updated dependencies [9939e4c]
- Updated dependencies [0e295da]
- Updated dependencies [1218361]
- Updated dependencies [45bb6f5]
- Updated dependencies [cc26f38]
- Updated dependencies [f29bff7]
  - @drzl/validation-core@3.21.0
  - @drzl/analyzer@1.20.1
