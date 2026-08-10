# @drzl/generator-fastify

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

- Updated dependencies [5551b52]
  - @drzl/generator-json-schema@0.9.2

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
  - @drzl/generator-json-schema@0.9.0
  - @drzl/validation-core@3.22.0

## 0.1.0

### Minor Changes

- 3c2153c: A Fastify plugin generator, with DRZL's JSON Schema fed straight into Fastify's own validation.

  `@drzl/generator-fastify` emits one `FastifyPluginAsync` per table: real HTTP routes whose
  `schema: { params, body, response }` Fastify compiles itself, AJV for the requests and
  fast-json-stringify for the responses, plus an `index.ts` barrel plugin registering every table
  under its prefix with the modules re-exported, consumable as `app.register(routes)` under any
  prefix of your own.

  Unlike the Hono generator (which imports validator middleware) and the Express generator (which
  emits one), this generator emits no validator at all, because Fastify's native validation IS
  JSON Schema. The schemas are produced by `@drzl/generator-json-schema`'s own `tableSchemas()`
  builder, called at generation time as a real dependency and inlined as literals, so the two JSON
  Schema producers cannot drift and every semantic the builder carries (CHECK constraint bounds,
  byte caps, formats, integer detection) arrives for free. The emitted tree's only import is
  `import type { FastifyPluginAsync } from 'fastify'`, which vanishes at build time. Three keys
  are adapted from measurements on fastify 5.11.2: `$schema` (2020-12) is refused by Fastify's
  default draft-07 AJV, `$id` is stripped as module identity the inline copies do not have, and
  `prefixItems` is refused as an unknown keyword and respelled as homogeneous `items` with the
  same bounds, which is the identical constraint because the builder only emits identical tuple
  members.

  Path parameters are where Fastify's defaults had to be constrained, from a measured grid rather
  than memory: with the default `coerceTypes`, a key typed `{ type: 'integer' }` reads
  `GET /users/%20` as row 0, `0x10` as 16, `1e5` as 100000, and silently rounds
  `9007199254740993`. The emitted params schemas use the strict string spelling
  (`^-?\d+(\.\d+)?$`, digits only for bigint, `format: 'date-time'` for Date keys, the member set
  for enum keys), whose measured grid matches the Hono and Express generators row for row.

  Request bodies keep Fastify's own semantics, documented and pinned rather than fought:
  `coerceTypes: 'array'` accepts `{ email: 123 }` as `"123"` and `removeAdditional` strips
  unnamed keys, where the other two route generators answer 400. Missing required fields, enum
  outsiders, scalar-shaped violations and malformed JSON are still 400, and unparseable content
  types are 415. Two builder semantics are inherited and stated plainly: a nullable column
  without a default is required on insert (null is a value; omitting the key is not sending
  null), and the update schema excludes the primary key columns.

  The serializer is the Fastify-specific hazard and the reason the response schemas come from the
  same builder: fast-json-stringify silently omits properties absent from the response schema,
  throws a 500 for a missing required column or an inconvertible value, truncates floats declared
  integer, writes `null` as `""` under a string, and serializes a `null` payload as `{}`. The
  measured grid is recorded in the source and docs, the runtime suite proves a full row
  round-trips through the emitted route with every column present and correctly typed (via
  `fastify.inject()`, the full pipeline including serialization), and the byId stub answers a
  declared 404 instead of returning `null` for exactly the `{}` reason.

  The design otherwise follows the settled route-generator class:

  - The key comes from the table's real `primaryKey`, every column of it, at its real type. A
    keyless table keeps `GET /` and `POST /` and loses the addressed routes; a composite key
    becomes `/:orgId/:userId`; a read-only table gets no write routes and no insert or update
    schema.
  - The write stubs throw rather than echoing input, and every handler is held to its declared
    reply by the `Reply` route generics, verified by a compile canary.
  - Every module imports only what it uses, and the docs state plainly that there is no inferred
    client for a Fastify app; the TypeBox type-provider road is named as future work, not built
    as a second variant.

  On `@drzl/cli`: a new `fastify` generator kind, wired into both `generate` and `watch` through
  one shared options builder with a byte-for-byte branch-parity spec, and a `generate-fastify`
  pipeline name for `watch --pipeline`. `databaseInjection` is refused with a warning on this
  kind, and so is `validation`, which no other router refuses but this one cannot read: there is
  no library to choose and no shared schema module to import. `@drzl/generator-fastify` is an
  **optional** dependency of the CLI, like the tRPC, Hono, Express, effect and json-schema
  generators: a package that has never been published cannot publish through npm's
  trusted-publisher OIDC flow, so its first version goes out by hand, and naming it as a hard
  dependency in the same release would break `npm i @drzl/cli` for everyone until it exists.

### Patch Changes

- Updated dependencies [9939e4c]
- Updated dependencies [0e295da]
- Updated dependencies [1218361]
- Updated dependencies [45bb6f5]
- Updated dependencies [cc26f38]
- Updated dependencies [f29bff7]
- Updated dependencies [f29bff7]
  - @drzl/validation-core@3.21.0
  - @drzl/generator-json-schema@0.8.0
  - @drzl/analyzer@1.20.1
