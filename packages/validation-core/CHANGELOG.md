# @drzl/validation-core

## 3.22.6

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

## 3.22.5

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

## 3.22.4

### Patch Changes

- 8903870: `CHECK (LENGTH(col) <= n)` on MySQL is a byte budget, and is now read as one

  The CHECK parser is one parser for every engine, and `length()` is not one function:

  ```
              length()      char_length()   octet_length()
  Postgres    characters    characters      bytes
  SQLite      characters    characters      bytes
  MySQL       BYTES         characters      bytes
  ```

  So `CHECK (LENGTH(name) <= 5)` on a MySQL `varchar` was read as a five-character cap where the
  server enforces five bytes. Measured on 8.4.11 on utf8mb4 through a real constraint: `'一'` is
  accepted at three bytes and `'一二'` is refused at six bytes and two characters, while the schema
  accepted the second. The error ran in the safe direction, since five bytes can never be more than
  five characters, so no valid row was ever turned away; it under-enforced, which is the half a
  validator exists for.

  Verified end to end after the fix, the emitted schema against the server that enforces the CHECK:
  six values covering ASCII, CJK and emoji, at and over the bound, and the two agree on every row.

  `Table` now carries the engine it was declared for. That is the same kind of duplication `Column`
  already has, where `maxBytes`, `allowsNaN` and `format` are dialect-derived facts stamped on so
  nothing downstream has to know which server it is looking at; the shared check helpers take a
  `Table` rather than an `Analysis`, and `length()` is the one thing they could not read without it.
  `parseCheck` takes the dialect as an optional third argument, and absent still means the Postgres
  reading, so a caller that does not know its engine keeps the answer it already had.

  `LengthCheck` also carries the function as written. The label the constraint ledger matches an
  issue's message against is built from it, and deriving the name back from the unit would have
  relabelled a user's `length(name) <= 5` as `octet_length(name) <= 5`: a constraint they did not
  write, in the one string two surfaces compare exactly. `char_length` is still printed as `length`,
  which Postgres treats as the same function.

  SingleStore is MySQL wire-compatible and is deliberately not claimed, for the reason the analyzer
  gives everywhere else: no server of its own was measured.

- Updated dependencies [8903870]
  - @drzl/analyzer@1.21.4

## 3.22.3

### Patch Changes

- 08c2189: Character caps stop spreading the string when it cannot matter

  Every emitted character cap counted code points as `[...v].length`, which allocates an array of
  code points on the path every ordinary row takes. A UTF-16 unit count is free and is never smaller
  than a code-point count, since only a surrogate pair spends two units on one code point, so a
  string already short enough in units cannot be too long in characters:

  ```ts
  // before
  .refine((v) => [...v].length <= 64, { message: 'at most 64 characters' })
  // after
  .refine((v) => v.length <= 64 || [...v].length <= 64, { message: 'at most 64 characters' })
  ```

  Measured on real emitted output, validating a whole five-column row rather than a lone field, with
  the two modules differing in exactly that one expression: zod `1646k/s` to `6925k/s`, 4.2x; TypeBox
  on the compiled path `2098k/s` to `31856k/s`, 15.2x. Both accepted exactly the same rows. On the
  check alone at a cap of 64, ordinary ASCII rows go `23171k/s` to `215029k/s`, and rows sitting at
  the cap `4250k/s` to `235657k/s`.

  The same rewrite applies to every length `CHECK` the parser reads, in the direction each operator
  allows: a cap short-circuits on the accept side, a minimum on the reject side, `=` on the reject
  side and `<>` on the accept side. Which rewrite is sound for which operator is now decided once, in
  `codePointCompare`, rather than in the five generators that each had their own operator table.

  Nothing changes about what is accepted. The equivalence is asserted rather than argued: every
  operator is evaluated against the bare spread over astral pairs, combining marks, a lone surrogate,
  the empty string and CJK at the bound, and then over a 4000-string pseudo-random pool, 24000
  comparisons in all.

- Updated dependencies [866dbaa]
  - @drzl/analyzer@1.21.3

## 3.22.2

### Patch Changes

- b37c158: A temporal column carried as text no longer accepts a blank string

  `date({ mode: 'string' })`, `timestamp({ mode: 'string' })`, `time()` and `interval()` were typed
  `string` and stated nothing else, so every generator emitted a bare string and the schema accepted
  `''`. Postgres refuses `''` for every one of those types, so the schema admitted a write the
  database will not take. `''` is what an untouched form control submits, which is how it reaches an
  insert.

  The check is a floor, not a shape, and deliberately so. A date-shaped pattern turns away rows the
  server stores: Postgres reads `'today'`, `'January 8, 1999'`, `'01/08/1999'` and `'20200101'` as
  dates, which is why `format` has never carried a date entry. What survives is `\S`, unanchored, so
  it means "holds at least one non-whitespace character". Measured through PGlite, every Postgres
  temporal type refuses `''` and `' '` and accepts a valid value with surrounding whitespace, so this
  refuses exactly the set the server refuses and nothing else.

  Which columns carry it is decided per engine and per type, because the servers do not agree:

  - **Postgres** marks `date`, `time`, `timetz`, `timestamp`, `timestamptz` and `interval`.
  - **MySQL** marks `date`, `datetime` and `timestamp`, and deliberately **not** `time`. Measured on
    8.4.11 in `STRICT_TRANS_TABLES`, a `time` column accepts `''` and stores `00:00:00`, silently,
    with `SHOW WARNINGS` empty. Refusing there would be stricter than the server.
  - **SQLite** marks nothing, since it stores whatever text it is given, and SingleStore, mssql and
    Cockroach are unmarked because no server of theirs was measured.

  The marker is set on both drizzle majors, through the codec on 1.x and the class name on 0.4x, and
  a test asserts the two describe every column in the grid identically. Every generator picks it up
  through the existing format mechanism, so zod, valibot, ArkType, TypeBox, Effect and JSON Schema all
  state it without a change of their own.

  The date modes of the same columns are untouched: those are a `Date`, not a string.

- Updated dependencies [b37c158]
  - @drzl/analyzer@1.21.2

## 3.22.1

### Patch Changes

- acef357: Fix a dead link that shipped in every one of these READMEs. They pointed at
  `docs/sponsor.md`, and only `dist` is listed in `files`, so on npm that path resolves to nothing.
  They now point at https://use-drzl.github.io/drzl/sponsor, which answers 200. npm publishes README
  regardless of `files`, which is what makes this a change to the published artifact rather than a
  repository-only edit.

  The CLI README additionally listed four of its eight commands, omitting `doctor` and `explain`
  despite both having their own documentation pages, and did not say that all fourteen generators
  arrive with the CLI so no separate install is needed.

- Updated dependencies [acef357]
  - @drzl/analyzer@1.21.1

## 3.22.0

### Minor Changes

- 062f305: A JSON Schema for `drzl.config.json`, and a config scaffold that completes

  `drzl.config.json` has been a supported config form since the loader was written, and it was the
  one form with no completion of any kind: a `.ts` config gets the shape from `defineConfig`, a JSON
  config got nothing. `@drzl/cli` now ships `dist/drzl.config.schema.json`, generated at build time
  from the same zod schema that validates the config, so the two cannot describe different things.
  Point at it with a `$schema` key (`./node_modules/@drzl/cli/dist/drzl.config.schema.json`), or map
  `drzl.config.json` to it in VS Code's `json.schemas`. The same file is published at
  `https://use-drzl.github.io/drzl/drzl.config.schema.json`. `$schema` is stripped by the loader, so
  the key is safe to leave in the file.

  Two properties of `z.toJSONSchema` decide whether a generated schema is worth shipping, and both
  are now measured rather than assumed. Its `io` option defaults to `'output'`, which marks every key
  carrying a `.default()` as `required`: `outDir`, `importExtension`, `analyzer` and `generators` are
  all defaulted, so that schema rejects all 34 configs in the documentation and every minimal config
  a reader writes. The generator passes `io: 'input'`, which rejects none of them. Refinements are
  also dropped silently, and `ConfigSchema`'s single `.superRefine` is the affix rule, so the
  generated schema would have accepted `affix: { schema: { suffix: 'my-schema' } }` and the CLI would
  then have refused to generate from it. The character half of that rule is re-encoded as a JSON
  Schema `pattern`, built from the same string `validateAffix` compiles its regex from, and a test
  fuzzes the two against each other over every printable ASCII codepoint in three positions. The
  collision half, two modes resolving to the same identifier, is a comparison between sibling values
  that JSON Schema cannot express; it stays a CLI-only error and is documented as one. Every other
  verdict matches the CLI, including unknown keys: permissive where `ConfigSchema` strips them,
  `additionalProperties: false` where the zod object is `.strict()`.

  `drzl watch` never reloaded a JSON config. `computeWatchTargets` carried its own copy of the config
  filenames and the copy was missing `drzl.config.json`, so the file loaded on the initial build and
  no later edit to it ever fired an event. Its test spelled the same four names a third time and
  agreed with the bug. The loader, the watcher and the test now read one exported
  `CONFIG_FILE_NAMES`.

  `drzl init` scaffolded a bare `export default { ... } as const`, so the first config a new user
  sees was the one with no type attached and no completion. It now emits
  `import type { DrzlConfigInput } from '@drzl/cli/config'` and `satisfies DrzlConfigInput`. The
  import is type-only on purpose: `drzl init` also runs under `npx` in a project with no local
  `@drzl/cli` to resolve, and a type-only import is erased before the config executes, where the
  `defineConfig` value import the docs use would have made the first `generate` fail on a missing
  module.

  `@drzl/validation-core` exports `AFFIX_PREFIX_PATTERN` and `AFFIX_SUFFIX_PATTERN`, the affix
  character rule in JSON Schema `pattern` form, beside the regexes that enforce it.

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

- c56125f: Bound a `bigint({ mode: 'string' })` column by the input syntax its own server parses, per dialect

  The arm that typed this column a string (addendum BK) stated nothing else, so every generator
  emitted a bare string. Graded against a real Postgres through PGlite with the parity gate's own
  36-value probe pool, that schema disagreed with the server on **14** of them, and on every one
  of the 14 `drizzle-orm`'s own validator agreed with the server: `''`, `'hello'`, a 300-character
  run, three and five emoji, `'12.5'`, a uuid, `'not-a-uuid'`, `'happy'`, `'zzz'`, `'2020-01-01'`,
  `'12:00:00'`, `'10.0.0.1'` and `'999.999.999.999'` all validated and then failed at the INSERT,
  which is the outcome an insert schema exists to prevent.

  The column now carries a `format`, which is the vehicle all six validation generators already
  route through `COLUMN_FORMATS`, so nothing in any generator changed. There are **two** patterns,
  because the two servers disagree in both directions, measured on PGlite and on a live MySQL
  8.4.11: Postgres stores `'0x1f'` as 31 and `'1_000'` as 1000 and refuses `'12.5'`, while MySQL
  refuses the first two as "Data truncated" and stores `'12.5'` as 13, rounded. A single pattern
  would have to be their union, which readmits `'12.5'` on Postgres and leaves the defect standing,
  or their intersection, which turns away rows each server really stores. So Postgres gets an
  integer-literal grammar (sign, surrounding whitespace, underscore separators, decimal or
  `0x`/`0o`/`0b`, leading zeros, and the `_` Postgres allows directly after a base prefix) and
  MySQL gets a decimal-number grammar with an optional fraction and exponent. SingleStore takes
  MySQL's, as every other MySQL-shaped answer in the analyzer does; SQL Server takes neither,
  because no SQL Server was measured for its conversion rules, and Cockroach never reaches the arm
  at all.

  Verified against the servers rather than reasoned about. Postgres: 16160 probes, boundary sweeps
  in all four bases and random shapes, **zero** values the server takes and the pattern refuses.
  MySQL: 3319 probes against each of a signed and an unsigned column, **zero** again. The read path
  is covered too, since the `bigint:string` codec casts to text and registers no normalize, so a row
  written `'0x1f'` reads back `'31'`: every value either server hands back validates.

  Neither pattern states the magnitude, and that is deliberate. On MySQL it is not expressible: the
  range applies to the **rounded** value, so `'9223372036854775807.4'` is a row and
  `'9223372036854775807.6'` is not, and `'92233720368547758070e-1'` is the int64 maximum. On
  Postgres it is expressible, and the exact ladder was built and agreed with the server 16160/16160,
  but leading zeros and separators make it a per-digit ladder of about 1200 characters, and the
  ArkType generator states a format as a regex literal inside the type expression: the emitted
  module then fails to compile with TS2589, measured on the real emitted output, where the 101
  character pattern that ships compiles clean. Emitting a module that does not typecheck is a worse
  failure than the bound it buys, and every value the pattern admits that Postgres refuses is
  exactly an out-of-range magnitude, so the syntax half is complete on its own. The tests assert
  that remainder in both directions, so stating it later reports itself.

  The unsigned spelling shares the MySQL pattern, and that is what makes it agree with the database:
  `drizzle-orm` at 1.0.0-rc.4 caps `bigint({ mode: 'string', unsigned: true })` at the signed int64
  maximum and so refuses `'18446744073709551615'`, which MySQL 8.4.11 stores in a `bigint unsigned`
  and hands straight back. DRZL accepts it.

  Every other column shape is untouched, proved rather than asserted: master's dists and this
  branch's were run side by side over the parity gate's three fixtures, and all 90 emitted files are
  byte identical. With a mode-string bigint column added to the Postgres and MySQL fixtures, 78 of
  90 stay identical and the 12 that differ are exactly the two `matrix` modules in each of the six
  generators, each diverging first at the new column's own line.

