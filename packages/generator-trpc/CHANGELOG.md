# @drzl/generator-trpc

## 0.3.2

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

## 0.3.1

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

## 0.3.0

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

- 2b79b1b: Service-mode routers reach the service for natural and composite keys

  `template: 'service'` stubbed byId/update/delete for any table whose key was not exactly one
  `number`, because `@drzl/generator-service` could not receive anything else. That generator now
  types its key parameters from the primary key itself, so the guard follows it: the call is
  wired whenever every key column has a type the input schema can spell (number, string,
  boolean, Date, or an enum's literals), composing a composite key as one argument per key
  column in key order (`Service.getById(input.orgId, input.userId)`). The throwing stub remains
  only for a key column DRZL cannot type, where the input carries `z.unknown()` and the call
  would not compile, and the emitted note now states that reason instead of the old single
  number limitation.

- Updated dependencies [cf19c30]
- Updated dependencies [c56125f]
- Updated dependencies [28787ff]
- Updated dependencies [062f305]
- Updated dependencies [2c8b20b]
- Updated dependencies [4801464]
- Updated dependencies [02fc84a]
  - @drzl/analyzer@1.21.0
  - @drzl/validation-core@3.22.0

## 0.2.0

### Minor Changes

- 91ca283: A tRPC generator, `@drzl/generator-trpc`, and the CLI wiring for it.

  `drzl generate` takes a `{ kind: 'trpc' }` generator, `drzl generate:trpc <schema>` runs it without
  a config, and `drzl watch --pipeline generate-trpc` rebuilds only it. The package is an **optional**
  dependency of `@drzl/cli`, like the json-schema generator: a package that has never been published
  cannot publish through npm's trusted-publisher flow, so its first version goes out by hand, and
  naming it as a hard dependency in the same release would break `npm i @drzl/cli` until it exists.

  **Targets tRPC v11**, determined from the registry rather than from memory: `latest` is 11.x, majors
  1 through 11 are published and there is no 12, and `next` points behind `latest`, so there is not
  even a pre-release train to aim at. Every construct emitted was run against a real 11.18.0 install.

  Three kinds of file per run. `trpc.ts` holds the single `initTRPC` instance the whole tree shares,
  which has no counterpart in the oRPC output and is not optional: tRPC's builder carries the context
  type with it, so a router built from its own `initTRPC.create()` cannot share middleware and cannot
  be soundly merged. `<table>.ts` is one router per table. `index.ts` builds `appRouter` with
  `router()` and exports `type AppRouter`, which is the entire client contract.

  Per table: `list` and `byId` as queries, `create`, `update` and `delete` as mutations, each with an
  `.output(...)` schema, plus one `listBy<Column>` query per single-column foreign key under
  `includeRelations`. Reads are queries and writes are mutations because a tRPC client caches and
  batches queries over `GET` and never puts a mutation there.

  **The primary key is read off the schema.** A `varchar` key called `isbn` produces
  `byId({ isbn: string })`. A composite key produces `byId({ orgId, userId })`. A table with **no**
  primary key gets `list` and `create` only, rather than a fabricated `id`. A read-only relation gets
  `list` and `byId` only, and no insert or update schema is imported for it. The emitted tree is
  compiled by `tsc` under `strict` and `moduleResolution: nodenext` for every one of those shapes and
  for all three validators, and stood up as a real HTTP server and driven with real requests, in this
  package's own test suite.

  TypeBox cannot be used with this generator, and that is measured rather than assumed: tRPC v11
  recognises a validator through Standard Schema, and `@sinclair/typebox` 0.34 puts no `~standard` key
  on what `Type.Object()` returns. `validation.library` accepts zod, valibot and arktype, all three of
  which were run through a real router.

  ***

  Three CLI wiring defects, all of the same species, found by generating output and reading it rather
  than by reading the wiring:

  - **`databaseInjection` was documented and unreachable.** It has been on the oRPC generator's
    documented options since it was added, and `GeneratorSchema` had no such key. That schema is not
    strict, so zod stripped it in silence and the option did nothing at all when set from a config
    file. It is in the schema now, and passed by both router branches.
  - **`watch` never passed `servicesDir`.** `generate` computes it from the `service` generator's
    `path` and passes it; `watch`'s oRPC branch did not, so a rebuild emitted a service import
    pointing at the default directory whatever the config said. The first save after starting
    `drzl watch` silently replaced a correct import with a wrong one.
  - **`databaseInjection` reached only one of the two generators that have to agree about it.** A
    router in injection mode emits `Service.getById(ctx.db, id)`, and only a service generated in the
    same mode has a `db` parameter to receive it. It is declared once on the router generator and
    pushed onto the `service` generator by `resolveConfig`, the same mechanism that already pulls
    `validation.affix` the other way. `@drzl/generator-service` honours the flag only while emitting
    real Drizzle queries, so pairing it with `dataAccess: 'stub'` now warns instead of emitting calls
    that cannot compile.

  The tRPC branches of `generate` and `watch` build their options through one shared function, and
  `packages/cli/test/trpc-branch-parity.spec.ts` runs both commands over a config that sets every
  option and compares the bytes, because reading the two branches is what missed all three above.
