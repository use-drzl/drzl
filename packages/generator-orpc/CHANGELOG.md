# @drzl/generator-orpc

## 2.9.0

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

- e7e39a5: oRPC addressing inputs and handler bodies are typed from the primary key instead of a hardcoded `{ id: z.number() }`

  Every emitted `get`/`update`/`delete` input spelled `{ id: z.number() }` whatever the primary
  key was, at two layers: the generator's input rewrite (in all three validation libraries, and
  in the cross-table relation lookups), and both template packages' own procedure code, where
  `@drzl/template-orpc-service` called `Service.getById(input.id)` through it. Measured on pg
  books/composite/keyless beside the post-BP services: exactly 9 tsc errors confined to the
  routers (3x TS2345 number-into-varchar on books, 3x TS2554 arity on a composite key, 3x TS2339
  on a keyless table whose service correctly no longer has the methods).

  The key is now read the way `@drzl/generator-service` and the tRPC generator read it: every
  column of `primaryKey`, at its real type, in the configured library's spelling
  (`{ isbn: z.string() }`, `v.object({ isbn: v.string() })`, `type({ isbn: 'string' })`, an enum
  key's literals). A composite key keeps all of its columns, in key order, and the service
  template composes the call as one argument per key column
  (`Service.getById(input.orgId, input.userId)`). Update inputs are the same key beside the
  patch. A table with no primary key emits `list` and `create` only, drops the relation lookups
  that would take its key, and stops importing a shared update schema nothing references. A key
  column DRZL cannot type arrives as the library's `unknown`; the service template stubs those
  procedures with a note naming the column, because `unknown` is not assignable to the service's
  typed key parameter. Templates cannot reintroduce the defect: the generator rewrites every
  template's addressing inputs and drops keyless addressing procedures whatever the template
  emitted.

  Integer-key emissions are byte-identical to before, proved by running the previous build beside
  this one over the same analyses (43 configurations across templates, libraries, relations,
  shared validation, injection and naming: 172 file pairs, zero diffs; in the natural-key grid
  the 45 files that differ are exactly the natural, composite, keyless, untypeable and enum-key
  routers). This also restores the pairing BP left red: stub-mode services + oRPC on natural keys
  now compile, because the typed stubs and the routers finally agree. Red-first: the 9 measured
  errors reproduced against a real typed PgDatabase, 0 after; a real oRPC `call` round-trip
  addresses a natural-key row and a composite row end to end, and the old `{ id: 1 }` payload is
  now the one that fails validation.

- Updated dependencies [cf19c30]
- Updated dependencies [c56125f]
- Updated dependencies [28787ff]
- Updated dependencies [062f305]
- Updated dependencies [2c8b20b]
- Updated dependencies [4801464]
- Updated dependencies [02fc84a]
- Updated dependencies [e7e39a5]
  - @drzl/analyzer@1.21.0
  - @drzl/validation-core@3.22.0
  - @drzl/template-orpc-service@2.9.0
  - @drzl/template-standard@2.9.0

## 2.8.1

### Patch Changes

- a0e49e3: Multi-schema support: two tables of the same name in different Postgres schemas, addressed and
  generated end to end.

  `pgSchema('reporting').table('users', ...)` and `pgTable('users', ...)` are two different relations
  that share one database name. The analyzer already recorded which schema each was declared in, and
  nothing downstream read it, so every surface that addresses a table by name treated the two as one.

  What was measured, rather than assumed, before any of this was written:

  - **File names, export names, the barrel, the service and router files never collided.** All of them
    are derived from the Drizzle _export_ name, which is unique within a module by construction, so
    `users.zod.ts` and `reportingUsers.zod.ts` sat side by side and the barrel was already valid. That
    is now pinned by a test rather than left to hold by accident.
  - **The OpenAPI document refused to build at all.** Both tables wanted `/users`, and the path guard
    threw rather than let one silently overwrite the other. It was right to.
  - **The config filters over-matched in silence.** `exclude: ['users']` took both, and
    `columns: { users: { ... } }` narrowed both.
  - **Foreign keys could not say which schema they pointed into.** A key to `reporting.users` and a
    key to `public.users` both recorded `foreignTable: 'users'`, so anything resolving one back to a
    table object got whichever it happened to see first.

  ### Addressing one schema from a config

  `include`, `exclude` and the `columns` keys now match a schema-qualified name as well as the bare
  one:

  ```ts
  export default defineConfig({
    schema: 'src/db/schema.ts',
    exclude: ['reporting.*'],
    columns: {
      'public.users': { omit: ['passwordHash'] },
    },
    generators: [{ kind: 'zod' }, { kind: 'json-schema', document: true }],
  });
  ```

  - **A bare pattern still matches in every schema.** `exclude: ['users']` written before a
    `reporting` schema existed means "the users tables", and narrowing it to one of them would start
    generating an endpoint the config had already turned off. When a bare pattern really does reach
    two schemas, DRZL now says so and names the qualified spellings. A warning and not an error,
    because it has to keep parsing a config that works, and because the direction `exclude` takes is
    the safe one anyway. It matters most for `columns`, where a column pattern only has to match in
    one of the tables its entry matched: `columns: { users: { pick: ['id', 'email'] } }` narrows both
    tables and the one with no `email` silently keeps only `id`, with no typo for the existing check
    to report.
  - **`public.` is the spelling for the default schema.** Not an arbitrary choice: Drizzle refuses
    `pgSchema('public')` outright, so a plain `pgTable` is the only way to declare a table there and
    an absent schema _is_ `public`. `public.users` therefore names exactly one table, and no analysis
    can ever contradict it by carrying `schema: 'public'`.
  - **`*` works on either side of the dot**, so `reporting.*` is a schema and `*.users` is every
    `users`.

  ### What else follows the schema now
  - `Table.schema` is documented as the fact everything reads, and `qualifiedTableName` is exported
    so one function decides what a qualified name looks like.
  - `ForeignKey.foreignSchema` and `Column.references.schema` are new, so a key states which schema it
    points into. `Relation.from`, `.to` and `.via` are qualified names, and the nested-schema planner
    and the oRPC relation procedures resolve them qualified. On a schema that calls no `pgSchema` a
    qualified name is the bare name, so every one of these is byte for byte what it was.
  - The OpenAPI document gives a schema-qualified table its own path, `/reporting/users`, and its own
    tag. A table in the default schema keeps the bare `/users`. The duplicate-path guard stays: it
    still catches two exports of one table name in one schema, which Drizzle allows.
  - The `.meta()` facts carry `schema` beside `table`, added rather than folded in, so existing
    emitted metadata is unchanged and a consumer can still tell `reporting.users` from `public.users`.

  ### Fixed along the way

  Relations declared with `defineRelations` named their target by its **key in the schema object**
  rather than by its table name, while the other end of the same relation was a table name. Every
  consumer resolves those strings against `Table.name`, so for any export whose name differs from its
  table's, `export const reportingUsers = reporting.table('users', ...)` being the obvious case, the
  relation was dropped in silence and no nested schema or relation procedure was emitted for it. Both
  ends are now read off the table object Drizzle already provides.

  Verified end to end: a project generated from a schema holding `public.users`, `reporting.users` and
  a child in each is compiled with `tsc --strict` under `nodenext`, with a probe that imports both
  `users` schemas through the barrel at once and reads a field only one of them has.

- Updated dependencies [a0e49e3]
  - @drzl/analyzer@1.20.0
  - @drzl/validation-core@3.20.0

## 2.8.0

### Minor Changes

- 8cc4de8: `point({ mode: 'xy' })` and `line({ mode: 'abc' })` are described as the objects they are, on both
  drizzle-orm majors.

  **`minor`, not `patch`.** The emitted TypeScript type of an object-mode `point` changes from
  `string` (0.4x) or `[number, number]` (v1) to `{ x: number; y: number }`, and of an object-mode
  `line` to `{ a: number; b: number; c: number }`. Code written against the old output does not
  compile against the new. `CONTRIBUTING.md` asks for a bump above patch to be called out, and this is
  the call-out.

  **What changes for a user, in one sentence.** If you have a `point({ mode: 'xy' })`,
  `line({ mode: 'abc' })` or `geometry({ mode: 'xy' })` column, your select schema stops rejecting
  every row the driver returns, and your insert schema stops accepting a value the database refuses.
  Nothing else moves: the tuple modes of the same three builders are untouched, and no other column
  type reaches the code that changed.

  ### It was wrong on both majors, in two different ways

  The two modes of these builders return different JavaScript values, and neither major's description
  separated them.

  On 0.4x there is no `codec` to read, so the column reaches the analyzer by class name, and a coarse
  `/Point|Line/i` answered `string`. That regex was written for the two tuple classes and was catching
  four: swept over every builder `pg-core` exports on 0.45.2, in every mode, it matches
  `PgPointTuple`, `PgLineTuple`, `PgPointObject` and `PgLineABC`, and `string` is wrong for all four.
  The tuple pair was fixed in `@drzl/analyzer@1.15.0`; this is the other half, and the regex is now
  gone rather than narrowed.

  On v1 the column states `dataType: 'object point'` while the tuple mode beside it states
  `'array point'`, and the analyzer read only the second word. Both modes reached one arm and came
  back as tuples, so a v1 select schema for an object-mode column rejected every row.

  ### The database settles it, not the first-party module

  Asked of a real Postgres through PGlite, on drizzle 0.45.2 and again on 1.0.0-rc.4, on a `point`
  and a `line` column:

  | value passed to insert | rendered by drizzle     | server                                 |
  | ---------------------- | ----------------------- | -------------------------------------- |
  | `{ x: 1.5, y: -2.25 }` | `(1.5,-2.25)`           | stored, and read back as `{ x, y }`    |
  | `{ a: 1, b: 2, c: 3 }` | `{1,2,3}`               | stored, and read back as `{ a, b, c }` |
  | `[1, 2]`               | `(undefined,undefined)` | `invalid input syntax for type point`  |
  | `'1,2'`                | `(undefined,undefined)` | `invalid input syntax for type point`  |
  | `{ x: 1 }`             | `(1,undefined)`         | `invalid input syntax for type point`  |
  | `{ x: 1, y: 2, z: 3 }` | `(1,2)`                 | stored: the unlisted key is ignored    |

  `mapToDriverValue` reads `.x`/`.y` off whatever it is handed, which is why a tuple and a string are
  not rejected in JavaScript but produce a literal the server refuses.

  So every named field is required and unlisted keys are not refused: the emitted object is
  `z.object`/`v.object`/`Type.Object` rather than the strict form, which would turn away a write the
  column accepts.

  ### What each generator emits

  | generator     | emitted for `point({ mode: 'xy' })`                   |
  | ------------- | ----------------------------------------------------- |
  | zod           | `z.object({ x: z.number(), y: z.number() })`          |
  | valibot       | `v.object({ x: v.number(), y: v.number() })`          |
  | typebox       | `Type.Object({ x: Type.Number(), y: Type.Number() })` |
  | arktype       | `type({ "x": "number", "y": "number" })`              |
  | JSON Schema   | `type: 'object'` with both fields `required`          |
  | service types | `{ x: number; y: number }`                            |
  | oRPC          | the zod or valibot form above; `unknown` for arktype  |

  ArkType is the one that is not a string. Its definition DSL cannot state an object at all,
  `type({ p: '{ x: number, y: number }' })` throws `'{' is unresolvable`, and it throws at import, so
  the field is emitted as a `type(...)` instance with `.array()`, `.or("null")` and an optional key
  around it. In the oRPC generator, where every field value is a quoted DSL fragment that has to
  compose with the nullable and optional wrappers, ArkType keeps `unknown` for the same measured
  reason it already keeps it for a tuple.

  ### Still not stated

  Postgres refuses a line whose A and B are both zero, `invalid line specification`, and accepts
  `{ a: 0, b: 1, c: 0 }` beside it. No column shape carries a cross-field rule, so the insert schema
  still promises that one write. It is pinned as a measured gap in
  `packages/cli/test/point-object-mode.e2e.spec.ts` rather than left as a remark.

- f019b03: `require('@drzl/…')` now reaches the CommonJS build, which is what these packages have been
  shipping and could not deliver.

  Every one of these packages built a `dist/index.cjs` and then published a manifest that could not
  name it. Ten had no `exports` map at all, so `require('@drzl/generator-zod')` fell through to
  `main`, which pointed at `dist/index.js` beside `"type": "module"`: an ES module. On Node 20.19 and
  Node 22.12 and later, `require()` loads one anyway, so it worked and the `.cjs` sat unused. Below
  those two versions it threw, against an `engines.node` of `>=18.17.0`:

  ```
  ERR_REQUIRE_ESM: require() of ES Module
    /app/node_modules/@drzl/generator-zod/dist/index.js from /app/probe.cjs not supported.
  ```

  Measured on a real install of the packed tarballs: broken on node 18.20.8, 20.18.3 and 22.11.0,
  working on 20.19.6, 22.22.0 and 24.19.0. The ESM half was never affected, and a Node 18 consumer who
  used `import` got correct output from all seven generators, which is why the floor stays at
  `>=18.17.0` rather than being raised: the packages really do run there, and the manifest was what
  was wrong.

  Each package now declares both entries:

  ```json
  "exports": {
    ".": {
      "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
      "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
    }
  }
  ```

  `@drzl/analyzer` was the one package whose `require` condition already named its `.cjs`, so it
  loaded. Its single shared `types` still handed a CommonJS consumer the ESM declarations, and
  `tsc --moduleResolution node16` rejected that with TS1479. It gets the same nested shape.

  **What can break.** These are minors rather than patches for two reasons, both about consumers
  doing something no DRZL documentation shows.

  An `exports` map is a gate: `@drzl/validation-core/dist/index.js` and any other path inside the
  package used to be importable and no longer is. Only the package root is a supported entry, and now
  that is enforced rather than merely intended.

  `main` moves from `dist/index.js` to `dist/index.cjs`, so a bundler old enough to ignore `exports`
  now picks up the CommonJS build. A `module` field pointing at `dist/index.js` is published beside
  it, which is what every bundler that predates `exports` reads first, so this only changes what the
  few that read neither would resolve.

  A consumer on Node 20.19 or newer who already used `require` gets the CommonJS bundle where they
  previously got the ES module through Node's interop. The named exports and `default` are the same
  either way, and `__esModule` is still true.

### Patch Changes

- Updated dependencies [b14cbed]
- Updated dependencies [8cc4de8]
- Updated dependencies [f019b03]
  - @drzl/validation-core@3.16.0
  - @drzl/analyzer@1.18.0
  - @drzl/template-orpc-service@2.8.0
  - @drzl/template-standard@2.8.0

## 2.7.0

### Minor Changes

- 6fbdb22: Fixes two defects on drizzle-orm 0.4x, which is what `npm install drizzle-orm` still serves and
  what this workspace itself depends on, and corrects the bounds on inexact numeric columns on
  **both** majors.

  **`minor`, not `patch`.** The emitted TypeScript type of a `point` column changes from `string` to
  `[number, number]`, and of a `line` from `string` to `[number, number, number]`. Code written
  against the old output does not compile against the new. `CONTRIBUTING.md` asks for a bump above
  patch to be called out, and this is the call-out.

  **What changes for a user, in one sentence each.**

  - A `point` or `line` column: your select schema stops rejecting every row and your insert schema
    stops accepting a string the column cannot be given. On 0.4x only; v1 was already right.
  - A `real`, `double precision`, `float` or `double` column: your schema stops rejecting large
    values the column holds. This is a change on **both** majors, and most of it widens: an 8 byte
    float loses its bound entirely on both, and a 4 byte float on **v1** moves from `drizzle-zod`'s
    `+/-8388607` to a far wider one. **On 0.4x a 4 byte float is a narrowing**, because it had no
    bound there at all. `1e300` and `3.5e38` validated in a `real` before and are refused now, as is
    `Infinity` in valibot and arktype, which is the one value in that set the column really holds and
    which has its own section below. Nothing else that validated before stops validating.
  - A `numeric({ mode: 'number' })` column on 0.4x: newly bounded to the safe-integer range, which
    is a narrowing. A value above 9007199254740991 that validated before is refused now. It could not
    round-trip through a JS number anyway, and both drizzle majors and `drizzle-zod` emit the same
    bound.

  ### point and line were typed `string` on 0.4x

  0.4x carries no codec, so those columns reach the analyzer by class name, and a coarse
  `/Point|Line/i` answered `string` for a value the driver hands back as a tuple. A real Postgres
  settles it rather than the first-party module: drizzle 0.45.2 maps `[1, 2]` to the literal `(1,2)`,
  the column takes it and `mapFromDriverValue` returns `[1, 2]`; the string `"1,2"` is mapped to
  `(1,,)`, because `mapToDriverValue` indexes the value by position, and Postgres refuses it with
  `invalid input syntax for type point`. `point()` is now `[number, number]` and `line()`
  `[number, number, number]`, matching what the analyzer already emitted on v1.

  ### The bound on an inexact numeric column is the database's, not drizzle-zod's

  `real`, `double precision` and `numeric({ mode: 'number' })` on Postgres, `real`, `double` and
  `float` on MySQL and SingleStore, and `real` on SQLite carried no bound at all on 0.4x. The first
  pass at this adopted `drizzle-zod`'s numbers, and asking the database showed they are not limits of
  anything:

  - a `real` column stores 8388608, 9000000, 1e9 and 2147483648 and returns each unchanged, and holds
    every integer exactly up to 16777216. `drizzle-zod` bounds it at +/-8388607, so that bound
    refuses rows the column hands back.
  - a `double precision` column accepted every finite JavaScript number, measured to
    `Number.MAX_VALUE`, and returned each identical. `drizzle-zod` bounds it at +/-140737488355327,
    which refuses 1.75e15, an ordinary microsecond epoch.

  So the bounds are the database's now, and the 4 byte width has two of them, because the two
  databases that impose one do not agree on where it is. Both were bisected over the raw bit pattern
  of a double against a real server. Postgres accepts every double up to `3.4028235677973366e38` in a
  `real` and answers `out of range for type real` to the next one; MySQL 8.4 refuses everything past
  `3.4028234663852886e38`, the largest float32, which is 268435456 representable doubles lower, in
  strict mode and under the stock `sql_mode` alike. The gap is not academic: a `real` at full
  magnitude comes back over the text protocol as `3.4028235e+38`, which is inside Postgres's edge and
  outside the float32, so a schema bounded at the float32 refused a row the column had just handed
  back. An 8 byte float
  carries no magnitude bound, and states `integer: false` alongside, which is true of the column
  and is what keeps the _bounded_ widths from being read as integers: `isIntegerColumn` falls back to
  "declares both bounds" when the flag is absent, so without it a `real` schema would call `.int()`
  and refuse 1.5. On the unbounded widths the flag decides nothing, since there is no pair of bounds
  to fall back to. `numeric({ mode: 'number' })` keeps the safe-integer range, which is about
  what a JS number can carry rather than about the column.

  Measured against this repository's ground-truth stages, which insert every probe into a real
  Postgres. On the 1400 probes those stages carried before this release, DRZL's agreement with the
  database rose from 1007 to 1012 on the validator schemas and from 852 to 857 on the JSON Schema
  output. This release also adds the probe that would have caught the float32 mistake, the value a
  full-magnitude `real` returns, so the pool is 1440 probes now and the totals are not comparable
  across that line: DRZL agrees on 1048 of them against `drizzle-orm`'s 1013, is closer to the
  database on 35 and further on none. That last count, probes where DRZL disagrees with Postgres and
  the first-party module does not, stayed at 0 throughout.

  This puts DRZL deliberately looser than `drizzle-orm/{zod,valibot,arktype,typebox}` on six columns.
  Every one is waived in both parity passes with the measurement attached.

  ### Infinity and NaN are still refused, and that is not fixed

  Postgres stores and returns `Infinity`, `-Infinity` and `NaN` in `real` and `double precision`
  alike. No range admits any of them, and `z.number()` and `Type.Number()` refuse a non-finite number
  with no bound at all, so describing those columns honestly needs a union in every generator rather
  than a wider range. Filed, not fixed.

  One real consequence, stated because the first pass at this removed it silently: on 0.4x, valibot
  and arktype used to accept `Infinity` for these columns, because nothing bounded them. That is
  restored for every 8 byte float column, which now carries no bound again. For a 4 byte float it is
  not: the float4 magnitude bound excludes `Infinity`, so all four libraries refuse it there.

  ### The service and oRPC generators

  Both map a column through a short allowlist and fall to `unknown` for anything else, so a tuple
  column became `unknown` in the emitted TypeScript and `z.unknown()` in an oRPC router's input
  schema, which accepts anything at all including a `null` payload the insert will not survive. Both
  now emit the tuple: `[number, number]` in the service types, `z.tuple([z.number(), z.number()])`
  and the valibot equivalent in oRPC. ArkType keeps `unknown` there, measured rather than assumed:
  that generator emits its field values as quoted string-DSL fragments, and ArkType's string DSL has
  no tuple form.

### Patch Changes

- Updated dependencies [6fbdb22]
  - @drzl/analyzer@1.15.0

## 2.6.0

### Minor Changes

- 44b34b2: Stop shipping prettier inside three packages, and make the CommonJS build format at all

  `@drzl/validation-core`, `@drzl/generator-orpc` and `@drzl/generator-service` each published at
  about 2.8 MB packed and 11 MB unpacked. All three carried a copy of `formatCode` built on
  `await import('prettier')`, which is a specifier tsup resolves statically, so esbuild inlined the
  whole formatter behind it: prettier's Flow parser, its TypeScript parser, babel, postcss, yaml and
  the rest. Installing `@drzl/cli` pulled in roughly 32 MB of duplicated parsers.

  Prettier is now an optional peer dependency, marked external in every build that can reach it.
  The two private copies of `formatCode` are gone; both packages use the one exported by
  `@drzl/validation-core`, which they already depended on. The three packages now publish at 34 KB,
  15 KB and 8 KB packed, and 88 KB, 59 KB and 18 KB unpacked.

  **What changes for you.** DRZL formats with the prettier already in your project, using your
  config, exactly as before. If your project has no prettier and no biome, generated files are
  written as rendered: the same valid TypeScript with worse whitespace, rather than nothing at all.
  Add `prettier` as a dev dependency if you want it formatted.

  Along the way this fixes formatting for CommonJS consumers, where it never worked. The bundled
  prettier in `dist/index.cjs` called `createRequire(import.meta.url)`, and `import.meta.url` is
  undefined in a CJS bundle, so the first call threw, the `catch` swallowed it and the code came
  back unformatted. Every `require('@drzl/validation-core')` consumer carried 5.5 MB of formatter
  that could not run. Resolving the real prettier fixes it.

### Patch Changes

- Updated dependencies [44b34b2]
  - @drzl/validation-core@3.15.0

## 2.5.0

### Minor Changes

- 31d4a83: MySQL and SQLite parity, insert and update parity, and generated columns.

  The parity gate added last release covered Postgres select schemas. Extending it to three dialects
  and all three modes turned up **54 findings**, including two regressions from that same release.
  All are fixed and the gate now runs the full cross product.

  ### Insert schemas invited writes the database rejects

  The analyzer derived "generated" from `col.autoIncrement || col.isGenerated`, and
  **`col.isGenerated` is undefined on every Drizzle column of every dialect**, so the second half
  never fired at all. A `generatedAlwaysAs(...)` column and a `generatedAlwaysAsIdentity()` column
  both appeared in insert schemas, and an insert built from one is rejected by Postgres outright.

  The first half then over-fired in the other direction: a MySQL `autoIncrement` column was dropped
  from insert schemas entirely, when `AUTO_INCREMENT` supplies a value if you omit one rather than
  forbidding you from supplying your own. The same construct therefore behaved differently per
  dialect, since a Postgres `serial` was already merely optional.

  | Column                           | Before            | Now      |
  | -------------------------------- | ----------------- | -------- |
  | `generatedAlwaysAs(...)`         | present on insert | omitted  |
  | `generatedAlwaysAsIdentity()`    | present on insert | omitted  |
  | `generatedByDefaultAsIdentity()` | present           | optional |
  | MySQL `autoincrement()`          | omitted           | optional |

  ### Two regressions from the previous release

  Both were introduced by the v1 `dataType` mapper and are fixed here.

  - **MySQL `tinyint` and `mediumint` lost their bounds.** The mapper had no `int8` or `int24` case,
    so they fell to its bare-number arm, whose safe-integer bounds then _overrode_ the correct ones:
    a tinyint went from `+/-127` to `+/-9007199254740991` and stopped being an integer at all.
  - **MySQL `binary`/`varbinary` were treated as Postgres `bit`.** Both report `dataType: "string
binary"` and only the codec separates them, so every MySQL binary column rejected `''` and
    anything that was not a run of 0s and 1s at exactly the declared width.

  ### SQLite was skipped by the v1 path entirely

  SQLite columns carry a `dataType` but no `codec`, and the mapper gated on the codec. So the whole
  dialect stayed on class-name matching: `text({ mode: 'json' })` and the json blob modes emitted
  `z.any()`, `blob({ mode: 'buffer' })` emitted `z.unknown()` (which accepts `null` on a NOT NULL
  column), and `blob({ mode: 'bigint' })` lost its 64 bit range.

  ### MySQL widths that nothing else states

  `tinyint`, `mediumint`, `year` and the unsigned `serial` now carry their real ranges, and the text
  and blob families carry the cap the type itself implies, which is on no property of the column:

  | Column        | Now                                                 |
  | ------------- | --------------------------------------------------- |
  | `tinyint()`   | `-128 .. 127`                                       |
  | `mediumint()` | `-8388608 .. 8388607`                               |
  | `year()`      | `1901 .. 2155`                                      |
  | `serial()`    | `0 ..`, since it is unsigned                        |
  | `text()`      | `max(65535)`, `tinytext` 255, `longtext` 4294967295 |

  Gated on the dialect, because the codec names collide: Postgres `text` reports the codec `text`
  too and has no cap at all.

  ### Date columns accepted null

  `coerceDates` defaults to coercing on write, and that was `z.coerce.date()`, which is `new Date(v)`
  on anything. `new Date(null)` is the epoch and `new Date(true)` is one millisecond past it, so a
  NOT NULL timestamp column accepted `null`, `true` and `[1, 2]`, each silently becoming a real date.
  Coercion is now limited to strings and numbers, which is what the option was for.

  ### TypeBox cannot back an oRPC router, and now says so

  oRPC types `.input()`/`.output()` as a [Standard Schema](https://standardschema.dev). Neither
  `@sinclair/typebox` nor the newer `typebox` package implements it, while zod, valibot and arktype
  all do, so `validation.library` on an `orpc` generator does not accept `typebox` and the docs
  explain why. The standalone typebox generator is unaffected.

  While confirming that, the oRPC generator's library handling moved from chains of ternaries to a
  per-library table. The chains ended in `... : valibot`, so any library they did not recognise
  would have silently emitted valibot code rather than failing.

  ### `customType` columns keep their type

  A `customType` column has nothing checkable at runtime, and guessing from `getSQLType()` would be
  wrong: that reports the _database_ type, and `fromDriver` may map it to anything, so a
  `numeric(12,2)` custom column can hand back a number where a plain numeric hands back a string.

  It stays `z.unknown()`, and `typedJson` now recovers the declared type the same way it does for
  json, by referencing Drizzle's own inference:

  ```ts
  balance: z.custom<(typeof accounts.$inferSelect)['balance']>(),
  ```

  `drizzle-orm/zod` emits `z.any()` for these, losing both the type and the narrowing that `unknown`
  forces at the call site.

  ### The gate

  `verify:packed` now measures three dialects times three modes times each library, 15 combinations
  over 82 columns, and cross-checks DRZL's four generators against each other. Deliberate
  divergences are listed with their reasons and everything else fails the build.

### Patch Changes

- Updated dependencies [31d4a83]
  - @drzl/validation-core@3.5.0
  - @drzl/analyzer@1.8.0

## 2.4.1

### Patch Changes

- 6d6857f: Generated schemas now enforce what the column actually declares. They did not, so a 300
  character value in a `varchar(255)` and a `smallint` of 40000 both passed validation and failed
  at the database.

  Every target below was measured from `drizzle-orm/zod` at 1.0.0-rc.4 by building the schema and
  reading its checks, not guessed:

  | column                    | before             | now                                                     |
  | ------------------------- | ------------------ | ------------------------------------------------------- |
  | `varchar(255)`            | `z.string()`       | `z.string().max(255)`                                   |
  | `uuid()`                  | `z.string()`       | `z.uuid()`                                              |
  | `smallint()`              | `z.number().int()` | `.int().gte(-32768).lte(32767)`                         |
  | `integer()`               | `z.number().int()` | `.int().gte(-2147483648).lte(2147483647)`               |
  | `bigint({mode:'number'})` | `z.bigint()`       | `.int().gte(-9007199254740991).lte(9007199254740991)`   |
  | `bigint({mode:'bigint'})` | `z.bigint()`       | `.gte(-9223372036854775808n).lte(9223372036854775807n)` |

  The bigint row was not merely imprecise, it was wrong: `{ mode: 'number' }` yields a JS number, so
  a schema demanding a bigint rejected every valid row.

  Valibot and ArkType get the same constraints in their own idiom, `v.pipe(v.string(),
v.maxLength(255))` and `string <= 255`. Every ArkType form was executed against arktype itself,
  accepting a valid value and rejecting an invalid one, because an expression it cannot parse
  throws on import.

  ### Two dead switch cases in the analyzer

  `case 'PgUuid'` and `case 'PgBigInt'` never matched anything. Drizzle spells them `PgUUID`,
  `PgBigInt53` and `PgBigInt64`, so both fell through to a case-insensitive regex arm and came back
  as plain `TEXT` and `bigint`. That is why uuid lost its format and why bigint ignored its mode.

  ### New on `Column`

  `maxLength`, `min`, `max` and `format`. `dbType` is unchanged, since consumers switch on it.
  Bounds are decimal strings because a 64 bit bound is not representable as a JS number:
  `9223372036854775807` rounds the moment it becomes one, so a numeric field would emit a bound
  that is quietly wrong.

  `@drzl/generator-orpc` also drops its `zod` dependency. It never imported it; the only occurrence
  was a template literal emitted into generated code, so it was forcing zod on Valibot and ArkType
  users for nothing.

- Updated dependencies [c90fd42]
- Updated dependencies [6d6857f]
- Updated dependencies [6d6857f]
  - @drzl/validation-core@3.1.0
  - @drzl/analyzer@1.6.0

## 2.4.0

### Minor Changes

- ebf3da7: `includeRelations` now also emits lookups that return another table: the inverse of a foreign
  key, and the far side of a many-to-many.

  ```ts
  // users router, because posts.authorId points here
  listPosts: listPostsUsers,

  // posts router, because posts and tags are joined by posts_to_tags
  listTags: listTagsPosts,
  ```

  The analyzer has reported both since 1.5.0, including `kind: 'manyToMany'` with the join table in
  `via`. What was missing is that the output schema lives in another router file, and those imports
  are circular the moment both directions exist, which many-to-many always does.

  An eager reference typechecks perfectly and then throws `Cannot access SelecttagsSchema before
initialization` on the first import of the router. So the reference is deferred:

  ```ts
  .output(z.array(z.lazy(() => SelecttagsSchema)))
  ```

  `v.lazy` for Valibot. With `validation.useShared` every router imports the one barrel instead, so
  no cycle arises, and the wrapper is harmless there.

  ArkType is excluded. Its deferred form differs enough that emitting an untested shape would be
  guessing, and an endpoint that fails to load is worse than one that is absent; its own
  foreign-key lookups are unaffected.

  `scripts/verify-packed.sh` now imports the generated router graph rather than only compiling it,
  because this class of defect passes a typecheck and only fails at module initialisation.

### Patch Changes

- Updated dependencies [114b91d]
  - @drzl/analyzer@1.5.1

## 2.3.2

### Patch Changes

- Updated dependencies [b0543a4]
  - @drzl/validation-core@3.0.0
  - @drzl/analyzer@1.5.0
  - @drzl/template-orpc-service@2.3.2

## 2.3.1

### Patch Changes

- 9e86204: `validation.importPath`, `dbImportPath` and `schemaImportPath` now produce imports that resolve.
  They were emitted verbatim, so the config in the getting-started guide generated three imports
  that resolved to nothing, under every module resolution.

  These options get written as project-relative paths, `src/validators/zod`, because that is how
  the rest of the config names directories. Emitted verbatim that is a _bare_ specifier: Node and
  tsc look for a package of that name in node_modules and never consider the local file.

      from "src/validators/zod"          before
      from "../validators/zod/index.js"  after

  Each configured path is now classified before use. A package name (`zod`, `@acme/schemas`) is
  left exactly as written. A path already relative keeps its own spelling and only has its
  extension corrected, so anyone who followed the older guidance and wrote
  `../validators/zod/index.js` is unaffected. Anything else is treated as project-relative and
  rewritten against the directory of the file doing the importing.

  Whether a path names a file or a directory is asked of the filesystem, because
  `src/db/connection` and `src/validators/zod` are indistinguishable as strings and are usually a
  file and a directory holding a barrel. A directory gains `/index`. Where nothing exists yet,
  which happens when one generator runs before the one that writes its target, an extensionless
  path is taken to be a directory, since these options name directories by convention and the only
  path that can legitimately be missing is a generated barrel.

  Since a non-relative value could only ever have produced an import that resolved to nothing,
  rewriting it cannot break a setup that worked.

  Exposed by `resolveConfiguredImport` in `@drzl/validation-core`, so all three call sites share
  one rule.

- Updated dependencies [9e86204]
  - @drzl/validation-core@2.1.0

## 2.3.0

### Patch Changes

- b8b44ec: Two defects in generated output that stopped it resolving or typechecking, both found by running
  the published packages rather than the workspace.

  **The service import was not a usable specifier.** `@drzl/template-orpc-service` built it by
  hand and got two things wrong at once:

      import { PostService } from "services/postService";       // before
      import { PostService } from "./services/postService.js";  // after

  `path.relative` returns a bare `services` whenever the services directory sits inside the
  router's output directory, and a specifier without a leading `./` is a _bare_ specifier: Node
  looks for a package of that name in node_modules and never considers the file next door. It also
  carried no extension, making it the one relative import DRZL emitted that failed under
  `moduleResolution: node16` and `nodenext`, despite 2.0.0 stating that every relative specifier
  now ends in `.js`. It goes through `importSpecifier` now, the same helper the router barrel uses,
  so it honours `importExtension` like everything else. `@drzl/generator-orpc` also now passes
  `importExtension` into the template context, which it previously had no way to see.

  **Service types rejected `null` for nullable columns.** A nullable column was emitted as
  optional, which admits `undefined` and not `null`:

      balance?: number          // before
      balance: number | null    // after, in Select
      balance?: number | null   // after, in Insert and Update

  Optional and nullable are different: `foo?: T` means the key may be absent, `foo: T | null` means
  it is present and may be null. So a row read back with a real `null` did not match `Select`, and
  passing `null` to update was a type error, while the validation generators emitted
  `z.number().nullable()` for the same column. Both halves of one generated project disagreed about
  the same database. `Select` no longer marks anything optional either: a row read back carries
  every column, whatever its default.

  Both were invisible because `scripts/verify-packed.sh` ran the oRPC generator with the default
  template, which imports nothing DRZL generated and never touches the service types. It now uses
  `@drzl/template-orpc-service`, so every generated module is imported and typechecked by another.

- Updated dependencies [b8b44ec]
  - @drzl/template-orpc-service@2.3.0

## 2.2.0

### Minor Changes

- 839cd23: Generated oRPC routers now compile. They did not, with any built-in template, for as long as the
  package has existed.

  `create` and `update` declared `.output(SelectSchema)` and then returned the input. The input is
  the _insert_ shape, where generated and defaulted columns are optional, while select requires
  them, so `tsc --strict` rejected every generated router: three errors on a two-table schema. It
  went unnoticed because nothing ever compiled the output.

  Returning the input was not merely mistyped, it was the wrong answer. A created row carries
  generated columns the input never had, so no cast would have made it correct. Both stubs now
  throw a `Not implemented` error naming the table and what to do. That satisfies the declared
  contract, since a body which only throws has type `never`, and an unimplemented endpoint now
  fails loudly instead of silently returning a malformed object.

  `list`, `get` and `delete` are unchanged: `[]`, `null` and `true` are each a truthful value of
  the declared output type. `@drzl/template-orpc-service` is also unchanged, because it delegates
  to a service layer and already returns the select shape; the fix belongs in the stub templates,
  not in the generator, which must never rewrite a real implementation.

  **If you have generated routers and filled in the handlers, nothing changes.** If you were
  relying on the stub bodies, `create` and `update` now throw rather than echoing the input back.

  Also fixes `@drzl/cli` never passing `servicesDir` to the oRPC generator. The option is declared
  on the generator and read by `@drzl/template-orpc-service`, which fell back to `src/services`
  whatever the service generator was configured to use. Pairing that template with, say,
  `{ kind: 'service', path: './src/api/services' }` emitted a router importing a module that was
  never created. The CLI now passes the service generator's actual path.

### Patch Changes

- Updated dependencies [839cd23]
  - @drzl/template-standard@2.2.0

## 2.1.0

### Minor Changes

- 9e87f39: `includeRelations` now generates endpoints. It was accepted and then ignored: nothing in the
  package ever read `analysis.relations` or `Table.foreignKeys`, so setting it changed no byte of
  output while docs/examples/relations.md promised endpoints like `listByParentId`.

  Each single-column foreign key now produces a lookup on its own table's router, named after the
  column that holds it. A `posts` table with `authorId` gains `listByAuthorId`, taking
  `{ authorId }` and returning an array of that table's select schema, in whichever validation
  library is configured.

  Naming follows the column rather than the referenced table, because two keys frequently point at
  the same table: `authorId` and `editorId` both referencing `users` yield `listByAuthorId` and
  `listByEditorId`, where naming by table would emit one procedure twice under the same key.

  Composite foreign keys are skipped, having no single scalar to accept. The inverse direction is
  not generated, since it would return another table's rows and require an import the file cannot
  resolve. Many-to-many links are reported by the analyzer but not yet traversed by the generator.

  Procedures are synthesised by the generator rather than by a template, so the flag works with
  every template including custom ones. They are strictly additive: the CRUD surface is identical
  whether or not the flag is set, and a template declaring a procedure of the same name keeps its
  own.

  Also removes `src/analyzer-types.d.ts` from this package and from `@drzl/generator-service`. Each
  was a `declare module '@drzl/analyzer'` block that shadowed the real types of a package both
  already depend on, with a hand-maintained subset that had drifted: no `primaryKey`, `unique`,
  `indexes`, `checks` or `foreignKeys`, and `relations` typed as `any[]`. Both packages compile
  against the genuine types now, so the analyzer's shape cannot silently disagree with what its
  consumers believe it to be.

### Patch Changes

- Updated dependencies [53a72d2]
  - @drzl/analyzer@1.4.0

## 2.0.0

### Major Changes

- 6903012: **Breaking:** every relative specifier DRZL generates now ends in `.js`, so the generated
  tree compiles under `moduleResolution: node16` and `nodenext`.

  ### What you will see

  Regenerate and the specifiers gain an extension. Nothing else about the output changes, and
  no file is renamed:

  ```diff
    // src/validators/zod/index.ts
  - export * from './users.zod';
  + export * from './users.zod.js';

    // src/api/index.ts
  - import { users } from './users';
  + import { users } from './users.js';

    // src/services/userService.ts
  - import type { Insertusers, Updateusers, Selectusers } from './types/users';
  + import type { Insertusers, Updateusers, Selectusers } from './types/users.js';
  ```

  If your build already worked, it still works: `./users.zod.js` resolves to `users.zod.ts`
  under `bundler` and `node10` exactly as the extensionless form did, and it is what Vite,
  esbuild, Rollup, Bun, Vitest and Next.js expect. It will show up in your next diff, and it
  is a good idea to regenerate in one commit of its own.

  ### Why

  Generated files land in your own source tree, so your `tsconfig.json` decides which
  specifiers resolve. Measured against tsc 5.9.2 and 7.0.2, for a specifier naming a sibling
  `.ts` file:

  | specifier        | `bundler` | `node10` | `node16`/`nodenext`, CommonJS | `node16`/`nodenext`, ESM |
  | ---------------- | --------- | -------- | ----------------------------- | ------------------------ |
  | `./users.zod.js` | resolves  | resolves | resolves                      | resolves                 |
  | `./users.zod`    | resolves  | resolves | resolves                      | **does not resolve**     |

  The extensionless form DRZL emitted before this release cannot be imported from an ES module
  under `node16` or `nodenext`. `tsc` reports `TS2307: Cannot find module './users.zod'` on the
  barrel and the build stops, and that was true of the default `fileSuffix`, not only of custom
  ones. That combination is now the common one: `tsc --init` has emitted `"module": "nodenext"`
  since TypeScript 5.9, every `@tsconfig/node*` base sets `"moduleResolution": "node16"`, and
  TypeScript 7 removed `node10` altogether, leaving `bundler`, `node16` and `nodenext` as the
  only three settings that exist.

  ### If `.js` is wrong for you

  Set `importExtension`, at the top level for every generator or on a single generator to
  override it:

  ```ts
  export default defineConfig({
    schema: 'src/db/schema.ts',
    importExtension: 'none', // 'js' (default) | 'none' | 'ts'
    generators: [{ kind: 'zod', path: 'src/validators/zod' }],
  });
  ```

  - `'none'` restores the pre-2.0 output byte for byte. Use it if your pipeline cannot map
    `.js` back to `.ts`: webpack without `resolve.extensionAlias`, or Jest with `ts-jest` and
    no `moduleNameMapper`.
  - `'ts'` emits `./users.zod.ts`, which needs `"allowImportingTsExtensions": true`. It is the
    only form Node's own type stripping accepts, so it suits running the generated `.ts`
    unbuilt.

  `importExtension` only touches specifiers DRZL invents. Paths you write yourself are still
  emitted verbatim, so on `node16`/`nodenext` in an ES module an `orpc` generator's
  `validation.importPath` has to name the barrel file rather than its directory
  (`'../validators/zod/index.js'`, not `'../validators/zod'`), and the `service` generator's
  `dbImportPath` and `schemaImportPath` need their own `.js`.

  `@drzl/validation-core` exports `ImportExtension`, `DEFAULT_IMPORT_EXTENSION`,
  `IMPORT_EXTENSIONS` and `importSpecifier`, and `moduleSpecifier` takes the extension as a
  third argument, so the five generators cannot disagree about how a module is spelled.
  `@drzl/generator-service` gains a dependency on `@drzl/validation-core` for that reason.

### Minor Changes

- 2f9214e: Add `affix`, so generated identifiers are not stuck on `Insert<Table>Schema`.

  Resolves #16. Set `affix` on a `zod`, `valibot` or `arktype` generator to choose
  the prefix and suffix of the exported schema constants and of the type aliases,
  separately, and either as one string for all three modes or per mode:

  ```ts
  {
    kind: 'zod',
    path: 'src/validators/zod',
    affix: {
      tableCase: 'pascal',
      schema: { suffix: 'Schema' },
      type: {
        prefix: { insert: 'Create', update: 'Edit', select: '' },
        suffix: { insert: 'Input', update: 'Input', select: '' },
      },
    },
  }
  ```

  which emits `InsertUsersSchema`, `CreateUsersInput`, `EditUsersInput` and a bare
  `Users` instead of `InsertusersSchema` and `SelectusersOutput`.

  `tableCase` addresses the second half of that issue. Generated identifiers
  interpolate the Drizzle export name exactly as written, so a table exported as
  `users` produces `Insertusers`. `tableCase: 'pascal'` upper-camels it first,
  splitting on `_`, `-` and camel boundaries, so `user_profiles` and `userProfiles`
  both give `InsertUserProfilesSchema`. The default is `preserve`, which keeps the
  existing behaviour; changing the default is a major-version decision.

  Naming now comes from one resolver in `@drzl/validation-core`
  (`resolveAffix`, `schemaName`, `typeName`, `validateAffix`, `pascalCase`) instead of
  template literals repeated in four packages, which is what lets both sides of an
  import agree. When an `orpc` generator uses `validation.useShared` and exactly one
  sibling generator produces that library, the sibling's `affix` is copied onto it,
  so the router imports the names the validation generator actually exported.
  A `validation.affix` that is set explicitly and disagrees with that sibling now
  fails the run, listing both sets of names, rather than writing a router that does
  not compile.

  Configs are checked before anything is written: an affix that could not appear in
  a TypeScript identifier, or that would put two same-named exports in one file, is
  rejected with the path to the offending option.

  Nothing changes for existing configs. Omitting `affix` reproduces the previous
  output byte for byte, `schemaSuffix` still works and is the default for
  `affix.schema.suffix`, and affixes rename identifiers only, never files or module
  specifiers.

- 549ee51: Type `numeric` and `decimal` columns as strings, matching what Drizzle returns.

  Generated validators previously typed them as numbers, so a select schema
  rejected every row the database returned ("expected number, received string"),
  and an insert schema rejected the string the driver wants while accepting a
  number it does not.

  `bigint({ mode: 'number' })` is now read as a number rather than a bigint, and
  `real`/`doublePrecision` are separated from `numeric` since those really are
  JS numbers.

  If you were working around the old behaviour by coercing numeric values, that
  workaround should be removed.

### Patch Changes

- 20a5b9d: Escape enum values and column names in generated oRPC routers.

  Enum values and column names were interpolated into the emitted code with hand-written quotes, so an
  enum value containing an apostrophe, or a column name that is not a bare identifier, produced
  unparseable output. Prettier then threw while formatting it and the whole generate run aborted rather
  than failing on just that column.

  Both are now encoded with `JSON.stringify`, matching what the standalone zod, valibot and arktype
  generators already did.

- Updated dependencies [2f9214e]
- Updated dependencies [6034a24]
- Updated dependencies [6903012]
- Updated dependencies [549ee51]
  - @drzl/validation-core@2.0.0
  - @drzl/analyzer@1.3.0

## 1.1.0

### Minor Changes

- c48d79a: sponsor initiatives

### Patch Changes

- Updated dependencies [c48d79a]
  - @drzl/template-orpc-service@1.1.0
  - @drzl/template-standard@1.1.0
  - @drzl/analyzer@1.2.0

## 1.0.0

### Major Changes

- 5da6f6b: support MySQL, SingleStore, and Gel; expand Postgres/SQLite; add tests (fixes #13)

### Patch Changes

- Updated dependencies [5da6f6b]
  - @drzl/analyzer@1.0.0
  - @drzl/template-orpc-service@1.0.0
  - @drzl/template-standard@1.0.0

## 0.4.0

### Minor Changes

- 811dd61: feat: strict database injection for services and oRPC middleware (typed db context; valibot v1 compatibility)

### Patch Changes

- Updated dependencies [811dd61]
  - @drzl/template-orpc-service@0.4.0

## 0.3.0

### Patch Changes

- @drzl/analyzer@0.3.0
- @drzl/template-standard@0.3.0

## 0.2.0

### Patch Changes

- @drzl/analyzer@0.2.0
- @drzl/template-standard@0.2.0

## 0.1.0

### Patch Changes

- @drzl/analyzer@0.1.0
- @drzl/template-standard@0.1.0

## 0.0.3

### Patch Changes

- @drzl/analyzer@0.0.3
- @drzl/template-standard@0.0.3

## 0.0.2

### Patch Changes

- @drzl/analyzer@0.0.2
- @drzl/template-standard@0.0.2

## 0.0.1

### Patch Changes

- @drzl/analyzer@0.0.1
- @drzl/template-standard@0.0.1