- 28787ff: Biome formatting is refused unless Biome is actually installed in the project, which makes generated
  output byte-identical under Bun and Node again

  Under Bun, `drzl generate` emitted differently formatted files from Node over the same schema and the
  same config, and reached the network to do it. Measured on a packed install of `@drzl/cli` 4.22.0
  against Bun 1.3.14, Node 22.22.0 and Deno 2.9.5, in a project whose package.json had never mentioned
  Biome: Node emitted the generator's own two-space output, and Bun emitted tab-indented Biome output,
  after downloading `@biomejs/biome` 2.5.7 and a multi-megabyte platform binary mid-generate. Running
  `drzl generate --check` under Node against the Bun-generated tree then reported every file out of
  date, which is a CI failure produced entirely by the choice of runtime.

  **The mechanism is that resolving a package is not the same question as having it installed, on one
  runtime.** `formatCode`'s `auto` engine tries prettier, then Biome. The Biome branch locates the
  binary with `createRequire(...).resolve('@biomejs/biome/package.json')`, because the package declares
  only `bin` and cannot be imported. Node and Deno answer a missing package with MODULE_NOT_FOUND,
  which `formatCode` catches, leaving the code unformatted. Bun answers it by auto-installing from npm
  and resolving into its own global cache:

  ```
  node -> MODULE_NOT_FOUND
  deno -> MODULE_NOT_FOUND
  bun  -> ~/.bun/install/cache/@biomejs/biome@2.5.7@@@1/package.json
  ```

  It was not even stable within Bun. Whether the auto-install fired depended on the state of that
  cache, so the same command on the same tree emitted different bytes at different times: with the
  cache cold it installed and formatted, with the package present it formatted, and with the package
  deleted but the manifest cache warm it did not.

  **A second, independent Bun difference sat behind it.** Resolution was one `createRequire` with
  `resolve(spec, { paths: [outputDir, process.cwd()] })`. Node honours that list; Bun does not. With
  Biome genuinely installed and an absolute `outDir` pointing outside the project, which is the exact
  case `paths` was added for, Node fell back to the working directory and found the real install while
  Bun never tried the second entry and auto-installed instead. Fixing only the first half would have
  left a Bun user who really had installed Biome with no formatting at all.

  **What changes.** `isProjectInstallPath` is exported and gates the resolution: a manifest reached
  through a `node_modules` path segment is a project install, and anything else is refused. That
  discriminator is exact rather than a heuristic, since npm, pnpm's `.pnpm` store and Yarn PnP's zip
  and unplugged paths all reach a package through one, and Bun's auto-install cache is the only shape
  that does not. Resolution now anchors a separate `createRequire` at each candidate directory in turn,
  output directory first and working directory second, preserving the order of the `paths` array it
  replaces. Under Node and Deno the guard can never fire, because their resolvers have no other kind of
  path to return, so neither runtime changes at all.

  **Measured after the fix**, on packed tarballs installed with npm, with an absolute `outDir` outside
  the project: with no Biome installed, Node and Bun emit byte-identical unformatted output and Bun no
  longer spawns anything; with Biome installed, Node and Bun emit byte-identical Biome-formatted
  output. With the output directory inside the project, Node, Bun and Deno agree byte for byte in both
  cases. Red-first: the guard's spec fails against the previous code, and the working-directory
  fallback has a must-fire test that fails when that anchor is removed.

- 02fc84a: The valibot and ArkType generators refuse `Infinity` and `-Infinity` on a MySQL or SingleStore
  `float`, `double` and `real`, which the server refuses too.

  An infinity is a value the schema has to answer for per dialect rather than once, and until now the
  analyzer only ever said yes. Postgres genuinely stores both in a `real` and a `double precision` and
  hands them back on SELECT, so all four generators accept them there and that does not change. A real
  MySQL 8.4.11 in `STRICT_TRANS_TABLES` stores neither, in any of the three columns: measured on the
  binary prepared path, which is the one that puts the real IEEE double on the wire, `float`, `double`
  and `real` all answer `ER_WARN_DATA_OUT_OF_RANGE` for `Infinity`, `-Infinity` and `NaN` alike, while
  `double` and `real` take 1e300 and 3.4028235e38 unchanged. The column carried no flag at all for
  that, and an absent flag reads the same as an unmeasured one.

  **The mechanism is the magnitude bound, doing this by accident.** Measured on the installed
  libraries: `z.number()` and `Type.Number()` refuse a non-finite number with no bound at all, so zod
  and TypeBox were never affected. `v.number()` and ArkType's `number` take both infinities, and only
  a range holds them back, one end each, so `v.maxValue(n)` refuses `+Infinity` whatever `n` is and
  `number >= 0` still accepts it. MySQL's `float` carries the float32 range and was therefore already
  right; its `double` and `real` carry no finite bound, because every finite JS number fits in an
  8 byte float and no finite bound on one is truthful, and those are what leaked. Unlike the `NaN`
  leak this repeats, no union arm was needed: a bare `number` takes an infinity wherever it stands, so
  the two libraries leaked in `select`, `insert` and `update`, on the object and through a field
  pulled out of the schema.

  **What changes.** `@drzl/analyzer` now states the refusal outright, as `allowsNaN: false` and
  `allowsInfinity: false` on the MySQL and SingleStore `float`, `double` and `real` columns, on both
  the drizzle 0.4x class-name path and the v1 codec path. That is a third state rather than the
  absence of the first, and `@drzl/validation-core` gains `nonFiniteRefused` to read it: `true` is
  stored and returned, `false` is offered and refused, absent is unstated. The valibot generator emits
  `v.check((val) => Number.isFinite(val), 'a finite number')` and the ArkType generator a `.narrow`
  with the same predicate, in both cases only where no bound already refuses both ends. On ArkType
  that replaces the narrower `NaN` narrow on the same columns rather than joining it, since
  `Number.isFinite` is false for `NaN` too.

  **Postgres does not move, and neither does SQLite.** A Postgres `real` and `double precision` still
  accept `NaN` and both infinities in every mode, nullable or not. SQLite is deliberately untouched
  and is a third answer rather than MySQL's: a real SQLite 3.53.4 stores both infinities in a `real`
  and hands them back, and silently turns `NaN` into NULL, so its column still states neither flag and
  its emitted output is unchanged. MySQL's `decimal` is untouched for a similar reason: on the same
  prepared path the server silently stored `0.00` for all three where the text path answers `Incorrect
decimal value`, and "refuses" is only half true of a column that accepted the row.

  The zod, TypeBox, Effect and JSON Schema generators do not change. The first two already refused
  both infinities everywhere, Effect builds on `Schema.Finite` unconditionally, and JSON has neither
  value to express. Generated output is byte identical everywhere else: master's analyzer and
  generators run beside these over the same schemas produced 80 emitted file pairs, of which the 8
  that differ are exactly valibot and ArkType on MySQL and SingleStore, on both drizzle majors.

- Updated dependencies [cf19c30]
- Updated dependencies [c56125f]
- Updated dependencies [2c8b20b]
- Updated dependencies [02fc84a]
  - @drzl/analyzer@1.21.0

## 3.21.1

### Patch Changes

- 10af5d7: The duplicate finder now covers the primary key, which is the collision seed data actually has

  `findDuplicate<table>` scanned only the declared unique constraints, so two rows carrying the
  same explicit primary key sailed through and failed at the database with
  `duplicate key value violates unique constraint "users_pkey"` (23505, measured on Postgres 17),
  and a table whose only key is its primary key, a natural key like `skus.code`, got no finder at
  all. The database enforces a primary key with a unique index and its own error calls it a unique
  constraint, so the finder treats it as one: the key is checked first, named `<table>_pkey` the
  way Postgres names it, and reported like any other collision. Rows that leave a generated key to
  the database are untouched, because an absent or null column already skips a constraint, exactly
  as a unique index skips NULLs. Emitted output changes only where `duplicateFinder: true` is set.

## 3.21.0

### Minor Changes

- 1218361: Read three more CHECK shapes: a disjunction that pins one column, `IS NOT NULL`, and the null
  guard in front of a predicate

  `parseCheck` refused every expression holding `OR` and every expression holding `NOT`, which took
  `col IS NOT NULL` with it. Three of those refusals are now readings, one is unchanged, and one that
  used to be a generic "not a comparison" now says what it found.

  ```ts
  // check('status_valid', sql`${t.status} = 'draft' OR ${t.status} = 'live'`)
  status: z.enum(['draft', 'live'] as const).nullable(),

  // check('email_set', sql`${t.email} IS NOT NULL`)   // on a nullable column
  email: z.string(),

  // check('age_adult', sql`${t.age} IS NULL OR ${t.age} >= 18`)
  age: z.number().int().gte(18).lte(2147483647).nullable(),

  // check('tier_ok', sql`${t.tier} IS DISTINCT FROM 'banned'`)
  tier: z.string().refine((v) => v !== 'banned', { message: "tier_ok: tier <> 'banned'" }).nullable(),
  ```

  All five validator generators and the JSON Schema generator, plus `drzl doctor` and the constraint
  ledger.

  **Why a disjunction was refused, and what changed.** A conjunction splits because every part is
  independently _necessary_. A disjunction is the opposite: `CHECK (a OR b)` is satisfied by a row
  that breaks `a`, so a schema enforcing `a` refuses rows the database takes. Nothing about that
  argument has weakened. What is read is the one shape where the _whole_ disjunction is a single
  statement: every branch pinning the same column to a literal, by `=` or by `IN`. `s = 'a' OR
s = 'b'` and `s IN ('a','b')` are the same statement in SQL, NULL included, so they emit the same
  schema. Everything else is refused **whole**, never in part, and named:

  | Refused                     | Reason reported                                 |
  | --------------------------- | ----------------------------------------------- |
  | `n < 0 OR n > 100`          | a branch is a range rather than a set of values |
  | `a = 'x' OR b = 'y'`        | the branches constrain different columns (a, b) |
  | `s = 'a' OR s = 1`          | the branches mix a string and a number          |
  | `s = 'a' OR lower(s) = 'b'` | part of an OR was not understood                |

  **`IS NOT NULL` narrows the field rather than adding a predicate.** Every other CHECK is emitted
  _inside_ the nullable wrapper, precisely so `null` skips it, which is what makes them match SQL.
  This one is the statement that `null` is not allowed, so it is said by the field not being
  nullable. Applied once, in the three column selectors every generator already calls, so no
  generator learns a new kind of check and none of the six can disagree with the others. On insert
  the field becomes required, because a row omitting a nullable column with no default writes NULL;
  a column that defaults to a value stays optional. On a column already `.notNull()` it changes
  nothing and stops being reported as declined.

  **A null guard reduces away.** `col IS NULL OR P` states nothing beyond `P`, because a CHECK
  already passes on NULL and every operator here yields NULL when its column is NULL. Sound only when
  `P` names the guarded column and holds no null test of its own, so `a IS NULL OR b > 0` is still
  refused: with `a` null it accepts every `b`. `IS DISTINCT FROM <literal>` reduces the same way and
  emits byte for byte what the `<>` it means emits.

  **Arithmetic over two columns stays refused, and now says so.** `x + y < 100` used to report "not a
  single comparison this version understands". It now names the operator, and `drzl doctor` says what
  to do instead. The reason is measured rather than argued: Postgres computes `numeric` exactly and
  JavaScript computes in binary floating point.

  | Column type        | `CHECK (x + y <= 0.3)` with `(0.1, 0.2)` | JavaScript `0.1 + 0.2 <= 0.3` |
  | ------------------ | ---------------------------------------- | ----------------------------- |
  | `numeric(10,2)`    | accept                                   | false, so it would reject     |
  | `double precision` | reject                                   | false, so it would agree      |

  One expression, two column types, two different correct answers, and the expression does not carry
  the type. A `bigint` pair adds a third, since Postgres raises on overflow where `BigInt` does not.
  Any single reading is wrong for two of the three in the direction that refuses rows the database
  accepts, which is the failure this parser exists to avoid.

  **Ground truth.** 64 probes through a real Postgres (PGlite), one table per constraint so a sibling
  CHECK cannot fail the statement before the value under test is reached, each value put to both the
  database and the emitted insert schema: **0 rows the schema refuses and Postgres accepts**, 58
  agree, 6 wide. Every wide row is a constraint DRZL deliberately enforces nothing for, which is the
  safe direction.

  `IS NULL` on its own is read but enforced nowhere, since narrowing a field to only null would mean
  replacing the column's type rather than wrapping it; `drzl doctor` lists it with that reason.
  `NOT`, `NOT IN` and the boolean `IS TRUE` family remain refused.

