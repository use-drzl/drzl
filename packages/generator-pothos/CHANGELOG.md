# @drzl/generator-pothos

## 0.2.1

### Patch Changes

- 555524a: Point the README documentation links at a host that resolves.

  Twelve package READMEs linked `https://drzl.dev/generators/<kind>`. That host does not resolve at
  all: curl fails to connect rather than returning a status. The site is published at
  `https://use-drzl.github.io/drzl/`, which every one of the twelve now uses, and each target was
  checked for a 200 before the link was rewritten.

  These are the READMEs npm renders on the package page, so the dead link was the "Full documentation"
  line a reader follows first. A version bump is the only way a corrected README reaches npm, which is
  why a link fix is a release.

  The split was along age: the twelve newest packages used `drzl.dev` and the ten older ones used the
  working form, so the wrong host was copied forward from one new package to the next.

  `@drzl/generator-ts-rest` also carries a version correction. Its source comments, the header it
  writes into every emitted contract, and its test docstring all said `@ts-rest/core` 3.53.0-rc.0 or
  newer, while `package.json` requires `^3.53.0-rc.1`. Both are now rc.1, which is the version the
  package actually pins and tests against. The distinction is real rather than cosmetic: 3.53.0-rc.0
  is published and does carry the Standard Schema support this generator depends on, exporting
  `isStandardSchema`, `validateAgainstStandardSchema` and `parseAsStandardSchema` and no
  `checkZodSchema`. Nothing here has been run against it, so the floor stays at the version the tests
  use and the test file now records why.

- 5fee3ef: Correct the nullability note the Pothos generator writes into every emitted `builder.ts`.

  The comment said a builder with a v4 generic "already defaults to non-null". It does not. The probe
  in `test/schema.spec.ts` builds exactly that shape, exposes a bare field and asserts the printed SDL,
  and it prints `bare: String`, nullable, on every run. The comment had been contradicted by a passing
  test in the same package for as long as it existed.

  This is the second wrong turn on the same question. The first measured the `objectRef` shape, which
  this generator does not emit, and was retracted in the changelog at the time. The retraction fixed
  the docs page and the README and left this comment saying the opposite, where it was copied into the
  generated output of every project using the generator.

  Nothing about the emitted schema changes. Every field already states its own `nullable` and still
  does, which is the right shape precisely because `defaultFieldNullability: false` types as `never`
  on a v4 generic: the central switch is unavailable exactly where it would help. Only the prose in
  the emitted file changes, which is why this is a patch.

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
