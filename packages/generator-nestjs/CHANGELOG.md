# @drzl/generator-nestjs

## 0.2.3

### Patch Changes

- 3cb5100: The emitted TypeScript row types stop saying `unknown` for json and binary columns

  The generators that emit types rather than schemas described a json column as `unknown`, and the
  service generator described it as `any`, while every validator generator beside them said what the
  column is. A row type that says `unknown` makes the caller cast to read a value the database
  guarantees is json; one that says `any` is worse, since it turns checking off without saying so.

  Both now carry a type. `json` becomes a `DrzlJsonValue` alias declared in the module, and a binary
  column becomes the `Uint8Array` the driver hands back:

  ```ts
  export interface SelectwRow {
    id: number;
    prefs: DrzlJsonValue; // was unknown
    blob: Uint8Array; // was unknown
    custom: unknown; // a customType, which nothing can type
  }
  ```

  The alias text lives in `@drzl/validation-core`, so the four generators that emit it cannot drift,
  and it is emitted only into a module that names it: a table with no json column produces the bytes
  it produced before. It is verified mutually assignable with zod's own `z.json()` output, which is
  what lets a NestJS DTO field use it and still satisfy the `StandardSchema<Dto>` static beside it.

  `custom` staying `unknown` is the point of the control: a `customType` with no `$type<T>()` is a
  column nothing can type, and `typedColumns` is what recovers it.

- Updated dependencies [3cb5100]
  - @drzl/validation-core@3.22.6

## 0.2.2

### Patch Changes

- d0fffb7: NestJS stops calling a json or binary column `unknown`, and TypeBox's predicates take `unknown`

  The NestJS DTOs had the hole the routers just lost: a json column and a `bytea` were `z.unknown()`,
  so the schema accepted anything and the DTO field said `unknown` to the controller. Each states its
  wire form now, and the class field states what the pipe hands over:

  ```ts
  prefs: z.json(),                       // DrzlJsonValue, not unknown
  blob: z.base64().transform(...),       // Uint8Array on the way in
  big:  z.string().regex(/^-?\d+$/),     // unchanged
  ```

  The read side keeps a real `Uint8Array`, which is what a controller returns. ArkType's write side is
  the one exception and it is stated rather than papered over: it has no base64 decoder
  (`string.base64.parse` throws on 2.2.3), so it validates the string and the DTO field says `string`.

  The fixture family gained both columns, so the emitted tree is now compiled with them and the
  runtime suite posts them: a base64 blob is decoded, `'not base64!!'` and a number are refused, and a
  json column takes every shape a body can carry. The json half is a type-level win rather than a
  runtime one, and the test says so: a body has been through `JSON.parse`, so no request can tell
  `z.json()` from `z.unknown()` at runtime.

  TypeBox's emitted predicates now take `unknown` where they narrow themselves, which is all six of
  the single-value ones, and the type registry callback infers its parameters instead of taking two
  `any`s. The two predicates that index a row keep `any`, and the reason now lives in the generator
  rather than in every generated file: the output-size budget failed when it was written into the
  emitted output, at 510 bytes per column against 490, which is the gate making the case better than
  the comment did.

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