- 45bb6f5: Emit the table's constraints as data, and map a validation issue back to the constraint that caused
  it

  `constraints: true` on the zod or valibot generator writes one more file, `constraints.ts`: every
  CHECK, unique constraint, primary key and foreign key on each table as plain objects, plus
  `constraintForIssue`, which turns a failed parse back into the constraint that produced it.

  ```ts
  { kind: 'zod', path: 'src/validators/zod', constraints: true }
  ```

  Off by default. With it off the emitted schemas are byte-for-byte what they were: this adds a file
  and changes nothing in the existing ones.

  **Why a schema is not enough.** A validator states what a value must look like and never says which
  constraint said so, so `Too small: expected number to be >=18` gives a form a message and no way to
  attribute it, no way to substitute its own wording for that rule, and no way to tell that failure
  apart from the column's own type bound. And two of a table's constraints are absent from a
  generated schema in every form: whether a value is already taken and whether the row it points at
  exists are facts about the table, not about the row.

  **What it maps, measured.** The same table and the same failing rows, on zod 4.4.3 and valibot
  1.4.2, both answering with the same constraint:

  | the row breaks          | zod reports                               | valibot reports                          |
  | ----------------------- | ----------------------------------------- | ---------------------------------------- |
  | `CHECK (age >= 18)`     | `too_small`, `minimum: 18`                | `min_value`, `requirement: 18`           |
  | `varchar(10)`           | `custom`, `at most 10 characters`         | `check`, `at most 10 characters`         |
  | `CHECK (length(...))`   | `custom`, `email_len: length(email) >= 3` | `check`, `email_len: length(email) >= 3` |
  | `CHECK (status IN ...)` | `invalid_value`                           | `picklist`                               |
  | `CHECK (starts < ends)` | `path: ['starts']`                        | `path: []`, naming no column             |

  The last row is why the map exists rather than being a one-line path lookup: valibot names no
  column for a row-level check, so the column comes out of the constraint data instead, and it is the
  same column zod chose.

  `CHECK (age >= 18)` is the other one. DRZL deliberately folds a numeric CHECK into the column's own
  range, which is worth keeping because it yields the library's machine-readable bound instead of a
  sentence DRZL wrote, and it costs the constraint name: the failure is worded entirely by the
  library. The map answers that by matching the bound, and answers a failure against the column's own
  `int4` ceiling with nothing rather than blaming the nearest CHECK.

  **Constraints nothing enforces are present and marked.** A CHECK the parser declines appears with
  `enforced: false` and the parser's own reason, because a form still wants to know the rule exists.
  It can never produce a validation issue, so it never comes back from `constraintForIssue`.

  **Not `meta` written to a second file.** `meta` describes a _field_, renders a CHECK as prose, has
  no foreign keys, drops the names of the unique constraints, and is reachable only by holding the
  schema object. This describes the table's _constraints_, carries their names, states each operand
  as data, and is a record keyed by table with no validator import. Both are built from one
  classification internally, so they cannot disagree about which CHECKs are enforced.

  **zod and valibot only, and the boundary is measured.** The data claims the schemas enforce each
  constraint and states the exact message they use. Measured on ArkType 2.2.3 against the same table,
  neither claim would hold: it folds `cardinality(tags) > 0` into its own DSL, moves a `length()`
  check onto the object, puts DRZL's wording in `expected` rather than `message`, and emits nothing
  at all for `name <> 'x'`.

  `{ errorMap: false }` emits the data without the matcher: for a table with twelve constraints, 1,855
  bytes minified against 2,831 with it, and 708 against 1,117 gzipped.

- f29bff7: Enforce `CHECK (octet_length(col) <= n)`, which is a byte budget rather than a character count

  `parseCheck` refused `octet_length` outright, on the recorded grounds that a byte count "depends on
  the encoding and cannot be derived from a JavaScript string without choosing one". Both halves of
  that are answerable: the encoding is UTF-8, and a `bytea` column does not arrive as a string at all.
  The constraint is now read and routed into the byte-cap machinery MySQL's TEXT family already used.

  ```ts
  // check('body_bytes', sql`octet_length(${t.body}) <= 5`)      // on a text column
  body: z.string().refine((v) => new TextEncoder().encode(v).length <= 5, {
    message: 'body_bytes: octet_length(body) <= 5',
  }),

  // check('blob_bytes', sql`octet_length(${t.blob}) <= 5`)      // on a bytea column
  blob: z.instanceof(Uint8Array).refine((v) => v.length <= 5, {
    message: 'blob_bytes: octet_length(blob) <= 5',
  }),
  ```

  **Three counts, and no two of them agree.** Measured on PostgreSQL 17.5 through PGlite, on a `text`
  holding three emoji and a `bytea` holding six bytes:

  | expression        | `text` | `bytea`        | JavaScript                                  |
  | ----------------- | ------ | -------------- | ------------------------------------------- |
  | `octet_length(x)` | 12     | 6              | `new TextEncoder().encode(v).length`        |
  | `length(x)`       | 3      | 6              | `[...v].length`, or `v.length` on the array |
  | `char_length(x)`  | 3      | does not exist | `[...v].length`                             |

  `v.length` on a string is none of them: it counts UTF-16 units, which is 6 for those same three
  emoji. So `length` is a character count on a text column and a byte count on a bytea one, and a
  parser that read `octet_length` as one more spelling of `length` would put a character cap on a byte
  budget. Measured on the real constraint: `CHECK (octet_length(t) <= 5)` accepts `'hello'` and one
  emoji and refuses `'hellos'` and two emoji, and it is the last of those, two characters and eight
  bytes, that a character cap takes and the column does not.

  The parser now carries a `unit` on `LengthCheck`, and `lengthMeasure(column, check)` turns that plus
  the column into one of three JavaScript expressions. It lives in `@drzl/validation-core` so the five
  validation generators, the constraint ledger, `meta` and `drzl doctor` cannot disagree about what is
  enforced.

  **JSON Schema.** No draft has a byte-length keyword, so the same trade the MySQL byte budget already
  made applies: the ceiling becomes `maxLength`, which counts characters and therefore refuses nothing
  the column accepts, and the part it cannot catch is stated in `description`. A `bytea` travels as
  base64, so its cap is the encoded length, `4 * ceil(n / 3)`, which is the padded length of a full
  value and an upper bound on the unpadded one, measured over n = 0 to 20. That also gives a MySQL
  `tinyblob` a bound it never had: 255 bytes is `maxLength: 340`, where the document previously said
  nothing. A byte _floor_ reaches no keyword in either case.

  **What is still refused, and now says so.** A count on a MySQL `binary(n)`/`varbinary(n)` cannot be
  answered: the value arrives as a string from a lossy decode, so neither its characters nor their
  re-encoding is the server's byte count. `drzl doctor` reports that as a new finding kind,
  `check-uncountable`, rather than dropping it silently, and the ledger marks it unenforced with the
  reason. The doctor's note that count clauses were "unreachable from a working schema" was true of
  Postgres and is not true of MySQL, which has `OCTET_LENGTH` and a column whose bytes JavaScript
  cannot see.

### Patch Changes

- 9939e4c: Spell a CHECK's number literals in the column's wire type, so a set on a `bigint({ mode:
'bigint' })` column stops rejecting every row the driver returns

  `CHECK (big IN (1, 2))` on a bigint-mode column emitted `z.union([z.literal(1), z.literal(2)])`,
  and the driver returns `1n` there: strict equality between a bigint and a number is false in
  JavaScript, so the select schema refused every row the database handed back, and the insert schema
  refused every value the driver wants. The OR fold routes `big = 1 OR big = 2` into the same set,
  and the single `big = 1` and `big <> 1` predicates compared with `===`/`!==` had the same wire
  mismatch: the equality never held and the inequality always did, so one rejected everything and
  the other enforced nothing. `bigint({ mode: 'number' })` was always correct, because the driver
  really returns a number there; the fix keys on the analyzer's per-mode `tsType`, which is the
  value's measured wire type, rather than on the SQL type name.

  The spelling per library was measured against the installed versions rather than assumed:

  - **zod, valibot**: `z.literal(1n)` and `v.literal(1n)` accept `1n`, reject `3n` and reject the
    number `1`, so the set stays the same union with the members suffixed. The `=`/`<>` refinements
    compare against `1n`.
  - **ArkType**: the string DSL parses bigint literals. `type('1n | 2n')` enforces the set,
    `type('9223372036854775807n')` holds the 64 bit value exactly, and `type('(1n | 2n)[]')` keeps
    the array wrap. The single equality already went through `atBigintNarrow` and was correct.
  - **TypeBox**: `Type.Literal(1n)` constructs and passes `Value.Check`, and
    `TypeCompiler.Compile` then throws "Preflight validation check failed to guard for the given
    schema", so the literal form would take every compiler-path consumer down. The set and the
    pinned equality go to the registered `DrzlRowCheck` kind intersected with `Type.BigInt()`, the
    same escape hatch the character caps use, which both checkers honour; the static type still
    narrows through `Type.Unsafe<1n | 2n>`, and the document still serialises.
  - **effect**: `Schema.Literal(1n, 2n)` enforces the set; the `<>` filter compares against `1n`.
  - **JSON Schema**: a bigint column is already a digits string in a JSON document, because
    `JSON.stringify` throws on a bigint, so the set becomes `{ enum: ['1', '2'] }` and a pinned
    equality `{ const: '1' }`, in the wire the serialised row can actually hold. This also unrounds
    the 64 bit case: `Number('9223372036854775807')` becomes 9223372036854775808 the moment it is a
    number, and the digit string stays exact.

  A non-integer member has no bigint spelling at all: `1.5n` is a syntax error, and an emitted
  module carrying it would throw at import. Such a member keeps its number spelling, which no stored
  bigint ever equals, exactly as the database says: no bigint column value is 1.5, so `big IN (1.5,
2)` narrows to the 2. The shared decision lives in `wireNumberLiteral` in
  `@drzl/validation-core`, so the six emitters cannot answer it differently.

  The driver-side ground truth is the analyzer's own: `decimal-modes.spec.ts` pins `db.select()`
  returning a real bigint in bigint mode on all three engines, and the `PgBigInt53`/`PgBigInt64`
  arms pin the number mode returning a number, which is why those literals do not change.

