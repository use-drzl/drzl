# @drzl/generator-graphql

## 0.2.1

### Patch Changes

- 5551b52: A nullable column with no default may be omitted on insert, because the database allows it

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

## 0.2.0

### Minor Changes

- 4801464: `generate` knows what it is about to write before it writes it (plan items 68, 80, 81, 75, 82)

  **One mechanism, three features.** `--dry-run`, "say what changed rather than how many files", and
  "a `--check` failure should show a diff" are the same question asked once per file: what content is
  about to land here, and what is here now. So generators now hand their writes to a `fileSink`
  instead of calling `node:fs/promises` themselves, and `generate` decides whether that sink writes.
  Fourteen generator packages changed by exactly one line each, because the sink is shaped like the
  `fs` namespace they already used, plus one option on their public type.

  The tempting alternative was to leave the generators alone and patch `node:fs/promises` for the
  duration of a run, and it was measured and rejected. Patching the CommonJS exports object is
  visible through a later dynamic import, but a module namespace that already exists is a snapshot
  and never changes: with `const ns = await import('node:fs/promises')` evaluated first,
  `require('node:fs/promises').writeFile = spy` leaves `ns.writeFile` untouched, on Node 22.22. The
  CLI links `chokidar`, which imports `node:fs/promises` at module scope, so a dry run built on that
  would write real files whenever an unrelated dependency happened to import first.

  **`drzl generate --dry-run` writes nothing at all** (item 68). Not "writes and puts it back":
  no file, no directory, no formatter output. A dry run in a project that has never been generated
  into leaves the directory byte-for-byte as it found it, asserted per entry and per byte rather than
  by looking for generated files. It exits `0` whether or not anything would change, because a dry
  run that computed its answer did what it was asked, and `2` is for a run that found what it was told
  to look for; `--check` is the flag whose question is "is anything stale". stdout still carries one
  absolute path per line, so `drzl generate --dry-run > files.txt` gives the list that _would_ be
  written in the same shape as the list that was.

  Because generators are separate packages that a user can install at a different version from the
  CLI, the claim is also checked at runtime rather than only in a test. A run that promised to write
  nothing and wrote something restores the tree, exits `1` with the new `DRZL_GEN_003`, and names the
  generator to update.

  **Every run says what it did to each file** (item 80): created, changed or unchanged, with the
  counts and the names of the ones that are not the same as before.

  ```
  ✔ Generated (zod): 3 files (1 created, 1 changed, 1 unchanged)
    + zod/posts.zod.ts
    ~ zod/index.ts
  ```

  A run that rewrote twelve identical files and one real change used to say `13 files`. Unchanged
  files are counted rather than listed: the list is what changed. That report is narration, so it is
  on stderr, `--quiet` drops it, and **stdout is unchanged**, still one absolute path per line.
  `--json` gains a `changes` array per generator beside the existing `files`, and a `dryRun` flag.

  **`--check` prints a unified diff under each drifted file** (item 81), `a/` being what is on disk
  and `b/` what the schema produces, so it reads like `git diff` and applies like a patch. "Changed"
  alone cannot tell a regenerated header from somebody's hand-edit to a generated file, and those two
  want opposite responses. Diffs are capped at the first 20 files, at 4000 lines and at 1500 line
  edits, and every cap states itself in the output; every drifted file is still named in the list
  above the diffs, so what is capped is the explanation and never the finding. `--quiet` keeps the
  list and drops the diffs. The diff is written here rather than installed: `diff` (jsdiff) is only
  resolvable in this workspace as a transitive dependency of a devDependency, and adding it as a real
  one costs a package on every install of the CLI in exchange for about a hundred lines of a
  published algorithm. It is checked by applying its own output: every case in its suite requires the
  emitted patch, replayed against the "before" text, to reproduce the "after" text exactly.

  **`--check` also stopped writing.** It used to snapshot the output directories, let the generators
  overwrite them for real, compare, and restore the snapshot, so the one command documented as never
  touching your tree was the command that rewrote every generated file on every CI run, with a window
  in which a killed process left the tree modified. It now compares in memory. One consequence: a file
  in an output directory that the run no longer produces is not reported, and the `removed` drift
  status is no longer produced. Reporting every unrecognised file in an output directory would mean a
  config whose `outDir` is `src` failed CI over every hand-written module in the project.

  **`drzl watch` runs one rebuild at a time** (item 75). The debounce that was there covered the wait
  and not the work: it collapsed changes arriving close together and then started a rebuild that took
  as long as it took, and every change arriving during _that_ started another one on top of it,
  writing the same output directory. Measured on a 600-table schema where one rebuild takes about
  1.4s, six saves 700ms apart produced six rebuilds with four running at once. A save that arrives
  during a rebuild is now remembered rather than started, and produces exactly one more rebuild when
  the current one finishes, however many arrive; the same measurement now shows at most one in
  flight. No save is dropped, because refusing one loses an edit, which is worse than the overlap.

  `--debounce` keeps its 200ms default, now measured rather than inherited: with the write-settling
  this watcher asks chokidar for, one editor save arrives as a single event and the widest gap inside
  one burst was 9ms; without it, a chunked write spread to 62ms, an atomic save to 101ms and
  format-on-save to 121ms. `--debounce 0` now works, having previously been read as absent by
  `Number(x) || 200` and silently replaced, and a value that is not a number is refused with a warning
  instead of quietly becoming 200.

  **Clearing the screen is opt-in** (item 75). `drzl watch` cleared the terminal on every rebuild with
  no way to stop it, throwing away the previous rebuild's errors and the banner naming the watched
  directories. It is now `--clear`, off by default, and it writes to the stream the output is actually
  on: the old `console.clear()` decided from stdout while every human-readable line goes to stderr, so
  `drzl watch > events.json` at a terminal cleared nothing and aimed the escape at the stream carrying
  the JSON.

  **The analysis was already shared between generators** (item 82), and there is now a test that says
  so. Measured on a 200-table schema: one, two, three and five generators each report exactly one
  analysis step, at a constant 37ms, and the four extra generators cost 2468ms of generator work
  where four extra analyses would have added about 148ms. `watch` re-analyses per rebuild, which is
  what keeps a cached analysis from going stale when the schema changes.

### Patch Changes

- Updated dependencies [cf19c30]
- Updated dependencies [c56125f]
- Updated dependencies [28787ff]
- Updated dependencies [062f305]
- Updated dependencies [2c8b20b]
- Updated dependencies [4801464]
- Updated dependencies [02fc84a]
  - @drzl/analyzer@1.21.0
  - @drzl/validation-core@3.22.0

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