- 4c0128b: A NestJS DTO generator: plain classes carrying a Standard Schema, and a pipe that runs them.

  `@drzl/generator-nestjs` emits one module per table with the insert, update, select and params
  schemas in the configured library's spelling (zod by default, valibot or arktype via
  `validation.library`) and four plain classes around them: `Create<T>Dto`, `Update<T>Dto`,
  `<T>ParamsDto` and `<T>Entity`, each pairing its fields with its schema through
  `static readonly schema: StandardSchema<Dto>`, so schema-vs-field drift is a compile error
  inside the generated file. A `validation.ts` module carries `SchemaValidationPipe`, which
  validates any parameter whose metatype carries such a static and passes everything else
  through untouched, and an `index.ts` barrel re-exports it all. Deliberately DTOs and not
  controllers: routes, modules and providers belong to the consumer's app, and the DTO class is
  the unit Nest itself scaffolds per resource.

  The plan left "class-validator or plain schemas" open, and it was settled from the registry and
  a measured grid rather than taste. Registry: `@nestjs/common` 11.1.28 lists class-validator and
  class-transformer as optional peers; class-validator is active at 0.15.1, while
  class-transformer, the half that would convert wire values, last published 0.5.1 in November
  2021; `nestjs-zod` 5.5.0 is active, evidence the schema-carrying-class idiom is established in
  Nest. Measured, four behaviours the decorator path cannot square with DRZL's settled policies:
  what `@IsInt()` accepts depends on the consumer's ValidationPipe rather than the DTO
  (`enableImplicitConversion: true` reads `""` and `" "` as 0, `"0x10"` as 16, `"1e5"` as 100000,
  the exact `Number('')` family the route generators refuse); `@IsOptional()` cannot tell
  `{ bio: null }` from `{}`, where the enforcing spelling costs three decorators of `@ValidateIf`
  workaround per nullable column; `@Type(() => BigInt)` silently does nothing and `@IsInt()`
  rejects a real bigint; and `@Type(() => Date)` accepts `"1"` as the year 2001. There is a
  compiler reason besides: decorator DTOs fail TS1240 without `experimentalDecorators`, while the
  emitted plain classes compile under every tsconfig including `verbatimModuleSyntax`, with the
  decorator flags needed only where they already are, in the consumer's controllers. The docs
  carry the full grids, including Nest's `ParseIntPipe` (strict on the junk spellings, but it
  silently rounds `"9007199254740993"`) and the coexistence table for a global class-validator
  ValidationPipe beside these DTOs (defaults coexist; `whitelist: true` strips every property of
  a metadata-less class first, measured). The honest paragraph for a consumer who wants the
  class-validator path anyway is in the docs too.

  The presence rule is inherited from the shared builders rather than re-decided: a nullable
  column with no default is required on insert, null spelled out, matching the JSON Schema
  builder the Fastify generator inlines and diverging, documented, from the Hono and Express
  inline schemas. Update DTOs exclude the primary key columns via the shared `updateColumns`, so
  an `id` in a PATCH body is an undeclared key and is stripped. All three libraries strip
  undeclared keys (arktype via an emitted `.onUndeclaredKey('delete')`, measured against its
  default of preserving them), which is `whitelist: true` semantics carried by the schema instead
  of by pipe options. Wire shapes with no JSON form are transformed at the boundary: a Date
  column takes the strict ISO string and hands the controller a real `Date`, and a bigint column
  crosses as its decimal digits and stays a string on both sides, because `JSON.stringify`
  throws on a real bigint (pinned as a 500 in the runtime suite).

  The runtime suite compiles a consumer tree (generated DTOs plus controllers written the docs
  way) with a real `tsc` under the standard Nest flags, boots the compiled JavaScript with
  `NestFactory.create`, and drives it over HTTP for all three libraries, because a
  vitest-transpiled controller would have no decorator metadata and the metatype would silently
  be undefined. Every rejection is paired with an acceptance whose echoed body proves the pipe
  was in the loop: the stripped extra key, the numeric segment arriving as a real number, the
  exact digits of `9007199254740993` surviving.

  On `@drzl/cli`: a new `nestjs` generator kind, wired into both `generate` and `watch` through
  one shared options builder with a byte-for-byte branch-parity spec, and a `generate-nestjs`
  pipeline name for `watch --pipeline`. `databaseInjection` is refused with a warning (there are
  no handlers at all), and so are `includeRelations` (relation lookups are routes) and every
  `validation` key except `library` (the DTO modules are self-contained on purpose).
  `@drzl/generator-nestjs` is an **optional** dependency of the CLI, like the tRPC, Hono,
  Express, Fastify, effect and json-schema generators: a package that has never been published
  cannot publish through npm's trusted-publisher OIDC flow, so its first version goes out by
  hand, and naming it as a hard dependency in the same release would break `npm i @drzl/cli` for
  everyone until it exists.

### Patch Changes

- Updated dependencies [9939e4c]
- Updated dependencies [0e295da]
- Updated dependencies [1218361]
- Updated dependencies [45bb6f5]
- Updated dependencies [cc26f38]
- Updated dependencies [f29bff7]
  - @drzl/validation-core@3.21.0
  - @drzl/analyzer@1.20.1