- cc26f38: Reconcile a CHECK's literal kind with the column's wire by the database's comparison semantics,
  so a set on a `numeric()` column stops rejecting every row the driver returns

  `CHECK (n IN (1, 2))` on a `numeric()` column (string mode, the default) emitted
  `z.union([z.literal(1), z.literal(2)])`, and the driver returns _decimal text_ there, spelled by
  the declared scale: measured through PGlite on both drizzle majors, a stored 1 comes back `'1'`
  from a bare `numeric`, `'1.00'` from a `numeric(10,2)` and `'1.0000000000'` from a
  `numeric(20,10)`, and mysql2 returns the same shapes for `decimal`. So the select schema refused
  every row the database handed back. Exact string literals are no repair: `'1'` fails against the
  `'1.00'` the scaled column returns, and a bare `numeric` even preserves the insert's own zeros
  (`1.000000` came back `'1.000000'` and `CHECK (n IN (1, 2))` admitted it, because SQL numeric
  equality is scale insensitive: `1 = 1.00` is true, measured on PostgreSQL 17.5 and MySQL 8.4.11).

  The same rule gap ran the other way. The database coerces a quoted literal to the column's type
  before comparing (`bigint CHECK (big IN ('1','2'))` admitted 1 and refused 3;
  `integer CHECK (age IN ('18'))` admitted 18), while the emitted schemas compared the raw text:
  `z.enum(["1","2"])` refused every `1n` a bigint-mode column returns, `big = '1'` compared
  `v === "1"` which no bigint ever satisfies, and `age IN ('18')` refused the number 18.

  The repair is one shared policy in `@drzl/validation-core`, extending `wireNumberLiteral`'s rule
  to the whole comparison: the literal's kind and the column's wire are reconciled by what the
  database does, never by the source spelling.

  - **Numeric string wires** (`numeric`/`decimal` string modes, v1 `bigint({ mode: 'string' })`):
    equality, inequality and sets compare _canonical decimal spellings_ through a `DrzlNumericCanon`
    helper emitted once per file, dependency free: sign normalised, leading integer zeros and
    trailing fraction zeros stripped, a bare trailing dot dropped, then compared as strings. Exact
    at any precision on purpose: `Number()` is not usable here, because a numeric column carries
    more digits than a double holds and `Number('99999999999999999999')` equals
    `Number('99999999999999999998')`. zod and valibot refine, ArkType narrows, TypeBox rides the
    registered `DrzlRowCheck` kind under both checkers, effect filters. JSON Schema cannot run a
    function, so the set becomes a `pattern`: one alternation branch per member, accepting exactly
    the spellings that canonicalise to it, ajv strict valid on every target; the cost is the
    regex's readability, not admitted rows. Ranges there keep their coerced numeric compare,
    now spelled `Number(v) >= 1` so the comparison is visible and the module typechecks.
  - **Number and bigint wires**: quoted plain-decimal literals are respelled to their number-kind
    selves (canonicalised first: `018` and `018n` are syntax errors in an emitted module) and every
    existing arm applies, `wireNumberLiteral`'s bigint suffix included. `big IN ('1','2')` now
    emits byte for byte what `big IN (1, 2)` emits.
  - **What no exact compare can state is left unenforced and reported, never guessed.** Three
    measured shapes: a number literal against a text column (Postgres refuses the DDL outright;
    MySQL creates it and admits `'1.00'`, `'1'` and `'2.0'` through double coercion), quoted text
    that is not plain decimal on a number or bigint wire, and a member outside the canonical domain
    on a numeric wire (`CHECK (n IN ('1e3', '2'))` is valid DDL whose rows come back `'1000'`).
    Each falls back to the base schema, which accepts every value the driver returns for admitted
    rows, and the constraint ledger carries the reason: enforcing a guess would reject rows the
    database admits, which is the defect class this fixes.

  The ledger and `meta` apply the same policy through `classifyTableChecks`, so a respelled
  constraint renders the message the emitted module writes and an unenforced clause says why
  instead of being claimed. TypeBox also stops planting a dead `minimum` keyword on
  `Type.String()`, which validated nothing and serialised as if enforced.

- Updated dependencies [0e295da]
  - @drzl/analyzer@1.20.1

## 3.20.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [a0e49e3]
  - @drzl/analyzer@1.20.0

## 3.19.0

### Minor Changes

- 4efd19b: Emitted validators can now give every key a nominal type, so a `users.id` cannot be passed where a
  `posts.id` is wanted.

  `{ kind: 'zod', path: 'src/validators/zod', branded: true }`, on all five validation generators.

  ```ts
  export const SelectpostsSchema = z.object({
    id: z.number().int().brand<'posts.id'>(),
    authorId: z.number().int().brand<'users.id'>(),
  });

  export type PostsId = z.output<typeof SelectpostsSchema>['id'];
  ```

  ```ts
  loadUser(post.authorId); // fine
  loadUser(post.id); // Type 'number & $brand<"posts.id">' is not assignable to
  //                    parameter of type 'number & $brand<"users.id">'
  ```

  **Nothing happens at runtime.** Measured on zod 4.4.3, `.brand()` returns the same schema object it
  was called on, by identity, and `parse(1)` is `1`; valibot 1.4.2, arktype 2.2.3 and effect 3.x all
  hand the value back unchanged, and TypeBox's marker is a cast that leaves the schema object
  byte-identical. So this cannot change what a schema accepts, and the whole feature is what `tsc`
  prints. It is proved that way: the test suite compiles generated modules and asserts that
  `@ts-expect-error` on each rejection is used, that the same file without the directives produces
  exactly those errors, and that the identical calls against unbranded output produce none.

  **Foreign keys carry the brand of the column they reference**, resolved transitively, and that beats
  the column being part of its own table's key. `posts.authorId` is a `users.id`; a join table keyed
  on `(orgId, userId)` is `orgs.id` and `users.id`, not two brands nothing else produces. Without this
  the feature would only stop you swapping two tables' own ids, while every id actually flowing
  between your tables stayed a plain number.

  **The brand token is `<export name>.<column>`, verbatim.** Nothing is transformed, so the token is
  unique by construction and two tables cannot collide after a transformation. The exported alias has
  to be an identifier and is `PascalCase(table) + PascalCase(column)`; `user_accounts` and
  `userAccounts` do collide there, and when they do neither alias is emitted and the run says so. The
  schemas are unaffected, because they carry the token and never the alias.

  **The brand goes inside the `nullable` and `optional` wrappers**, and that is the one decision that
  could be wrong while still compiling. A brand is an intersection and `null & { ... }` is `never`, so
  `z.number().nullable().brand<'users.id'>()` infers `number & $brand<"users.id">` with the null arm
  silently gone while `.parse(null)` still returns null. The same trap is in valibot, effect and
  TypeBox. All five emit `(number & brand) | null`.

  **`typedColumns` is not emitted for a branded column.** Both narrow the same column's static type and
  whichever runs second wins, and applying the brand to the reference hits the null problem above. The
  brand wins outright rather than the two being emitted to fight; nothing is lost for an ordinary key,
  whose branded type is Drizzle's inferred type plus a marker. A key declared with `.$type<T>()` is the
  one case that costs something, and it is documented.

  **TypeBox has no brand at all** and still expresses one. There is no `Type.Brand` and nothing
  brand-shaped on `Type`, measured on 0.34.52 by enumerating its keys. What it has is `TUnsafe<T>`, its
  own primitive for "this schema, that static type", which the generator already uses for
  `typedColumns`. A branded file declares one helper whose value is the schema itself, so `Value.Check`,
  `TypeCompiler` and the JSON Schema `JSON.stringify` produces are all unchanged. The marker is a
  string-keyed property rather than a `unique symbol` on purpose: a `unique symbol` is unique per
  declaration, so two generated files would produce two unrelated brands and a foreign key would not be
  assignable to the key it points at.

  **Which types change differs by library, and branding only makes it visible.** zod, valibot and effect
  name their insert type from the schema's _input_ type, which a brand does not touch, so writes stay
  plain and only rows read back carry brands. ArkType and TypeBox name theirs from the output type, so
  an insert payload there wants a branded id.

  Off by default: it changes the inferred type of every consumer of the select schemas, which is the
  point, but it is a change to existing call sites rather than an addition. A full generated project,
  validators for all five libraries plus a service and both routers, typechecks with it on under
  `nodenext` with `noUnusedLocals`: the generated service types its key as `id: number` from Drizzle,
  and a branded id is still a number, so every call into it still compiles. Emitted source grows about
  10%, all of it text, none of it reaching runtime.

- 7a46b64: Emitted zod schemas can now carry the facts they cannot state about themselves.

  `{ kind: 'zod', path: 'src/validators/zod', meta: true }` attaches zod's own `.meta()` to every
  field and every table schema: the declared SQL type, the primary key, the unique constraints, the
  dialect, whether the database generates or defaults the value, the declared width, and the CHECK
  constraints, including the ones DRZL does not enforce.

  ```ts
  bio: z.string().nullable().meta({ sqlType: 'text' }),
  ```

  ```ts
  SelectusersSchema.shape.bio.meta(); // { sqlType: 'text' }
  SelectusersSchema.meta().primaryKey; // ['id']
  ```

  `z.toJSONSchema` copies the keys through, so the same option is what gets a declared width into an
  OpenAPI document: DRZL enforces `varchar(254)` as a `.refine()`, and `toJSONSchema` drops every
  refinement **in silence**, so without this the document says the column is an unbounded string and
  nothing in it says otherwise. `maxLength` is the JSON Schema keyword, so a validator acts on it.

  Off by default. On a ten-column table it costs about 48 bytes per field and 156 per schema, and
  roughly doubles the emitted module; generated code ships in your bundle.

  **Where it attaches is the whole design problem, and it is measured rather than reasoned about.**
  `.meta()` returns a clone carrying the entry, so an operation that clones keeps it and one that
  wraps does not. On zod 4.4.3, `.refine()`, `.min()`, `.describe()` and `.brand()` all preserve it,
  while `.nullable()`, `.optional()`, `.default()`, `z.array()` and `.pipe()` each build a new schema
  whose own `.meta()` answers `undefined`, reachable only at `.def.innerType`. DRZL wraps every
  nullable column, every array, every optional-on-insert column and every field of an update schema,
  so attaching to the base type would lose the metadata for most of the output. It is therefore
  attached last, after every wrapper, which is also the position `z.toJSONSchema` reads as the
  property's own keywords rather than as one arm of its `anyOf`.

  Every key had to say something the schema does not already say. `nullable` is deliberately absent
  for that reason: `.nullable()` is in the chain and `anyOf: [..., { "type": "null" }]` is in the
  JSON Schema, so it would be a second copy of an answer the consumer already has. `hasDefault` is
  present because a defaulted column and a nullable one are both `.optional()` on insert and the
  wrapper cannot tell them apart. `unenforcedChecks` is present because nothing else in the emitted
  module mentions a CHECK that DRZL declined; `drzl doctor` was the only place it appeared.

  `{ meta: { description: true } }` additionally writes a `description`, which `toJSONSchema` maps to
  the JSON Schema keyword of that name and which is the only key here any OpenAPI viewer renders
  without being taught. It is separate because it is prose repeating the machine-readable keys beside
  it, and prose is the most expensive thing in the output.

  **There are no column comments to carry, and this was measured before the feature was scoped.**
  `drizzle-orm` exposes none at all on either major: no comment-ish own key or prototype method on a
  built column, and `pg.text('a', { comment: 'hello' })` is refused by TypeScript as an excess
  property and, when passed through a variable, dropped at runtime with the string unreachable from
  the built column by any path. Every key above is therefore a fact the analyzer derived, never text
  the user wrote. The zod generator's documentation states this outright, because expecting it to
  work is reasonable.

  zod only, deliberately. The other four validation generators are not passed the option rather than
  being passed it and ignoring it: each has a metadata facility of its own, and where the metadata
  has to attach is exactly what had to be measured here. TypeBox is the obvious next one, because a
  TypeBox schema is a JSON Schema and there is no placement question at all. The `json-schema`
  generator does not read this either: it builds from the same analysis rather than from a zod schema,
  so there is nothing to read.

  `@drzl/analyzer` gains `Column.sqlType`, the column's type as the database declares it, from
  Drizzle's own `getSQLType()`: `varchar(255)`, `numeric(10, 2)`, `timestamp with time zone`,
  `text[]`, or an enum's type name. `dbType` could not answer this and was never meant to; it is a
  label with exactly one consumer, `isIntegerColumn`, and it calls `varchar`, `char` and `text` all
  `TEXT`. The two Drizzle majors disagree about an array and are reconciled: 0.4x wraps the column in
  a `PgArray` whose own answer is already `text[]`, while v1 leaves the class alone and raises
  `dimensions`, so the suffix is added from `arrayDimensions` when the type does not carry one. The
  field is absent, never guessed, where a builder cannot answer.

### Patch Changes

- Updated dependencies [7a46b64]
  - @drzl/analyzer@1.19.0

## 3.18.0

### Minor Changes

