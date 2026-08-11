# @drzl/generator-express

## 0.2.2

### Patch Changes

- 46cc4a5: The route generators stop calling a json, bigint or binary column `unknown`

  A json column was `z.unknown()` in every router, and so were a bigint and a `bytea`. The same three
  columns are typed by every standalone validator generator, so DRZL gave one column two answers
  depending on which generator wrote it, and the router's answer was the widest thing a schema can
  say. Anything at all passed validation there, including values the database refuses.

  Each now states its wire form, which is the rule the Date entry beside it already followed:

  ```ts
  // before, in every router
  prefs: z.unknown(),  blob: z.unknown(),  big: z.unknown(),

  // after
  prefs: z.json(),
  blob: z.base64().transform((s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))),
  big: z.string().regex(/^-?\d+$/),
  ```

  Measured through the emitted schemas rather than read off them. A real body is accepted, the blob
  arrives as a `Uint8Array`, and a bigint past 2^53 survives exactly: `'9007199254740993'` parses back
  to the same digits. Five values the old schemas accepted are now refused, each of them one no
  database column would take: `undefined` and a `Date` for the json column, a non-base64 string for
  the binary one, and a number or `'12.5'` for the bigint.

  The read side differs where the value differs. A handler returns a real `Uint8Array`, so the select
  schema keeps `z.instanceof(Uint8Array)`; a bigint stays digits on both sides, because
  `JSON.stringify(1n)` throws on the way out.

  Valibot and ArkType get the same three, in their own spellings: the recursive json value, the base64
  pipe, `TypedArray.Uint8` on the read side. The json value schema now lives in
  `@drzl/validation-core` rather than being copied, since the standalone generator and the routers
  need the same text.

  A **bigint primary key is now wired** rather than stubbed. The oRPC service template refused to call
  a service for one, because the input carried `unknown` and the service's parameter is a real
  `bigint`. The input carries digits now and the pattern makes `BigInt()` total, so the call is
  written: `LedgerService.getById(BigInt(input.seq))`.

  The Express validation middleware also stops casting to `never`. It writes per slot instead, so the
  body lands with no cast at all and the params cast names `typeof req.params`.

  What is still `unknown` after this: a `customType` column with no `$type<T>()`, which nothing can
  type and which `typedColumns` recovers. That one is honest.

- Updated dependencies [46cc4a5]
  - @drzl/validation-core@3.22.5

## 0.2.1

### Patch Changes

- 6e8ffe5: A `Date` column can now be written over JSON, which it could not before

  The Express, Hono and tRPC generators typed a `Date` column as `z.date()` in every mode, insert and
  update included. `JSON.stringify(new Date())` is a string, so no JSON body ever holds a `Date`
  instance and every one of those schemas refused every spelling a client could send. A request
  carrying a date column could not be written at all, in any of the three.

  Measured through each emitted app rather than inferred: on tRPC's fetch adapter, against the exact
  base this generator emits, both an ISO string and an epoch number were rejected.

  The write side now takes the strict ISO datetime string and hands the handler a real `Date`, which
  is what the NestJS generator already did. The read side is unchanged and stays `z.date()`, because
  that is what the driver produces. Strict on purpose: `new Date('1')` is the year 2001, so a lenient
  parse turns a typo into a row.

  tRPC takes a union of both instead, `z.union([z.date(), <the ISO form>])`. Its builder carries the
  transformer, and the emitted base creates one with none, so the default wire is plain JSON; adding
  superjson to that same base is the documented tRPC answer for dates and then a real `Date` arrives.
  Both are legitimate configurations of the tree this generator writes, and an ISO-only schema would
  reject the value superjson exists to carry.

  The oRPC generator is deliberately unchanged. Its RPC protocol carries a `Date` natively through its
  own tagging, measured: a tagged body arrives at the handler as a real `Date` and `z.date()` is the
  right schema for it, while a plain-JSON body is refused by the protocol before any schema runs.

  None of the three had a `Date` column on a writable table in its fixtures, which is why this
  survived: Express and Hono never posted one, and tRPC's runtime spec calls procedures through
  `createCallerFactory`, which hands the resolver whatever JS value it is given and never crosses a
  transformer. All three fixtures now carry one, and each suite asserts over its real wire that an ISO
  string is accepted, that `"1"` is refused, and for tRPC that a real `Date` still works in process.

