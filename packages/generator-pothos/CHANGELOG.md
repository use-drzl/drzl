# @drzl/generator-pothos

## 0.2.0

### Minor Changes

- c89aeaa: Add `@drzl/generator-pothos`: a Pothos schema builder generated from a Drizzle schema, one object
  type per table, each checked against the row type it came from.

  DRZL already emits GraphQL SDL. SDL is a string: it describes a schema and cannot be extended, so a
  resolver written against it is checked by nothing. A Pothos builder is code, and
  `t.exposeString('emial')` is a compile error here where it silently returns `undefined` there. That
  is the whole reason to emit one, and it is why the emission uses `builder.objectType('Users', ...)`
  against a `SchemaBuilder<{ Objects }>` generic rather than `builder.objectRef('Users').implement`,
  which is the shorter form and checks nothing.

  Both GraphQL generators agree exactly on which type each column gets. The same column described two
  ways by two DRZL generators is worse than either description on its own, so `Int` appears only where
  declared bounds prove 32 bits, a uuid is `ID`, and `Date`, `bigint` and json are registered scalars.

  **Nullability is stated on every field, and that is not verbosity.** Pothos defaults every field to
  nullable, so a `NOT NULL` column written as a bare `t.exposeString('email')` reaches clients as
  `String` and every one of them null-checks a field that cannot be null. The obvious fix,
  `defaultFieldNullability: false` on the builder, does not compile:

  ```
  error TS2353: Object literal may only specify known properties, and
  'defaultFieldNullability' does not exist in type 'RemoveNeverKeys<SchemaBuilderOptions<...>>'
  ```

  That option is legal only on a builder with no type parameter, which runs in Pothos's v3
  compatibility mode. On a v4 generic, which is what a generated builder is, it types as `never`,
  because there it exists only to opt _into_ nullable. Removing it and running the schema shows the
  runtime default is nullable in both shapes, so the central switch is unavailable exactly where it
  would help. Every emitted field therefore says which it is, which also lets a reader see a column's
  nullability without knowing anything about the builder.

  Getting there took a wrong turn worth recording: the first measurement was taken on the `objectRef`
  shape, where `defaultFieldNullability: false` works, and that shape is not what the generator emits.
  A measurement taken on a shape the generator does not produce describes nothing.

  Stub resolvers throw rather than returning an empty array, because a caller reading `[]` cannot tell
  "no rows" from "nobody wrote this yet".

  `@drzl/cli` gains the `pothos` kind. Like the `seed` and `fast-check` generators it reads nothing
  from a validation generator: the object types are checked against row interfaces it writes itself.