- 3b53229: Add `@drzl/generator-effect`: Effect Schema validators from a Drizzle schema.

  `{ kind: 'effect', path: 'src/validators/effect' }` emits an insert, update and select schema per
  table, built on `effect/Schema` from `effect` core 3.x. Everything the other validation generators
  handle is handled here: every column type the analyzer produces, nullable against optional, CHECK
  constraints through `parseCheck` including the array and JSON guards, declared numeric precision
  and bounds, `maxLength`/`maxBytes`, `applyDefaults`, `typedJson`, `typedColumns`, `duplicateFinder`,
  `coerceDates`, affixes and nested relation schemas.

  Three things differ from the existing four, each measured rather than assumed:

  - **Both a bare and a Standard Schema form are emitted.** A bare `Schema.Struct` carries no
    `~standard` key, so `Standard<Name>` is exported beside every schema as
    `Schema.standardSchemaV1(<Name>)`. The bare form is the one that composes, since the wrapper drops
    `.fields`. This is the difference from TypeBox, which has no route to Standard Schema at all.
  - **`Schema.Number` accepts `NaN` and both infinities**, which is the opposite of `z.number()` and
    `Type.Number()`. Numeric columns therefore build on `Schema.Finite`, unconditionally rather than
    relying on the range, since `Infinity >= 0` is true.
  - **`effect` is an optional peer**, unlike the required validator peers of the other four.
    `drizzle-orm@1.0.0-rc.4` declares its own optional peer on `effect` as
    `>=4.0.0-beta.83 || >=4.0.0`, and npm auto-installs a required peer, so declaring one made
    `npm install @drzl/cli drizzle-orm@1.0.0-rc.4` fail with `ERESOLVE` for every consumer. Install
    `effect` yourself; the floor is 3.13.0, where `Schema.standardSchemaV1` first appears.

  Character limits are counted in code points rather than UTF-16 units, so a `varchar(10)` accepts ten
  astral-plane characters exactly as the database does.

  `ValidationLibrary` in `@drzl/validation-core` gains `'effect'`, and the CLI wires the new kind into
  both the `generate` and `watch` dispatch loops and into `computeGeneratorOutputDirs`.

## 3.17.0

### Minor Changes

- 22f4cb7: Relations-aware nested schemas: `nestedSchemas: true` emits `NestedInsert<Table>` and
  `NestedSelect<Table>` beside the flat ones, the table plus one key per relation, so
  `{ ...user, posts: [...] }` can be validated whole. All four validation generators, off by default,
  and with it off the output is byte-for-byte unchanged.

  **Nothing in the Drizzle ecosystem describes that payload**, which was measured rather than
  assumed. Against `drizzle-orm/{zod,valibot,arktype,typebox-legacy}` at 1.0.0-rc.4 and against the
  0.4x `drizzle-zod`/`drizzle-valibot`/`drizzle-typebox`/`drizzle-arktype` packages,
  `createInsertSchema(users)` returns `['id', 'name']` and never a `posts` key, in every mode and
  every library. Passing the `relations()` object as the second argument lands it in the refine slot,
  where its keys are not column names and it is dropped; passing it first throws inside `getColumns`.
  Grepping both majors for `Relational|withRelations|createRelationSchema|createNestedSchema` finds
  nothing. And the payload is not merely unvalidated:
  `db.insert(users).values({ name: 'a', posts: [{ title: 't' }] })` emits
  `insert into "users" ("id", "name") values (default, $1)` on both majors, so the children are
  silently never written.

  **The child's foreign key is omitted from a nested insert.** `posts.authorId` does not exist until
  the user is inserted, so requiring it makes the schema unusable and permitting it admits a payload
  no correct nested write can honour. It is dropped only where the relation says which column it is,
  meaning the child has exactly one foreign key back to the parent; two or more is ambiguous and
  nothing is dropped, with a comment above the arm saying why. The plain insert schema is untouched,
  and a nested select drops nothing, since the row really comes back carrying its key.

  **`one` is not emitted on insert.** Its foreign key is on the outer object, so admitting the arm
  would mean making that column optional, and an optional NOT NULL foreign key also admits a row with
  neither a key nor a nested parent, which the database refuses. **There is no nested update schema
  at all**: the payload has no single meaning without an operation vocabulary Drizzle does not have,
  and an update schema drops the primary key, so a child in one carries nothing that identifies which
  row it patches.

  **Cycles terminate by depth rather than by recursion.** `nestedDepth` defaults to 1 and is capped
  at 3, and nesting is expanded inline, so `users -> posts -> users` and a self-referencing
  `managerId` both simply stop. All four libraries can express a cyclic schema and each does it
  differently, measured by running them: zod through a property getter, valibot through `v.lazy`,
  ArkType only inside a `scope` (a plain forward reference throws `Cannot access 'Post' before
initialization` at module load), TypeBox only inside a `Type.Module` (a bare `Type.Ref` constructs
  happily and then throws `Unable to dereference schema with $id` the first time anything checks a
  value). Two of the four therefore fail as a broken module rather than as a wrong schema, and inline
  expansion needs none of the four mechanisms and no explicit type annotation.

  Nested shapes are rendered from the columns rather than derived from the sibling schema, because
  deriving does not work in three of the four and fails loudly in only one of those three. Measured:
  zod's `.omit()` **throws** `.omit() cannot be used on object schemas containing refinements`, so
  every table with a row-level CHECK would emit a module that threw on import; valibot's `v.omit`
  over a `v.pipe` silently drops the checks; and TypeBox's `Type.Omit` over the `Type.Intersect` a
  row check emits rewrites the check branch into an empty object and keeps every property required.

  ***

  Two CLI wiring defects of the class the shared options builder was created to remove, both found by
  generating output and reading it rather than by reading the wiring:

  - **`watch` never moved onto the shared builder.** Its zod, valibot and arktype branches still
    assembled six keys by hand, so `coerceDates`, `applyDefaults`, `typedJson`, `typedColumns` and
    `duplicateFinder` were all dropped on a rebuild: the first save after starting `drzl watch`
    silently replaced correct output with output generated from defaults. All three now call
    `validationOptions`, the same function `generate` uses.
  - **`watch` had no typebox or json-schema branch at all.** Those two generators were configured,
    ran under `drzl generate`, and were then skipped by every watch rebuild, so their directories went
    stale from the first save onward with nothing said.

  `packages/cli/test/nested-branch-parity.e2e.spec.ts` runs both commands over a config that sets the
  option for every generator and compares what landed on disk, because reading the two loops is what
  missed both.

## 3.16.4

### Patch Changes

- e0ef06c: `date({ mode: 'date' })` and `timestamp({ mode: 'date' })` stop accepting a string that is not a
  date, in the valibot, ArkType and TypeBox generators.

  `coerceDates` lets a client send a date as a string, and a previous fix narrowed _which_ strings may
  be coerced: one that is entirely a number, or that starts with a sign, is refused, because V8 and
  Postgres disagree about what such a string means. That was a gate on the shape of the input, and
  these three generators asked nothing at all about the result. So every string that was not a bare
  number went through: `'hello'`, `'zzz'`, `'25:99:99'`, `'not-a-uuid'`, `'10.0.0.1'`, a uuid, a
  300-character run of `x` and a string of emoji all validated, all became an Invalid Date, and
  Postgres refuses every one of them. Validation passed and the INSERT then failed at the server,
  which is the one outcome an Insert schema exists to prevent.

  The zod generator was already correct and is what the other three now match. `z.preprocess(coerce,
z.date())` validates what came _out_ of the coercion, and an Invalid Date is a real `Date` instance
  that `z.date()` still turns away, so no bare instance check would have done: the timestamp is the
  only thing that differs and it is `NaN`.

  Each library states it in the form it has. valibot adds a `v.check` after the transform, which sees
  the transform's output rather than its input. ArkType adds a `.narrow`, because the constraint is a
  predicate over the result of a call and its string DSL cannot state one. TypeBox has no declarative
  form for it either, so it intersects the registered kind it already uses for character caps onto the
  string branch; the `pattern` beside it still serialises into a JSON Schema, the intersected branch
  does not.

  **What changes for you.** On a `mode: 'date'` column, a string that `new Date` cannot parse is no
  longer accepted on the write path. Everything that reads as a date is untouched: `'2020-01-01'`,
  `'2020-01-01T00:00:00Z'`, `'1999-01-08 04:05:06'`, `'01/02/2020'`, `'January 8, 1999'`, `'2020-1-5'`
  and `'  2020-01-01  '` all still pass, as does a real `Date`. `coerceDates` itself is unchanged and
  its `all` / `none` / `input` behaviour is the same, so `'none'` still emits a plain date type and
  `'all'` still narrows the select schema the same way as the write schemas.

  `'12:00:00'` is worth naming, because the two parsers could have disagreed about it and do not.
  `new Date('12:00:00')` is an Invalid Date, and Postgres refuses `'12:00:00'` for `date`, `timestamp`
  and `timestamptz` with `invalid input syntax`. The types that do take it are `time`, `timetz` and
  `interval`, none of which is ever a `mode: 'date'` column. So it is refused, and both sides agree it
  should be.

  The zod and JSON Schema generators do not change.

## 3.16.3

### Patch Changes

- 74afee6: `date({ mode: 'date' })` and `timestamp({ mode: 'date' })` stop accepting a string that is only a
  number.

  `coerceDates` lets a client send a date as a string, and every generator took any string at all in
  that position. `new Date` reads a bare number as a year, or as `month.day`, so `'12.5'`, `'0101'`
  and `'010'` were all real dates and Postgres refuses all three: validation passed and the INSERT
  then failed at the server, which is the one outcome an Insert schema exists to prevent.

  A coerced string now has to look like a date notation. The obvious justification for the rule, that
  Postgres refuses a bare number, turned out to be false and the real one is stronger. Postgres reads
  a six or eight digit run as a compact `YYMMDD` / `YYYYMMDD` date and takes it happily, but where
  both parsers accept such a string they never agree on which date it is. Measured against a real
  Postgres over every all-digit string in the probe set that both accept, ten of them, the two answers
  differed every single time:

  ```
  '250101'    Postgres 2025-01-01    V8 the year 250101
  '241231'    Postgres 2024-12-31    V8 the year 241231
  '121212'    Postgres 2012-12-12    V8 the year 121212
  '000101'    Postgres 2000-01-01    V8 0100-12-31
  '20200101'  Postgres 2020-01-01    V8 refuses it outright
  ```

  So coercing a bare number either sends the server a value it rejects or silently writes a different
  date than the database would have stored. A leading `+` or `-` goes the same way: `'+2020-01-01'`
  and `'-2020-01-01'` are valid dates in V8 and Postgres refuses both.

  **What changes for you.** On a `mode: 'date'` column, a string that is entirely a number, or that
  starts with a sign, is no longer coerced and no longer validates. Everything that reads as a date to
  both parsers is untouched: `'2020-01-01'`, `'2020-01-01T00:00:00Z'`, `'1999-01-08 04:05:06'`,
  `'01/02/2020'`, `'January 8, 1999'`, `'2020-1-5'` and `'  2020-01-01  '` all still pass, as does a
  real `Date`. `coerceDates` itself is unchanged and its `all` / `none` / `input` behaviour is the
  same; this narrows what a coerced string may be, it does not remove coercion. Numbers are untouched
  too, so an epoch millisecond still coerces.

  The JSON Schema generator does not change. Dates arrive as strings once serialised, whatever
  `coerceDates` does in TypeScript, and it already describes them as such.

## 3.16.2

### Patch Changes

- 82c14d0: Postgres float columns accept `NaN` and the infinities they actually store.

  `real` and `double precision` hold `NaN`, `Infinity` and `-Infinity`, and Postgres hands all three
  back on SELECT. Every emitted schema refused them, so reading a row holding one failed validation on
  a column behaving exactly as documented. That is the read path, which no application can avoid.

  No range could have fixed it. A `>=`/`<=` pair refuses `Infinity` whatever the numbers are and `NaN`
  compares false against both ends, so the fact is now carried on the column as `allowsNaN` and
  `allowsInfinity` and each generator renders it as a union beside the range. The range is unchanged
  and still describes the column's finite values, so a `real` still refuses `1e300`.

  Measured against PostgreSQL 18.3, on the bound-parameter path a validator guards:

  ```
  real, double precision   NaN, Infinity and -Infinity all stored and returned unchanged
  numeric (no typmod)      the same three, faithfully
  numeric(10,2)            NaN faithful; either infinity refused, 22003 numeric field overflow
  integer, bigint          all three refused
  ```

  **What changes for you.** On Postgres, a `real` or `double precision` column's schema now accepts
  `NaN`, `Infinity` and `-Infinity`. A `numeric({ mode: 'number' })` column accepts `NaN` and keeps
  refusing both infinities: nothing in the analysis reads a column's precision or scale, so an
  unconstrained `numeric` and a `numeric(10,2)` are indistinguishable, and admitting the infinities
  would promise what the server refuses for the commoner of the two. Integer columns are untouched,
  because Postgres refuses all three there. MySQL and SQLite are untouched; SQLite returns both
  infinities and silently turns `NaN` into NULL, which is a separate answer that has to arrive whole.

  The JSON Schema generator does not change. JSON has no `NaN` and no `Infinity`, so there is nothing
  for it to admit.