- Updated dependencies [08c2189]
- Updated dependencies [866dbaa]
  - @drzl/validation-core@3.22.3
  - @drzl/analyzer@1.21.3

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

- cb379e0: An Express route generator, in Express's own idiom.

  `@drzl/generator-express` emits one `Router()` per table: real HTTP routes carrying a
  validation middleware, an `index.ts` mounting them all on an `express()` app with the modules
  re-exported, and `validation.ts`, a dependency-free middleware over Standard Schema v1.

  The middleware is emitted rather than installed, and that is the decision that shapes the
  package. Express has no first-party validator ecosystem the way Hono does, and the third-party
  middlewares are AJV-based: they validate JSON Schema through a different pipeline from the zod,
  valibot and arktype schemas every other DRZL router shares. All three of those libraries
  implement Standard Schema v1 (measured on zod 4.4.3, valibot 1.4.2 and arktype 2.2.3), so one
  emitted `validate(slot, schema)` covers every library `validation.library` can name: 400 with
  `{ error, slot, issues: [{ message, path }] }` on failure, and on success the parsed output
  replaces `req.params` or `req.body`, which is the only channel Express has, before `next()`.

  Express 5 only, from a measurement rather than a preference. The write stubs throw from async
  handlers, as the Hono generator's do, and Express 5 routes the rejected promise to its error
  middleware and answers 500. On express 4.22.2 under Node 22 the same stub is an unhandled
  promise rejection that kills the process without responding, so the emitted idiom is only honest
  on 5. `express@latest` has been the 5.x line since 2024.

  The design otherwise follows `@drzl/generator-hono`:

  - The key comes from the table's real `primaryKey`, every column of it, at its real type. A
    table with no primary key keeps `GET /` and `POST /` and loses the `/:id` routes rather than
    gaining a fictional numeric `id`. A composite key becomes `/:orgId/:userId`.
  - A read-only table gets no write routes and no insert or update schema.
  - Path parameters are coerced strictly, with the exact strict forms the Hono generator measured:
    the idiomatic coercions are built on `Number()`, where `Number('')` is `0`, and
    `GET /users/%20` addressing row `0` is the wrong row, not a loose coercion.
  - The write stubs throw rather than returning their validated input, which is the insert shape
    where the declared response is the select shape.
  - Every emitted module imports only what it uses, `json()` rides on each write route so a single
    router mounted into a consumer's own app still parses its own bodies, and `validation.ts` is
    emitted only when some route validates something.

  One thing is stated plainly instead of imitated: there is no Express counterpart of Hono's
  `hc<AppType>()`. Nothing infers a client from an Express app, so what a consumer gets is typed
  handlers (`Response<T>` on every handler) and the exported `Select<Table>Row` types, not an
  inferred client.

  On `@drzl/cli`: a new `express` generator kind, wired into both `generate` and `watch` through
  one shared options builder, and a `generate-express` pipeline name for `watch --pipeline`.
  `databaseInjection` is refused with a warning on this kind, because it is a contract with
  `@drzl/generator-service` and these handlers never call one. There is no `validator` option,
  unlike the hono kind, because there is exactly one middleware and it is emitted.
  `@drzl/generator-express` is an **optional** dependency of the CLI, like the tRPC, Hono, effect
  and json-schema generators: a package that has never been published cannot publish through npm's
  trusted-publisher OIDC flow, so its first version goes out by hand, and naming it as a hard
  dependency in the same release would break `npm i @drzl/cli` for everyone until it exists.

### Patch Changes

- Updated dependencies [9939e4c]
- Updated dependencies [0e295da]
- Updated dependencies [1218361]
- Updated dependencies [45bb6f5]
- Updated dependencies [cc26f38]
- Updated dependencies [f29bff7]
  - @drzl/validation-core@3.21.0
  - @drzl/analyzer@1.20.1