- Updated dependencies [82c14d0]
  - @drzl/analyzer@1.17.4

## 3.16.1

### Patch Changes

- 55d1c31: `format.engine: 'biome'` formats. It never has before.

  `@biomejs/biome` publishes a `bin` and no module entry point at all, so the engine's
  `import('@biomejs/biome')` rejected with `ERR_MODULE_NOT_FOUND` whether or not the package was
  installed. Every project that configured biome got unformatted output, and after the previous
  release, a warning telling them to run the CLI by hand.

  It now spawns the binary the package actually publishes, found by resolving the package's own
  manifest from the directory being generated into. Both `bin` shapes are handled: a string at 1.5.3
  and below, an object from 1.9.4 on.

  **What changes for you.** If you configured `engine: 'biome'` and installed `@biomejs/biome`, your
  output is now formatted with it. If you configured it and did not install it, the warning now tells
  you to install the package, which is advice that works, rather than pointing you at the CLI.
  `engine: 'auto'` and `engine: 'prettier'` are unaffected.

## 3.16.0

### Minor Changes

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

- b14cbed: A formatter named in `format.engine` that cannot be loaded is now reported, instead of producing
  unformatted files and no message.

  `format: { engine: 'prettier' }` with no prettier installed wrote every generated file exactly as
  rendered and said nothing. The request was explicit, it did not happen, and there was no way to
  tell from the run: unformatted output is still valid TypeScript, so nothing downstream fails
  either. The same held for `format: { engine: 'biome' }`.

  **What changes for you.** When `format.engine` names an engine and that engine cannot be loaded,
  one line goes to stderr per run naming the setting, the package, what to do about it, and the
  underlying error:

  ```
  [drzl] format.engine is "prettier" but prettier could not be used, so the generated files were
  left unformatted. Install prettier, which is an optional peer of @drzl/validation-core, or set
  format.engine to "auto" to accept whatever formatter is present. Reason: Cannot find package
  'prettier' imported from ...
  ```

  It is a warning rather than an error. Generation still completes and the files are still written,
  because the difference is whitespace and failing the run would trade a finished generation for it.
  Once per run rather than once per file, since whether a formatter loads is a fact about the
  environment and a forty-table schema would otherwise repeat it forty times.

  **What does not change.** `format.engine: 'auto'`, the default, still falls back in silence: it
  asked for whatever is installed, so finding nothing is an answer rather than a failure. Prettier is
  still an optional peer that is never bundled, and `format: { enabled: false }` is still silent
  because nothing was requested.

- Updated dependencies [8cc4de8]
- Updated dependencies [f019b03]
  - @drzl/analyzer@1.18.0

## 3.15.1

### Patch Changes

- db2b1d7: A `GENERATED ALWAYS` column no longer appears in an update schema or an update type.

  Every server refuses an UPDATE that names one, with any value at all including NULL. Asked of a real
  Postgres:

  ```
  update children set span = 7        refused, 428C9 column "span" can only be updated to DEFAULT
  update children set span = null     refused, 428C9
  update children set span = default   accepted, and it is the only accepted form
  ```

  `SET col = DEFAULT` is not something a patch object can express and not something Drizzle's `.set()`
  produces, so a payload that validated against the old schema and was then handed to
  `db.update().set()` produced a query the database rejected. `drizzle-orm/zod`'s own
  `createUpdateSchema` omits the column.

  **What changes for you.** A key that the update schema previously accepted is now rejected, and the
  emitted `Update<T>` type no longer carries it. If you were passing a generated column in a patch,
  the database was already refusing that write.

  **What does not change.** `GENERATED BY DEFAULT AS IDENTITY` stays in the update schema, because the
  same servers accept an UPDATE of one and the analyzer reports it as `isGenerated: false`. Defaulted
  columns are unaffected.

  Two places carried the same wrong filter: `updateColumns` in `@drzl/validation-core`, which the five
  validation generators share, and a private copy in `@drzl/generator-service`, which builds its own
  field list and never called it.

## 3.15.0

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

## 3.14.0

### Minor Changes

- fbc0881: Emit a batch duplicate finder, and stop reading a table-level `unique()` as the primary key

  `{ duplicateFinder: true }` on any of the four validation generators also emits
  `findDuplicate<Table>`: the rows in a batch that collide with an earlier row on a unique
  constraint.

  Uniqueness is the one constraint a per-row validator structurally cannot check, since it is a fact
  about the table rather than the row. What needs no database is whether a batch collides with
  itself, and that is the half a user can fix before sending anything. It matters for bulk inserts,
  where a thousand rows fail whole on one collision and the error names a constraint rather than a
  row.

  The finder follows SQL on null: a constraint is skipped for any row where one of its columns is
  null or absent, because NULL is not equal to NULL and a unique index permits repeats. Composite
  keys compare by JSON, so `[1, '2']` never collides with `['1', 2]`. The emitted function is plain
  TypeScript with no reference to any validation library, so all four generators emit the same one.

  Building it surfaced an analyzer bug it depended on. A table-level `unique('name').on(a, b)` keeps
  its columns directly on the builder and carries no `unique` flag, which is also true of a primary
  key builder, and the rule was "no flag means primary key". So the constraint was not merely
  lost: a table keyed on `id` reported a composite primary key on whatever the unique named, which
  is what the service and router generators build their lookups from. Builders are now told apart by
  `drizzle:entityKind`.

### Patch Changes

- Updated dependencies [fbc0881]
- Updated dependencies [5578e93]
  - @drzl/analyzer@1.14.0

## 3.13.0

### Minor Changes

- c5fcb15: `CHECK (cardinality(col) <op> n)` is now enforced on array columns.

  ```ts
  // check('tags_rule', sql`cardinality(${t.tags}) > 0 AND cardinality(${t.tags}) < 4`)
  tags: z.array(z.string())
    .refine((v) => v.length > 0, { message: 'tags_rule: cardinality(tags) > 0' })
    .refine((v) => v.length < 4, { message: 'tags_rule: cardinality(tags) < 4' }),
  ```

  The array analogue of the `length()` support, and free of the question that one carries: an
  element count is the same number in SQL and in JavaScript, with no encoding involved.
  `array_length(col, 1)` reads the same way, because for a one-dimensional array it is that count.
  `array_length(col, 2)` is refused, since a higher dimension is not an element count.

  This is the one check an array column takes. Every other kind is skipped there, because a
  comparison against a scalar literal says nothing usable about an array; this one is about the
  array itself, so it is applied after the array wrapping rather than to an element.

  Verified against Postgres for `CHECK (cardinality(tags) > 0 AND cardinality(tags) < 4)`: the
  emitted schema and the database agree on all four probes.

## 3.12.0

### Minor Changes

- f98d84a: `CHECK (length(col) <op> n)` is now enforced, counted in characters.

  The one function call the check parser reads, because the mapping is exact:

  ```ts
  // check('name_len', sql`length(${t.name}) >= 3 AND length(${t.name}) <= 8`)
  name: z.string()
    .refine((v) => [...v].length >= 3, { message: 'name_len: length(name) >= 3' })
    .refine((v) => [...v].length <= 8, { message: 'name_len: length(name) <= 8' }),
  ```

  `char_length` is the same function in Postgres and is read too. Counted in code points, for the
  same reason a `varchar(n)` limit is: Postgres counts characters and `.length` counts UTF-16 units.
  Verified against Postgres for `CHECK (length(name) >= 3 AND length(name) <= 8)`, which agrees on
  all eight probes including three, eight and nine emoji.

  `octet_length` is deliberately **not** read: it counts bytes, which depends on the encoding and
  cannot be derived from a JavaScript string without choosing one. Nor is `lower`, which would need
  a locale to be faithful. The rule is unchanged, only its reach: read what maps exactly, refuse the
  rest rather than guess.

  TypeBox and ArkType do not carry these, for the same reason they carry an approximate `varchar(n)`:
  both state constraints declaratively with no predicate to hook. Each generator's docs say so.

  The parity probe pool gained astral characters as well, so a cross-generator disagreement about
  character counting is visible rather than invisible.

## 3.11.0

### Minor Changes

- 387b45b: A `varchar(n)` limit counts characters, not UTF-16 code units.

  Postgres and MySQL count `varchar(n)` in **characters**. Every JavaScript validator counts
  `.length`, which is UTF-16 code units. The two agree until the text leaves the basic plane, and
  then they do not.

  Measured against Postgres through PGlite for a `varchar(10)` column:

  | value               | database    | `.max(10)`  |
  | ------------------- | ----------- | ----------- |
  | 10 plain characters | accepts     | accepts     |
  | 8 emoji             | **accepts** | **refuses** |
  | 10 emoji            | **accepts** | **refuses** |
  | 11 emoji            | refuses     | refuses     |

  So the generated schema was turning away a bio, display name or message the column would have
  stored quite happily. `drizzle-orm/zod` emits `.max(n)` and does the same.

  The zod and valibot generators now count code points, which is what the database counts:

  ```ts
  name: z.string().refine((v) => [...v].length <= 10, { message: 'at most 10 characters' }),
  ```

  TypeBox and ArkType keep the UTF-16 form, and it is not an oversight: both state a length
  declaratively with no predicate to hook, so their output stays approximate for astral text. That
  is documented on each.

  The probe pool behind the ground-truth stage gained astral characters, since it had none and that
  is why the gate never saw this. It remains a class the gate cannot fail on by itself, because DRZL
  and `drizzle-orm` were wrong in exactly the same way and the gate only fires when DRZL is uniquely
  wrong. Finding it needed the pool to contain a value that tells the two counts apart.

## 3.10.0

### Minor Changes

- 98c7cd9: `applyDefaults`: reproduce literal column defaults in the insert schema.

  Drizzle knows what a column defaults to. `drizzle-orm/zod` reproduces none of them, so a parsed
  insert is missing the values the database would have written.

  ```ts
  { kind: 'zod', path: 'src/validators/zod', applyDefaults: true }
  ```

  ```ts
  country: z.string().default("GB"),
  count: z.number().int().default(0),
  ```

  `InserttSchema.parse({ name: 'x' })` returns `{ name: 'x', country: 'GB', count: 0 }`. Verified
  against a real Postgres through PGlite: inserting only the column that has no default leaves the
  database filling in exactly those three values.

  Only **literal** defaults. `defaultNow()`, `defaultRandom()` and any `sql` default are evaluated by
  the database, and `$defaultFn` is called by Drizzle at insert time. Those are told apart by shape
  rather than by name: an SQL default carries `queryChunks`, a function default sets `defaultFn`.
  Both stay `.optional()`, because a schema guessing at either would produce a different value than
  the one actually stored.

  Insert only, and `.default()` replaces `.optional()` rather than stacking with it: `.optional()`
  wrapped around a default short-circuits on an absent key and returns undefined, leaving the default
  unreachable.

  Off by default, because it changes what parsing _returns_ rather than only what it accepts.

### Patch Changes

- Updated dependencies [98c7cd9]
  - @drzl/analyzer@1.11.0

## 3.9.0

### Minor Changes

- 5d6b7a2: Relations v2, declared peer ranges, TypeBox measured against official, and row-level CHECKs.

  ### `defineRelations` produced no relations at all

  Drizzle v1 added a second way to declare relations and the analyzer only knew the first, so a
  schema using `defineRelations` came back with an empty relations array and the oRPC and service
  generators emitted no relation endpoints. Nothing failed; the output was simply missing.
  Confirmed against `@drzl/cli@4.8.0`, which returns `[]` for the schema this now reads.

  The v2 shape is better than v1 for one case in particular: a many-to-many states its join table
  through `through`, where v1 leaves it to a heuristic over tables whose columns are all foreign
  keys. So a join table carrying extra columns is now recognised rather than missed.

  ### Zod 4 output with no declared peer

  The emitted schemas use `z.uuid()` and `z.json()`, both Zod 4 only, and `@drzl/generator-zod`
  declared no peer dependency on zod whatsoever. A Zod 3 project got code that does not compile and
  nothing said why. All three now declare what they emit for: `zod >=4.0.0`, `valibot >=1.0.0`,
  `arktype >=2.0.0`, matching what `@drzl/generator-typebox` already did.

  ### TypeBox is now measured against the official module

  The parity gate could only cross-check the typebox output against DRZL's own generators, and the
  docs said that was unavoidable. It was not: `drizzle-orm/typebox` targets the newer `typebox`
  package and throws on import against the released one, but `drizzle-orm/typebox-legacy` is the
  same module built for `@sinclair/typebox`, which is what this generator emits for.

  Turning it on immediately found a divergence, in DRZL's favour: official emits
  `Type.String({ format: 'uuid' })`, and TypeBox **fails** a format it has no entry for rather than
  ignoring it, so that schema rejects every valid uuid in any project that has not populated
  `FormatRegistry` first. DRZL emits a pattern, which needs no setup.

  ### Row-level CHECK constraints

  `CHECK (start_date < end_date)` was skipped, because neither column alone can say whether it
  holds. It goes on the object schema instead:

  ```ts
  .refine((v) => v['startDate'] == null || v['endDate'] == null || v['startDate'] < v['endDate'],
    { message: 'date_order: startDate < endDate', path: ['startDate'] })
  ```

  Both sides are guarded for null, reproducing SQL, where a comparison involving NULL yields NULL and
  a CHECK passes on NULL. The error is reported against the left column so it has somewhere to land,
  and a constraint naming a column the mode does not carry is left out rather than compared against
  `undefined`.

  Verified against a real Postgres through PGlite: for a table with `CHECK (start_date < end_date)`
  and `CHECK (price <= max_price)`, the emitted schema and the database agree on all five probe rows.

### Patch Changes

- Updated dependencies [5d6b7a2]
  - @drzl/analyzer@1.10.0

## 3.8.0

### Minor Changes

- d557658: CHECK constraints: `IN` lists and conjunctions.

  The two most common shapes a CHECK is written in were both skipped. No official Drizzle validator
  module enforces any CHECK at all, so these are added to a list that already had no competition.

  ### `IN` lists become enums

  ```ts
  // check('status_valid', sql`${t.status} IN ('active', 'archived')`)
  status: z.enum(['active', 'archived'] as const),
  ```

  A set constraint is what an enum is, so it takes the enum's shape in each library rather than
  becoming an opaque predicate, and the static type narrows with it: `v.picklist` for valibot,
  `'active' | 'archived'` for ArkType, `Type.Union([Type.Literal(...)])` for TypeBox.

  ### Conjunctions split into one check per part

  ```ts
  // check('n_bounds', sql`${t.n} > 0 AND ${t.n} < 10 AND ${t.n} <> 5`)
  n: z.number().int()
    .refine((v) => v > 0, { message: 'n_bounds: n > 0' })
    .refine((v) => v < 10, { message: 'n_bounds: n < 10' })
    .refine((v) => v !== 5, { message: 'n_bounds: n <> 5' }),
  ```

  Every part of an `AND` has to hold on its own, which is exactly what a list of refinements means.

  The split walks the expression rather than splitting on the text, so the `AND` inside `BETWEEN 1
AND 10` and the one inside `'A AND B'` are both left alone. Lifting `BETWEEN` above the split was
  necessary for that: taking the naive order silently turned every `BETWEEN` into an unparseable
  pair and dropped a constraint that had been enforced since the feature shipped.

  ### What is still refused, and why it grew

  `OR` and `NOT` anywhere in the expression disqualify it. A conjunction is safe to break apart
  because each part holds independently; a disjunction is not, and separating them inside a mixed
  expression needs a real parser. A conjunction where any single part is not understood is refused
  whole rather than partially applied, since enforcing half of a constraint is enforcing a different
  constraint.

  Verified against a real Postgres through PGlite: for `CHECK (status IN ('active','archived'))`,
  `CHECK (age >= 18 AND age <= 65)` and `CHECK (n > 0 AND n < 10 AND n <> 5)`, the emitted schema and
  the database agree on all 19 probes, NULL included.

## 3.7.0

### Minor Changes

- fadf2fb: Check generated schemas against Postgres itself, and validate the numeric format.

  Every check so far compared DRZL to `drizzle-orm`'s validators. Both can be wrong about the same
  column and neither is the authority, so `verify:packed` now runs the emitted schemas against a
  real Postgres through PGlite: 1287 probes, each an actual INSERT, with the database answering
  directly.

  DRZL agrees with Postgres on **920** of them to `drizzle-orm`'s **897**, and is never further from
  the database on a column where `drizzle-orm` is closer.

  ### What it found

  A `numeric`/`decimal` column is returned as a string, because a JS number cannot hold arbitrary
  precision. That left the schema a bare `z.string()`, which accepts `'hello'` for a numeric column.
  `drizzle-orm/zod` still does; Postgres rejects it. Numeric columns now carry the real grammar,
  which is broader than it looks: a sign, a leading `.`, exponents, `NaN`/`Infinity`, surrounding
  whitespace, and since Postgres 16 the underscore digit separators and `0x`/`0o`/`0b` literals, so
  `1_000` and `0xDEAD_beef` are valid. Not applied on SQLite, whose NUMERIC affinity stores whatever
  text it is given.

  ### What it stopped

  `date`, `timestamp`, `time`, `interval`, `inet`, `cidr` and `macaddr` were all attempted and all
  dropped, each caught turning away input Postgres accepts:

  | Type      | What the pattern would have refused                              |
  | --------- | ---------------------------------------------------------------- |
  | `date`    | `today`, `January 8, 1999`, `20200101`, `01/02/2020`, `infinity` |
  | `time`    | `allballs`, `12:00:00+02`                                        |
  | `macaddr` | `2020-01-01`, which Postgres pads into `20:20:00:01:00:01`       |
  | `inet`    | `10.1/16`, `::ffff:1.2.3.4`                                      |
  | `cidr`    | parses as `inet`, then additionally demands zero host bits       |

  Those keep a plain string. A check that refuses valid data is worse than no check, and without the
  database to ask, all seven looked equally shippable.

  ### The gate

  CI fails if a generated schema disagrees with Postgres where `drizzle-orm` agrees, which is what
  an over-strict check looks like. Verified to bite by removing underscore support from the numeric
  pattern: it fails and names `'1_000'`.

  Incidentally settled an earlier judgement call: DRZL types `bytea` as `Uint8Array` where official
  demands a `Buffer`, and Postgres accepts the `Uint8Array`. Official is the one refusing valid data
  there.

### Patch Changes

- Updated dependencies [fadf2fb]
  - @drzl/analyzer@1.9.0

## 3.6.0

### Minor Changes

- c3b978f: `typedColumns`: take every column's static type from Drizzle, not just the untyped ones.

  `.$type<T>()` is a compile-time cast on **any** column, not just json. Drizzle's implementation is
  literally `$type() { return this }`, so `text().$type<'admin' | 'member'>()` is an ordinary string
  to anything reading the column at runtime, and `drizzle-orm/zod` and DRZL alike emitted a plain
  `z.string()` with the narrowing lost.

  ```ts
  { kind: 'zod', path: 'src/validators/zod', typedColumns: true }
  ```

  ```ts
  role: z.string().max(50).pipe(z.custom<(typeof users.$inferSelect)['role']>()),
  ```

  The runtime schema is untouched. The reference is appended rather than substituted, so a
  `varchar(50)` keeps its length check and only its _type_ narrows, and a typo in
  `if (user.role === 'admni')` becomes a compile error rather than dead code. Nothing narrows it at
  runtime, because the cast leaves no trace there.

  Appending happens after the nullable and optional wrappers, checked against zod rather than
  assumed: `.pipe()` keeps a key optional both when parsing and in the inferred type. A json or
  custom column still has its schema _replaced_ rather than appended to, since it has no runtime
  type worth keeping.

  Implies `typedJson`, since both need the schema imported back. Off by default: it adds a `.pipe()`
  to every field, which is noise unless you use `.$type<T>()`.

## 3.5.0

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
  - @drzl/analyzer@1.8.0

## 3.4.0

### Minor Changes

- eeafa5c: Array and structured columns, and a measured parity gate against the official validators.

  A differential harness now generates schemas for a 39 column Postgres table with DRZL and with
  `drizzle-orm/{zod,valibot,arktype}`, then pushes the same pool of values through both, column by
  column. It found DRZL weaker on **15 of 39 columns**. All 15 are fixed, and the harness runs in
  CI as part of `verify:packed` so a new divergence fails the build rather than being noticed later.

  ### Columns whose schema rejected every row
  - **Arrays were collapsed to their element.** Drizzle gives an array no class of its own:
    `text().array()` is still a `PgText`, separated from a scalar only by `dimensions`. Reading the
    class alone produced `z.string()`, which rejected `['a']` and accepted `'a'`.
  - **`point`, `line` and `geometry` were mapped to strings.** They arrive as `[number, number]`.
  - **`serial` was lower-bounded at 1.** Postgres serial is an ordinary integer column that defaults
    from a sequence; the sequence starts at 1, the column does not, and inserting `0` or a negative
    is how backfills and sentinel rows get written.
  - **ArkType output containing a binary column could not be imported at all.** `'Uint8Array'` is
    not an ArkType keyword, so the emitted module threw `'Uint8Array' is unresolvable` at import and
    took its importer with it. The keyword is `TypedArray.Uint8`.

  ### Columns whose schema accepted anything

  `bytea`, `bit` and `vector` emitted `z.unknown()`, which accepts `null` on a NOT NULL column.
  `json` and `jsonb` emitted `z.any()`, which accepts `undefined`, `NaN`, `Infinity`, bigints, Dates
  and Buffers, none of which survive the round trip. `real`, `double precision` and
  `numeric({ mode: 'number' })` were unbounded.

  | Column                      | Before        | Now                                     |
  | --------------------------- | ------------- | --------------------------------------- |
  | `text().array()`            | `z.string()`  | `z.array(z.string())`                   |
  | `point()`                   | `z.string()`  | `z.tuple([z.number(), z.number()])`     |
  | `vector({ dimensions: 3 })` | `z.unknown()` | `z.array(z.number()).length(3)`         |
  | `bit({ dimensions: 3 })`    | `z.unknown()` | `z.string().regex(/^[01]*$/).length(3)` |
  | `bytea()`                   | `z.unknown()` | `z.instanceof(Uint8Array)`              |
  | `jsonb()`                   | `z.any()`     | `z.json()`                              |
  | `real()`                    | `z.number()`  | `z.number().gte(-8388608).lte(8388607)` |
  | `serial()`                  | `.gte(1)`     | `.gte(-2147483648)`                     |

  All four generators handle all of it, and the harness also checks the four against each other, so
  `bytea` validates identically whichever validator you pick.

  ### Two bugs found only by running the output
  - **Every ArkType `integer()` column accepted `1.5`.** The generator preferred the range on the
    theory that an integer range implied integrality. ArkType parses
    `-2147483648 <= number.integer <= 2147483647` perfectly well and rejects the fraction.
  - **`v.tuple` ignores extra items**, so a valibot `point` accepted `[1, 2, 3]`. `v.strictTuple`
    holds the arity. `drizzle-orm/valibot` uses the plain form and accepts the third element.

  ### Reading the type from Drizzle rather than guessing at it

  Drizzle v1 stamps every column with a `dataType` of the form `"number int32"`, `"object buffer"`,
  `"array point"`, plus a `codec` naming the SQL side. The analyzer now reads those. It used to
  match on the constructor name against a list running to dozens of entries per dialect, with a
  regex fallback that guessed from the name when it missed, which is how `PgBinaryVector` came out
  as a vector when it is a bit string. The class-name path is still there for Drizzle 0.4x, which
  carries no `codec`.

  `Column` gains `arrayDimensions`, `shape`, and `integer`. That last one exists because the
  generators each inferred "is an integer" from "declares both bounds", which was true only while
  integers were the only bounded type: bounding `real` made every float schema reject `1.5` until
  the flag replaced the inference.

  ### Where DRZL deliberately differs
  - `bytea` accepts any `Uint8Array` where official demands a `Buffer`. A Buffer is a Uint8Array, so
    nothing official accepts is turned away, and the wider check needs no `@types/node`, works in a
    runtime with no `Buffer`, and makes a Postgres `bytea` and a SQLite `blob` behave the same.
  - valibot json rejects `Infinity` and class instances, which the official one accepts.
  - ArkType `bigint` carries no range. Its comparison operators take numeric literals, so a 64 bit
    bound cannot be written in the string DSL this generator emits; official states it with a narrow
    predicate built through the builder API.

  Each is listed in the harness with its reason, so it stays a decision rather than drift.

### Patch Changes

- Updated dependencies [eeafa5c]
  - @drzl/analyzer@1.7.0

## 3.3.0

### Minor Changes

- 5a99384: New generator: `@drzl/generator-typebox`.

  ```ts
  { kind: 'typebox', path: 'src/validators/typebox' }
  ```

  TypeBox is the second most used validator in the Drizzle ecosystem: `drizzle-typebox` at 41,537
  weekly downloads beats `drizzle-valibot` (17,216) and `drizzle-arktype` (6,761) _combined_ by
  1.73x. DRZL shipped both of the smaller ones and not this one.

  It has everything the other three generators have: column constraints, CHECK constraint
  enforcement, `typedJson`, affixes, file suffixes and import extensions. Because TypeBox is JSON
  Schema, constraints are keywords rather than chained calls, which makes the output the most
  directly readable of the four and usable by anything that speaks JSON Schema:

  ```ts
  export const SelectpeopleSchema = Type.Object({
    age: Type.Integer({ minimum: 18, maximum: 2147483647 }), // CHECK (age >= 18)
    score: Type.Union([Type.Integer({ minimum: 0, maximum: 100 }), Type.Null()]),
    tier: Type.Literal('gold'), // CHECK (tier = 'gold')
  });
  ```

  ### Two places TypeBox fails silently, both handled

  TypeBox accepts an option it does not understand for a given type and then ignores it, so a
  schema can look right, compile, and validate nothing. Both of these were found by running the
  emitted schemas rather than reading them:

  - **`format` needs registration.** `Type.String({ format: 'uuid' })` returns `false` for a
    perfectly valid uuid in any project that has not populated `FormatRegistry`. A uuid column is
    emitted as a `pattern` instead, which needs no setup.
  - **`const` is ignored on `String` and `Integer`.** `Type.String({ const: 'gold' })` validates
    `'silver'`, and `Type.Integer({ const: 5 })` validates `6`. An equality check is emitted as
    `Type.Literal` instead, which is the only form that enforces.

  The test suite writes the emitted module to disk, imports it, and runs `Value.Check` against it,
  because asserting on generated source text cannot tell the difference between a schema that
  validates and one that merely parses.

## 3.2.0

### Minor Changes

- d2ac66d: Two things no runtime-derived validator can do.

  ### `typedJson`: json columns typed from your schema

  `.$type<T>()` is a compile-time cast. Drizzle implements it as `$type() { return this }`, so
  nothing about the declared type survives to runtime and every runtime-derived validator is blind
  to it. `drizzle-orm/zod` types a json column as its generic `Json` whatever you wrote, and that
  is the highest-reaction open issue on the repository.

  A generator does not have to resolve the type itself, because Drizzle already did:

  ```ts
  prefs: z.custom<(typeof settings.$inferSelect)["prefs"]>(),
  ```

  `typeof settings.$inferSelect['prefs']` _is_ the declared type, resolved by TypeScript at the
  point of use. So generics, unions and imported interfaces all work, which are exactly the cases
  that defeat approaches that parse the source and rebuild the type. Insert and select reference
  their own inference, since a defaulted json column is optional on insert and its type differs.

  Enable per generator:

  ```ts
  { kind: 'zod', path: 'src/validators/zod', typedJson: true }
  ```

  Off by default: it adds an `import type` of your schema module to the generated file. That import
  is erased at build time, so it adds no runtime dependency and cannot create a runtime cycle, but
  the coupling should still be a choice.

  Verified by compiling the result: `z.infer<typeof SelectsettingsSchema>['prefs']` is the declared
  type, a wrong shape is a type error, and it is assignable back to the original interface.

  ### `drzl generate --check`: drift detection for CI

  ```bash
  drzl generate --check
  ```

  Regenerates and fails if the result differs from what is committed, naming every file:

  ```
  Generated output is out of date (2 file(s)):
    ~ changed  src/validators/zod/people.zod.ts
    + added    src/validators/zod/extra.zod.ts
  ```

  Exits 1 on drift and 0 when current. It catches the two things that actually happen, someone
  editing generated files by hand and someone changing the schema without regenerating, and it
  catches them in CI rather than in review.

  This is only available to a code generator. Runtime modules derive their schemas in memory at
  import time, so there is nothing on disk to have drifted and nothing to compare.

  **It never modifies your working tree.** Redirecting output to a temporary directory would not
  work, since generated files contain paths computed relative to their own location and every file
  would report as drifted. So the real directories are snapshotted, regeneration is allowed to
  overwrite them, and the snapshot is restored either way, including deleting anything the run
  created.

## 3.1.0

### Minor Changes

- c90fd42: **Generated Zod schemas now enforce CHECK constraints. No official Drizzle validator does.**

  Verified against `drizzle-orm/zod` at 1.0.0-rc.4: a table declaring
  `check('age_adult', sql`${t.age} >= 18`)` produces an insert schema that accepts `{ age: 5 }`.
  The constraint is right there in the schema, the database will reject the row, and the validator
  says nothing. Same for valibot, arktype and typebox.

  DRZL emits:

  ```ts
  age: z.number().int().gte(-2147483648).lte(2147483647)
    .refine((v) => v >= 18, { message: "age_adult: age >= 18" }),
  ```

  `BETWEEN 0 AND 100` becomes two refinements. The constraint name is in the message, so a failure
  points at the thing in the schema that caused it.

  ### It refuses more than it accepts, on purpose

  Only a comparison naming one column against one literal is translated. A schema that quietly
  enforces a _guess_ at your constraint is worse than one enforcing nothing, because it rejects
  rows the database would have accepted. Skipped, not guessed: comparisons between two columns
  (`start_date < end_date`, a statement about the row rather than a field), compound predicates,
  function calls, and regex matches, whose `~` in Postgres is POSIX ERE and not JavaScript's
  dialect.

  ### Two pieces of SQL semantics that a naive version gets wrong

  **A CHECK passes on TRUE or NULL.** So `CHECK (score >= 0)` on a nullable column accepts NULL.
  The refinement is applied to the inner type and `.nullable()` wraps it, which reproduces that
  exactly rather than being stricter than the database.

  **The bound has to survive.** `sql`${t.age} >= ${MIN}`` used to render as `age >= ?`, because
  `renderSql` mapped an interpolated value to `?`. Drizzle puts a primitive into the chunk list as
  itself rather than wrapping it, so the value was there all along and was being discarded. Any
  refinement built from that expression would have been built from a hole. Fixed in the analyzer,
  which also makes `Table.checks[].expression` correct for anything else reading it.

  Valibot and ArkType keep their current output; the parser lives in `@drzl/validation-core` as
  `parseCheck`, so they can adopt it without reimplementing it.

### Patch Changes

- Updated dependencies [c90fd42]
- Updated dependencies [6d6857f]
- Updated dependencies [6d6857f]
  - @drzl/analyzer@1.6.0

## 3.0.0

### Major Changes

- b0543a4: **Breaking:** insert schemas now contain the primary key when the database does not supply one.
  They omitted it unconditionally, so for a natural or non-generated key the schema could not
  express a valid insert: the required column was simply absent, with no way to provide it.

  `isGeneratedColumn` answered `c.isGenerated || primaryKeyColumns.includes(c.name)`, dropping
  every primary key whether or not the database generated it. Being a key says nothing about who
  supplies the value. The question is whether the database provides one, which `isGenerated`
  answers for columns that cannot be written and `hasDefault` for columns that need not be.

  ### What changes

  | column                                                       | before  | after                 |
  | ------------------------------------------------------------ | ------- | --------------------- |
  | `serial('id').primaryKey()`, pg                              | omitted | present, **optional** |
  | `integer('id').primaryKey().generatedAlwaysAsIdentity()`, pg | omitted | present, **optional** |
  | `integer('id').primaryKey()`, pg                             | omitted | present, **required** |
  | `text('slug').primaryKey()`                                  | omitted | present, **required** |
  | `integer('id').primaryKey()`, sqlite                         | omitted | present, **optional** |
  | `int('id').primaryKey().autoincrement()`, mysql              | omitted | omitted               |

  An auto-generated key stays absent, since it cannot be written. A defaulted key is present and
  optional, so it may be supplied or left out; previously neither was possible. A key the caller
  has to supply is present and required, which is what makes the insert expressible at all.

  This can fail a build that regenerates, and that is the point: those call sites were building
  inserts with no primary key, which the database would have rejected at runtime. Postgres does
  not generate `integer('id').primaryKey()`; only `serial` and identity columns are generated.

  ### The analyzer half

  `hasDefault` was computed from `col.default` and `col.config.default`, neither of which Drizzle
  populates. It now reads `col.hasDefault`, which Drizzle does set, plus `defaultFn` for runtime
  defaults. Without this the two halves of the table above are indistinguishable: every Postgres
  `serial`, every identity column and every SQLite rowid alias reported `hasDefault: false`,
  exactly like a plain `integer('id').primaryKey()`.

  That fix also reaches ordinary columns: any column whose default came from `.default()` or
  `.$defaultFn()` was previously reported as having none, so it was emitted as required in insert
  schemas rather than optional.

  `@drzl/generator-orpc` already filtered on `isGenerated` alone for its inline schemas, so its
  output was correct and is unchanged apart from the improved `hasDefault` signal. The standalone
  validation generators and the shared schemas disagreed with it until now.

### Patch Changes

- Updated dependencies [b0543a4]
  - @drzl/analyzer@1.5.0

## 2.1.0

### Minor Changes

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

- 6034a24: Make the generated barrel follow `fileSuffix` instead of the default suffix.

  The zod, valibot and arktype generators named each emitted file from `fileSuffix` but wrote
  the barrel with the default suffix hardcoded, so any custom value produced an `index.ts`
  full of imports that pointed at nothing:

  ```ts
  // drzl.config.ts
  { kind: 'zod', path: 'src/validators/zod', fileSuffix: '.schema.ts' }
  ```

  ```ts
  // src/validators/zod/index.ts, next to users.schema.ts and posts.schema.ts
  export * from './users.zod'; // TS2307: Cannot find module './users.zod'
  export * from './posts.zod';
  ```

  The consumer's build failed on the unresolved imports, and so did anything importing the
  barrel, including an `orpc` generator pointed at it through `validation.importPath`. The
  only `fileSuffix` that worked was the default one. Both halves now come from the same
  value, so the barrel renames along with the files.

  Suffixes that are not simply `.<name>.ts` are handled too. A suffix with no leading dot
  runs straight onto the table name (`Schema.ts` gives `usersSchema.ts` and
  `./usersSchema.js`), a suffix that is only an extension leaves the bare table name (`.ts`
  gives `users.ts` and `./users.js`), and `.mts` and `.cts` are written as `.mjs` and `.cjs`,
  which is the only form TypeScript resolves for them.

  Leaving `fileSuffix` unset no longer reproduces the pre-2.0 barrel byte for byte, but that
  is down to the separate `importExtension` change in this same release, which puts a `.js` on
  every specifier DRZL generates. Set `importExtension: 'none'` and the default output is what
  it always was.

  `@drzl/validation-core` exports the two helpers the generators share, `moduleFileName` and
  `moduleSpecifier`, so the file name and the import specifier cannot drift apart again.

### Patch Changes

- Updated dependencies [549ee51]
  - @drzl/analyzer@1.3.0

## 1.1.0

### Minor Changes

- c48d79a: sponsor initiatives

### Patch Changes

- Updated dependencies [c48d79a]
  - @drzl/analyzer@1.2.0

## 1.0.0

### Major Changes

- 5da6f6b: support MySQL, SingleStore, and Gel; expand Postgres/SQLite; add tests (fixes #13)

### Patch Changes

- Updated dependencies [5da6f6b]
  - @drzl/analyzer@1.0.0

## 0.3.0

### Patch Changes

- @drzl/analyzer@0.3.0

## 0.2.0

### Patch Changes

- @drzl/analyzer@0.2.0

## 0.1.0

### Patch Changes

- @drzl/analyzer@0.1.0

## 0.0.3

### Patch Changes

- @drzl/analyzer@0.0.3

## 0.0.2

### Patch Changes

- @drzl/analyzer@0.0.2

## 0.0.1

### Patch Changes

- @drzl/analyzer@0.0.1
