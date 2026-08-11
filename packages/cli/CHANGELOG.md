# @drzl/cli

## 4.28.0

### Minor Changes

- b664488: Add `@drzl/generator-tanstack-start`: TanStack Start server functions generated from a Drizzle
  schema, one module per table, reads on `GET` and writes on `POST`.

  The cleanest fit of any target DRZL generates for, and measured rather than assumed. Against
  `@tanstack/react-start` 1.168.42 on 2026-08-11, `createServerFn().validator(schema)` takes any
  Standard Schema and is properly variance-aware in both directions: the handler receives the schema's
  output, so a date column's `string -> Date` transform does real work at the boundary, and the caller
  supplies its input, so a date crosses the wire as an ISO string and passing a `Date` from the caller
  is a compile error. zod, valibot and arktype were each compiled through it, transform included, and
  all three behave identically. No adapter, no cast, no per-library escape.

  That is worth recording because the sibling case does not behave that way: TanStack Form's validator
  constraint is invariant, since the Standard Schema input type sits in a property, so no schema shape
  removes the cast documented on the Form example.

  What the generator decides that a hand-writer gets wrong is the method. `createServerFn` defaults to
  `GET`, which is right for a read and wrong for every write: a mutation behind a cacheable verb is one
  an intermediary is entitled to replay.

  One constraint the tests now pin: Start type-checks both ends of a server function for
  serialisability, the validator's input and the handler's return value, and a type of `unknown` fails
  either way with `SerializationError<"Type may not be serializable">`. That is reachable from a real
  schema, because a `customType` column with no `$type<T>()` reaches the schema as `unknown`. Named in
  the generator's docs, and asserted by a case that fails if Start ever stops refusing it.

  `@drzl/cli` gains the `tanstack-start` kind. Like `next`, it has a single mode: it emits no schemas
  of its own, so the options builder forces `validation.useShared` and derives `validation.importPath`
  from the sibling validation generator's own `path`. The new package is an `optionalDependency` for
  this release only, for the reason the other three new generators already are.

## 4.27.0

### Minor Changes

- 26e2ba7: Add `@drzl/generator-ai`: Vercel AI SDK tools generated from a Drizzle schema, five per table, with
  the table's `CHECK` constraints reaching the model as bounds on the arguments it is allowed to send.

  The same thesis as `@drzl/generator-mcp` over a different surface. A tool hands a model a JSON
  Schema and the model writes arguments against it; derive that schema from the column types alone and
  the model learns that `age` is an integer and nothing else, so it guesses, the write reaches the
  database, and the database refuses it.

  One measurement changed what this emits. `tool()` accepts any Standard Schema, and the SDK's adapter
  decides whether a validation passed with `'value' in result`. A valibot failure result is
  `{ value, typed, issues }`: it carries a `value` key **even when it failed**. So every valibot
  validation failure is reported to the AI SDK as a success and the invalid input reaches `execute`.
  Measured on 2026-08-11 against `ai` 7.0.59 and `@ai-sdk/provider-utils` 5.0.26 with a schema
  demanding `age >= 18`: zod and arktype refuse `{ age: 7 }` through the SDK and valibot accepts it,
  because their failure results carry no `value` key and valibot's does.

  A generated valibot tool would therefore have validated nothing at all, silently, and would have
  looked identical to one that worked in the emitted text and in a type check. So valibot tools are
  emitted through `jsonSchema(document, { validate })` with the parse spelled out. zod and arktype are
  passed through, because they work.

  Two smaller findings shaped the emitted code, both caught by compiling it. Every `execute` carries
  an explicit return type, because a stub whose only statement is `throw` returns `Promise<never>` and
  `never` propagates into `tool()`'s inference until the call matches no overload at all, reporting a
  problem about the input schema for something entirely about the output. And the emitted valibot
  adapter is parameterised on input and output separately, because `v.GenericSchema<T>` defaults its
  output to its input and a date column's input is a string while its output is a `Date`.

  `@drzl/cli` gains the `ai` kind. The new package is an `optionalDependency` for this release only,
  for the reason the other two new generators already are.

## 4.26.0

### Minor Changes

- f94eb5d: Add `@drzl/generator-next`: Next.js server actions generated from a Drizzle schema, one
  `'use server'` module per table, with the `FormData` readers that turn what a browser posts into
  what the schemas accept.

  DRZL already documented this pattern and shipped a runnable example. What neither could do is the
  mechanical half: a schema describes a row and a form posts strings, so between the two sits a
  conversion per column, and every one of them has a wrong answer that looks right.

  The one that decided it, measured on 2026-08-11 against zod 4.4.3, valibot 1.1 and arktype 2:
  `<input type="date">` posts `2026-08-11`, `<input type="datetime-local">` posts `2026-08-11T14:30`,
  and `z.iso.datetime()` and `v.isoTimestamp()` refuse every spelling a form control produces. Only a
  hand-typed `2026-08-11T14:30:00Z` gets through, which nothing in a form emits. A form wired
  straight to a generated schema therefore could not submit a date at all, and the failure surfaced
  as a validation message on a field the user had filled in correctly. `dateField` closes that, and
  it is the same class of defect the Hono generator's `dateInput` closed for JSON bodies.

  Three smaller ones with the same shape: an empty number box posts `''` and becomes `NaN` rather
  than `0`, because `0` is reported against whatever bound zero happens to break; an unchecked
  checkbox is absent from `FormData` rather than posting `false`, so presence is the question; and a
  blank optional text box becomes `null` rather than the empty string the column would have stored.

  Per writable table: `create`, `update` and `delete` shaped for `useActionState`. `update` reads
  only the fields the form actually posted, because an update schema makes every column optional and
  a field the form left out has to stay absent rather than arriving blank and overwriting its column.
  A keyless table keeps `create`. A materialized view gets no module at all: a server action is a
  mutation, and a Next server component reads directly. Plus `form-state.ts`, which is deliberately
  not `'use server'` because such a file may export only async functions and `EMPTY_FORM_STATE` is a
  `const`.

  The directive is emitted on line 1, ahead of the licence banner.

  `@drzl/cli` gains the `next` kind. It is the one generator with a single mode: it emits no schemas
  of its own, so `nextOptions` forces `validation.useShared` and derives `validation.importPath` from
  the sibling validation generator's own `path`, which makes a two-entry config complete. A config
  naming `next` with no validation generator beside it is reported rather than left to fail as an
  import of nothing.

  That derivation carries one fix worth naming, because the same trap cost a round trip on the MCP
  generator: a generator's `path` is project-relative and an `importPath` beginning with `./` is
  relative to the _output_ directory, so a sibling `path` of `./out/schemas` copied straight across
  resolved to `out/next/out/schemas`. The builder strips the prefix, and the branch-parity spec
  points its fixture at a non-default directory so a dropped derivation changes the bytes.

  The new package is an `optionalDependency` of `@drzl/cli` for this release only, for the reason
  `@drzl/generator-mcp` already is: a package name that has never existed cannot publish through npm
  trusted publishing.

## 4.25.0

### Minor Changes

- 55b986a: Add `@drzl/generator-mcp`: a Model Context Protocol server generated from a Drizzle schema, one
  tool module per table, with the table's `CHECK` constraints reaching the model as bounds on the
  arguments it is allowed to write.

  An MCP tool hands a model a schema and the model writes arguments against it. Derive that schema
  from the column types alone and the model learns that `age` is an integer and nothing else: it
  guesses a value, the write reaches the database, and the database refuses it. Pointed at DRZL's
  own schemas through `validation.useShared`, the same tool advertises
  `{"type":"integer","minimum":18,"maximum":120}`, and an out-of-range argument is refused before
  the handler runs. A `CHECK` comparing two columns cannot be a keyword in any schema language, so
  those are named in the tool's description instead.

  Five tools per table: `list`, `get`, `create`, `update`, `delete`, each carrying the `readOnlyHint`
  / `destructiveHint` / `idempotentHint` annotations a client reads to decide whether it may call a
  tool without asking first. A table with no primary key keeps `list` and `create`; a materialized
  view keeps `list` and `get`. Plus `index.ts` exporting `createServer()` and a runnable `stdio.ts`.

  `sdk` defaults to `'v2'` (`@modelcontextprotocol/server`), which is the smaller of the two by
  installs and the only one that works for every library DRZL emits: measured on 2026-08-11,
  `@modelcontextprotocol/sdk` types `inputSchema` as zod-only and throws at registration on an
  arktype or valibot schema, so a server built that way dies on startup. `sdk: 'v1'` beside a
  non-zod library is refused at generation time rather than emitted.

  Under valibot the emitted tools wrap each schema in `toStandardJsonSchema` from
  `@valibot/to-json-schema`, because valibot 1.1's `~standard` carries no `jsonSchema` property while
  zod 4's and arktype 2's do. Without the wrapper the tool registers cleanly and advertises no
  arguments at all, which nothing reports.

  `@drzl/cli` gains the `mcp` generator kind, the `sdk`, `serverName`, `serverVersion` and `stdio`
  options, and `naming.toolPrefix`. The new package is an `optionalDependency` for this release only,
  because a package name that has never existed cannot publish through npm trusted publishing and a
  hard dependency on one breaks `npm i @drzl/cli` for everyone until the first publish lands. It is
  promoted once it is on the registry, and `scripts/verify/stages/33-registry-deps.sh` now fails
  when that promotion is due.

## 4.24.4

### Patch Changes

- 055b28f: `drzl generate` over an up-to-date tree now touches nothing

  The command already knew which files were unchanged, and printed the count. It wrote them anyway. A
  byte-identical write is a no-op with a side effect: it moves the file's mtime, and an mtime is what
  every watcher downstream keys on, so regenerating a tree that had not changed restarted dev servers,
  re-ran type checkers and invalidated bundler caches for no reason.

  An unchanged file is now left alone, which makes `generate` idempotent at the filesystem level:
  what it claims when it prints `unchanged`.

  The comparison is against what is on disk now rather than against what was there when the run
  started. The two differ for a path written twice in one run, which is what happens when two
  generators share an output directory: the first write has already put different bytes there, so
  "identical to what was there before the run" stops meaning "identical to what is there". That case
  is tested, and the last write still wins.

## 4.24.3

### Patch Changes

- 786732a: A run that falls back to the default `generators` says so

  `generators` defaults to `[{ kind: 'orpc' }]`, so the smallest config that parses writes a whole
  oRPC router tree. Someone who came for validation schemas and wrote `{ schema: './db.ts' }` got an
  API surface, with nothing in the output naming where it came from.

  The default is now named where it applies, with the choices beside it: which kinds emit validation
  schemas, which emit an API surface, and which emits typed data-access stubs. Writing the key out
  silences it, even when the value written is the same one.

  Deliberately a warning rather than a change. Both ways of removing the surprise, requiring the key
  or defaulting to `zod`, change what an existing config does, and that belongs with a major rather
  than a patch. The silence does not have to wait for one.

- Updated dependencies [6aa7581]
  - @drzl/analyzer@1.21.5

## 4.24.2

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
- Updated dependencies [2c139fb]
  - @drzl/analyzer@1.21.4
  - @drzl/validation-core@3.22.4
  - @drzl/generator-zod@3.21.3
  - @drzl/generator-valibot@3.20.3
  - @drzl/generator-arktype@3.17.4
  - @drzl/generator-typebox@0.14.4
  - @drzl/generator-effect@0.5.3
  - @drzl/generator-service@2.5.2

## 4.24.1

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
  - @drzl/generator-arktype@3.17.1
  - @drzl/generator-effect@0.5.1
  - @drzl/generator-json-schema@0.9.1
  - @drzl/generator-orpc@2.9.1
  - @drzl/generator-service@2.5.1
  - @drzl/generator-typebox@0.14.1
  - @drzl/generator-valibot@3.20.1
  - @drzl/generator-zod@3.21.1
  - @drzl/validation-core@3.22.1

## 4.24.0

### Minor Changes

- 8539626: Every generator is a package the CLI resolves, not code it carries: all fourteen are externalised
  and all fourteen are hard dependencies.

  **Half the generators travelled inside `dist`, and the dividing line was a publishing accident.**
  tsup externalises `dependencies` and `peerDependencies` and copies everything else into the bundle.
  Read out of its own build rather than assumed: `getProductionDeps` is
  `new Set([...Object.keys(data.dependencies || {}), ...Object.keys(data.peerDependencies || {})])`,
  and `runEsbuild` turns exactly that set into the patterns its external plugin matches. Eight
  generator packages were `optionalDependencies`, so eight generators were bundled and six were not.
  The measured shape of the previous build: `chunk-KKPDOZOD.js` opening
  `// ../generator-json-schema/dist/index.js`, plus seven `dist-*.js` chunks of the same shape, one
  per bundled generator.

  The reason those eight were optional had nothing to do with bundling. A package that has never
  existed cannot publish through npm's trusted-publisher OIDC flow, so its first version goes out by
  hand, and naming it as a hard dependency in the same release breaks `npm i @drzl/cli` for everyone
  until it exists. All eight are on the registry now, so the constraint is gone and the accident with
  it.

  **The install message was unreachable for exactly the eight kinds whose documentation promised
  it.** Measured on the previous build, per kind, by deleting the package from a built install and
  running `generate`: `orpc`, `service`, `zod`, `valibot`, `arktype` and `typebox` exited 1 naming the
  package to install; `trpc`, `hono`, `express`, `fastify`, `nestjs`, `graphql`, `effect` and
  `json-schema` exited **0 and wrote their files anyway**, out of the copy inside the CLI. Deleting a
  package could not make it absent. All fourteen now exit 1 with

  ```
  The hono generator is not installed.
  Install with: npm install @drzl/generator-hono
  ```

  and write nothing, with no stack frame on stderr. Asserted per kind rather than for one kind
  standing in for thirteen others.

  **The rule is the manifest, not a list.** `packages/cli/tsup.config.ts` externalises the union of
  `dependencies`, `optionalDependencies` and `peerDependencies`, read from the package's own
  `package.json`. There is no array for the next generator to be missing from: adding a generator to
  this package means adding it to `dependencies`, which is the same edit. The converse edge is a test,
  because a registry entry whose package no dependency field names is a package esbuild is entitled to
  bundle again.

  **The eight are `dependencies` now, not `optionalDependencies`, and the install got smaller.** An
  optional dependency that fails to install is skipped in silence: measured, with
  `@drzl/generator-hono` declared optional against a tarball npm could not resolve, `npm install`
  printed "up to date" and exited 0, and the only trace was `UNMET OPTIONAL DEPENDENCY` under
  `npm ls --all`. The same tarball as a hard dependency exits 1 naming the problem. For a CLI whose
  whole job is running these packages, finding out at install time is worth more than an install that
  appears to succeed.

  The cost of that is negative, which is the part worth measuring rather than asserting. npm installs
  `optionalDependencies` by default, so an ordinary `npm i @drzl/cli` already downloaded all fourteen
  generators and then downloaded eight of them a second time inside the CLI. Measured from packed
  tarballs installed into an empty project:

  |                                        | before      | after       |
  | -------------------------------------- | ----------- | ----------- |
  | `@drzl/cli` tarball                    | 626,963 B   | 437,569 B   |
  | `@drzl/cli` unpacked                   | 2,497,184 B | 1,630,700 B |
  | the eight generator packages, unpacked | 576,378 B   | 576,378 B   |
  | CLI plus those eight, on disk          | 3,073,562 B | 2,207,078 B |

  That is 866,484 bytes less on disk and 189,394 bytes less on the wire, for an install that can now
  run every kind under `--omit=optional` where before that flag left eight kinds running only because
  their code was bundled.

  Nothing else moves. The emitted tree is byte-identical across the change: 47 file pairs from a
  config naming all fourteen kinds, generated by both CLIs from one packed install over one fixture,
  `diff -r` clean and the two SHA-256 manifests identical. `config.d.ts`, `config.d.cts`, `cli.d.ts`,
  `cli.d.cts`, `config.js`, `config.cjs` and `drzl.config.schema.json` are byte-identical too; the
  only files that changed are `cli.js` and `cli.cjs`, and the only files that disappeared are the nine
  chunks that were carrying generators.

## 4.23.0

### Minor Changes

- 3c643a1: Fail loudly when there is nothing to generate, and name the key when a config is wrong (plan items
  70, 71, 78, 79)

  **A run that produces nothing is now a failure.** Seven inputs were measured on the built 4.22.0
  CLI, and every one of them printed a green tick, exited `0`, and wrote a single `index.ts`
  containing three comment lines and no exports: a schema module that throws on import, one importing
  a package that is not installed, one with a syntax error, a `schema:` naming a file that does not
  exist, a module exporting no tables, a module exporting only helpers, and a config whose
  `include`/`exclude` removed every table. That barrel is how the `.array()` typing bug hid: the run
  that should have reported it reported success.

  All seven exit `1` and write no files. The three causes are three messages, because the fixes have
  nothing in common:

  ```
  Could not load the schema module src/db/schema.ts (DRZL_SCHEMA_001): Error: Cannot find module 'postgres'
  No Drizzle tables found in src/db/schema.ts (DRZL_SCHEMA_002).
  Every table was removed by this config's filters (DRZL_SCHEMA_003). src/db/schema.ts declares 3 tables: users, posts, comments.
  ```

  The distinction is the analyzer's own, not a guess from an empty table list: `DRZL_ANL_IMPORT` and
  `DRZL_ANL_NOFILE` mean the module never ran, and anything else it says describes a module that did.
  That is the same rule `drzl init` was built on. The failing module's file name is in the message,
  which the analyzer's own wording does not carry, because a project with four schema modules and one
  bad import needs to be told which one.

  This covers `--check` as well, where it matters most: a check on a schema that would not load used
  to compare an empty tree with itself and report it up to date, so a CI job guarding the generated
  output passed on a schema nobody could read. `generate:orpc` and `generate:trpc` stop writing
  `placeholder.orpc.ts`, whose contents read "No tables detected in analysis", on a schema that
  imports cleanly and declares nothing.

  **`drzl watch` reports all three and keeps watching.** The one place they are not fatal, and
  deliberately: a watcher exists to be running while the schema is being edited, and a file saved
  mid-expression, a file being written from scratch and a filter being adjusted are all ordinary
  intermediate states. Exiting would mean restarting the watcher to recover from a typo.
  `--pipeline analyze` still completes on a schema with no tables, matching `drzl analyze`, which
  exits `0` on one because that is a true answer to the question it was asked.

  **A config that does not validate names the offending key.** `ConfigSchema.parse` throws a
  `ZodError` whose message is a formatted JSON array of issue objects, and that array was printed
  verbatim: eleven lines in which `outDir` appeared once, inside a `path` array, three levels down.
  Now:

  ```
  drzl.config.ts is not valid (DRZL_CFG_002). 3 problems:
    - outDir: expected string, received number (found 123)
    - generators[0].nestedDepth: expected number, received string (found "deep")
    - columns.users: unrecognized key "ommit". Did you mean "omit"?
  ```

  Array entries are indexed and a key that is not an identifier is quoted, so
  `generators[1].validation.library` and `columns["app_*"].omit` can be pasted back into the file.
  Every problem is listed rather than the first, capped at eight. The value found there is shown
  when it fits, through `String` rather than `JSON.stringify`, so a `NaN` is reported as `NaN` and
  not as the four characters `null`.

  **An unknown config key warns instead of vanishing.** The root object and `GeneratorSchema` are
  both permissive, so zod dropped an unrecognised key in silence: `outDirr` at the root, `typedJsn`
  in a generator entry and `validation: { librari: 'zod' }` in a nested object all generated normally
  and exited `0`. Each is now named, with a suggestion when it is a typo of a real key rather than a
  different word:

  ```
  drzl config: unknown key "typedJsn" in generators[0]; it is ignored. Did you mean "typedJson"?
  ```

  A warning rather than an error, because the run really did honour the rest of the config. Nothing
  is warned about where the key is legitimately the user's own: `columns` is keyed by table pattern,
  `templateOptions` by whatever a template reads, and `$schema` is declared for editors. Where the
  config is strict, an unknown key stays the validation error it already was and gets the key path
  and the suggestion above.

  The known keys at every level are read from the JSON Schema generated from the zod config schema,
  rather than from a list maintained beside it, so `additionalProperties: false` is what tells the
  strict levels from the permissive ones and neither can drift as the config grows.

  **Config warnings go through the output layer.** They were written with `console.warn` from inside
  `loadConfig`, which no flag could see: `drzl generate --json` printed them beside the document that
  is supposed to be the only thing on that channel, and `--quiet` could not remove them. They are
  warnings like any other now, so `--quiet` drops them and `--json` puts them in the document's
  `warnings` array.

- a222570: One output layer for the whole CLI: streams, colour, `--json`, `--quiet` and exit codes (plan
  items 72, 73, 74, 76, 77).

  **`NO_COLOR` is honoured.** It was not, at all: `chalk@6.0.0` vendors a `supports-color` that
  contains the string `NO_COLOR` zero times, so `drzl doctor` emitted the same 32 escape sequences
  with the variable set as without it. Colour is now decided in one place from `NO_COLOR`,
  `FORCE_COLOR`, `TERM` and whether the specific stream is a terminal. `NO_COLOR` wins over
  `FORCE_COLOR`, which is not what chalk does and is deliberate: `NO_COLOR` is what a person puts in
  a shell profile, `FORCE_COLOR` is what a wrapper injects.

  **Colour is decided per stream.** chalk's default instance takes its level from stdout alone, so
  `drzl generate > out.txt` with a terminal still on stderr turned the warnings on that terminal
  colourless. Each stream now gets its own answer.

  **No escape sequence reaches a pipe.** `ora`'s success symbol came from `log-symbols`, which
  colours through `yoctocolors` and never asks whether the stream is a terminal, so on any machine
  with `TERM` set `drzl analyze 2> log` wrote `\x1b[32m✔\x1b[39m` into the file. The symbol and the
  spinner frame are rendered through the shared decision now.

  **stdout is the answer, stderr is the narration.** The sponsor tip was written with `console.log`,
  putting 246 bytes of advertisement into the file list a script was parsing; it is on stderr now,
  and is shown only where an aside has a reader. `init` and `watch` print nothing to stdout at all,
  because what they produce is a file on disk and a running process.

  **`--json` and `-q, --quiet` on every command**, not three and none. `--json` writes exactly one
  JSON document to stdout and nothing anywhere else, on success and on failure alike, so
  `drzl <cmd> --json | jq .` parses with no filtering. Every document carries `command` and
  `exitCode`; failures carry `ok`, `code` and `message`. `analyze` and `doctor` keep their published
  payloads with the envelope merged in at the top level, so existing readers of `.issues` and
  `.findings` are unaffected. `--quiet` drops narration and never drops an error or changes an exit
  code.

  **Three exit codes, documented in one place** (`docs/cli/output.md`): `0` did the work, `1` could
  not do the work, `2` did the work and found something. Four codes moved:

  - `generate` with no config was `2`, now `1`.
  - `generate --check` with drift was `1`, now `2`.
  - `watch` with no config or an unresolvable schema was `2`, now `1`.
  - `analyze` on a missing or unimportable schema was `2`, now `1`; an error-level issue in a schema
    it did read stays `2`.

  And a command stopped reporting success when it had failed: `generate:orpc` and `generate:trpc`
  given a schema that does not exist exited `0` after writing a placeholder file reading "No tables
  detected in analysis". They exit `1` and write nothing.

  **The progress bar only appears when it can say something.** It was drawn for a single table,
  painting one frame at `0%` before being wiped. Measured: the generator loop costs about 105ms fixed
  plus 3.6ms per table and `cli-progress` redraws at 10fps, so it is now drawn only at a terminal,
  only without `--quiet` or `--json`, and only from 25 tables up, which is where the loop first
  outlasts a frame. It is also started per generator rather than once for the run, which fixes a
  config with two generators drawing nothing for the second.

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

- 2c8b20b: drizzle-kit interop: the schema path can come from drizzle.config.ts, so it is written once

  A drizzle-kit project already names its schema in `drizzle.config.ts`, and DRZL demanded the
  same path again in `drzl.config.ts`; two files stating one fact is how the copies drift. Now
  `schema` is optional: when omitted, DRZL reads kit's config instead, trying
  `drizzle.config.ts`, `.js`, `.json` in kit's own candidate order (measured on drizzle-kit
  0.31.10), announcing the file it read, and honouring kit's whole `schema` surface: a string, an
  array, glob patterns, and a directory expanded one level exactly as kit expands it. The new
  `drizzleKit` key pins it down when wanted: a path mirrors kit's `--config` flag, `true` makes a
  missing kit config an error, `false` disables the fallback. `schema` always wins when both are
  set, with a warning; neither yielding a schema is an error naming both files. The `dialect` the
  kit config declares is cross-checked against what the analyzer measures and a contradiction
  warns, since a stale dialect line usually means the config points somewhere it should not.
  `watch` treats it all as config surface: the resolved directories are watched (glob bases
  included, so a new file matching the pattern rebuilds), and editing `drizzle.config.ts`
  re-resolves the schema. `SchemaAnalyzer` now takes `string | string[]` so a barrel-less
  multi-file schema analyzes as one schema; duplicate export names are judged by what Drizzle
  says they are (table name, SQL schema, columns), so the ordinary re-export pattern stays
  silent and a genuine disagreement warns as `DRZL_ANL_DUP_EXPORT`, keeping the first file's
  export deterministically.

- 74def57: `drzl explain <table>`: what DRZL understood about one table

  When a generated schema is wrong, nothing said where it went wrong. `drzl analyze` prints the whole
  `Analysis` for the whole schema as JSON and points at nothing in it, and `drzl doctor` prints only
  the findings, across every table, and is silent about a table that is fine. Neither answers "did
  DRZL misread this column, drop this CHECK, or fail to follow this relation".

  `drzl explain users` prints, for one table: the resolved TypeScript type and the declared SQL type
  per column, with the array depth on the first (a `text[]` reads as `string[]`, not `string`);
  nullability, the key, the unique constraints, the foreign keys and the relations; and every measured
  fact the validation generators act on, which is the range, whether the values are whole, whether the
  column stores `NaN` and the infinities, the declared width or byte cap, the format, the enum
  members, the structured shape and the default.

  Two sections exist for the silent half. Every declared CHECK is shown **as parsed**, with the
  verdict a generated schema gives it and, where nothing enforces it, the shared parser's own reason.
  And a "Not understood" section collects, in one place, every CHECK clause nothing enforces, every
  column with no known type, and every relation the analyzer could not follow. All three produce a
  generated file that exists, compiles and checks less than the database does, with nothing anywhere
  saying so.

  A fact the generators deliberately do not state is marked and explained rather than listed as
  though it were enforced: a `varchar(32)` narrowed by `CHECK (label IN ('a','b'))` never reaches the
  schema as a width, and a `defaultNow()` makes the field optional on insert without any schema
  stating what it becomes. Those verdicts are read off `tableConstraints` in `@drzl/validation-core`,
  which is the same function the emitted constraint ledger is built from, so the report and the
  generated modules cannot disagree.

  A table is found by its database name, its schema-qualified name (`reporting.users`, and
  `public.users` for the default schema) or its TypeScript export name, exact first and then ignoring
  case. A name reaching two tables is refused with both of them named rather than resolved silently.
  A name reaching none lists the tables there are, with the near miss. A table your config's
  `include`/`exclude` removes is still found and still explained, with a line saying the config
  removes it, because that is the answer to "why is there no file for this table".

  With no table argument it prints one line per table with a count of what `explain` would report as
  not understood for each, which on a large schema is what says where to look.

  `--json` writes one document with the envelope merged in at the top level and the same information
  under stable keys, `--quiet` keeps the report and drops only the hints, and it exits `0` when it
  explained the table and `1` when the name reaches no table or more than one, or when there is no
  schema to read. It writes nothing, ever.

- 85fecad: One way to run one generator: `--only <kind>` on `generate` and on `watch`, and one registry behind
  all of it.

  **`--only <kind>[,<kind>]`, on both commands that can run a generator.** It filters the config's
  `generators` list and changes nothing else about the run, so `drzl generate --only zod --check` is a
  drift check over one generator's output. The values it accepts are read from the same zod enum the
  config parser and the published JSON Schema are built from, so a kind a config accepts is a kind
  `--only` accepts, with nothing to keep in step by hand.

  **`--schema <path>` on `generate`**, matching `explain -s`: it overrides the config's `schema` and
  the drizzle-kit fallback. With `--only` and no config file present, a minimal config is built in
  memory, which makes `drzl generate --schema src/db/schema.ts --only orpc` a complete command. It
  emits what `drzl generate:orpc src/db/schema.ts` emits, byte for byte, and it works for all fourteen
  kinds rather than the two that had a command of their own. Everything the config route offers comes
  with it, including `--check`, `--dry-run` and the drift verdicts, none of which the per-kind
  commands could reach.

  **`watch --pipeline` reaches all fourteen kinds, and no longer fails silently.** It listed seven,
  and the other seven matched no dispatch branch at all: `drzl watch --pipeline generate-zod` started,
  printed its watch list, and regenerated nothing for as long as it ran, with no error and nothing
  wrong with the config. The same was true of `generate-service`, `generate-valibot`,
  `generate-arktype`, `generate-typebox`, `generate-effect` and `generate-json-schema`. It is an alias
  for `--only` now, mapping `generate-<kind>` to `<kind>`, and `--pipeline analyze` keeps its meaning.
  A value that is not a pipeline stops the watcher with a named error instead of leaving it running
  and idle, and so does a `--only` value that is not a kind, or a kind this config does not configure.

  **`generate:orpc` and `generate:trpc` are deprecated, and go in 5.0.** They keep working, byte for
  byte, and print one line on stderr naming the replacement command line. That line goes through the
  output layer, so `--quiet` and `--json` both drop it and `drzl generate:orpc --json | jq .` still
  parses. Both commands were strictly less capable than the route replacing them: no config at all
  meant no table or column filters, no naming, no format, no `importExtension`, no shared validation
  schemas, no `databaseInjection`, no drizzle-kit schema resolution, and no write plan, so no
  `--check`, no `--dry-run` and no drift verdicts. They also disagreed with each other, since only one
  of the two had `--servicesDir`. `generate:orpc` reached its generator through a static import, so an
  absent `@drzl/generator-orpc` took the process down with a stack trace before the command ran; it
  now names the package to install, like every other kind.

  **One registry instead of four dispatch chains.** The fourteen-way `if (g.kind === ...)` chain was
  written out in `generate`, in `watch`, and once more in each per-kind command, and every copy
  repeated the package name, the `import()`, the constructor, the default output directory and the
  options builder. That arrangement has already dropped options in silence more than once: five
  validation options never reached a watch rebuild, `servicesDir` reached one command's tRPC branch
  and not the other's, and `watch` had no json-schema branch at all for a while. Each generator states
  those five facts once now, and adding one is one entry. The emitted tree is byte-identical across
  the change: 52 file pairs from a config naming all fourteen kinds, through `generate` and through
  `watch`, and 7 more from the two deprecated commands.

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

- 81704da: `drzl init` finds your schema, asks what to generate, and defaults to a validator

  `init` wrote `schema: 'src/db/schema.ts'` whether or not that file existed. That is not an inert
  mistake, and the measurement is the argument: in an empty directory, `drzl init` exits 0, and the
  `drzl generate` that follows it analyzes nothing, writes `src/api/placeholder.orpc.ts` reading "No
  tables detected in analysis", and also exits 0. The first two commands a new user runs both
  reported success having read no schema at all.

  `init` now detects the schema, drizzle-kit first. If `drizzle.config.ts` is there, DRZL reads its
  `schema` entry through the same resolver `generate` uses, expanding globs and directories exactly
  as drizzle-kit does, and the scaffolded config then states no `schema` of its own: the path stays
  written in one place and DRZL reads it from drizzle-kit at generate time. Otherwise it walks
  conventional locations, `src/db/schema.ts` first, then the same shape under `src/lib/db`, `app/db`,
  `lib/db`, `db`, `drizzle` and the project root, as a file or an `index.ts` inside a `schema/` or
  `schemas/` directory.

  A candidate is validated by **importing it and counting Drizzle tables**, never by `existsSync`. A
  file that imports cleanly and declares no tables is skipped and the walk continues, because a
  `schema.ts` exporting a connection string is worse than no detection: it produces exactly the
  silent placeholder run above. A file that cannot be imported at all, which is usually "install has
  not been run yet", is used with a warning instead of being skipped. When nothing is found, the
  config is still written, with `schema` left out and commented; `init` will not name a file that is
  not on disk.

  The default generator is now `zod` rather than `orpc`, and the rule behind it is narrower than
  taste: `init` offers only generators `@drzl/cli` depends on outright, so every kind it can
  scaffold is installed by definition beside the CLI that scaffolded it. Eight generators are
  `optionalDependencies` instead, including every route generator except oRPC, and an installer skips
  an optional dependency that is not on the registry, so scaffolding one would produce a config whose
  first `drzl generate` fails on a module that was never installed. A test asserts the offered list against `package.json` so that
  cannot drift. The choices are `zod`, `valibot`, `arktype`, `typebox` and `orpc`.

  `-y, --yes` was declared and then ignored: `init` and `init --yes` were byte-identical, so the
  flag advertised an interactive command that did not exist. The prompts are now real, and the flag
  keeps the meaning it always advertised. Non-interactive stays the first-class path: questions are
  asked only when stdin **and** stdout are both terminals and `CI` is unset, no readline interface is
  constructed otherwise, and closing stdin or pressing `Ctrl+D` at a prompt takes the defaults and
  stops rather than waiting. Two new flags, `--schema <path>` and `--generators <list>`, answer the
  two questions from a script, so nothing `init` asks can only be answered by a human.

  An existing config is still never overwritten, and now it is not shadowed either. `init` checked
  only `drzl.config.ts`, so running it beside a `drzl.config.json` wrote the scaffold, exited 0, and
  left the user's config in place but dead: the loader tries the five config names with `.ts` first,
  so the next `drzl generate` ran the scaffold instead of it. All five names are checked now. The
  message is also no longer the raw `EEXIST: file already exists, open ...` errno string, which
  named no command and suggested nothing.

### Patch Changes

- Updated dependencies [cf19c30]
- Updated dependencies [c56125f]
- Updated dependencies [28787ff]
- Updated dependencies [062f305]
- Updated dependencies [2c8b20b]
- Updated dependencies [4801464]
- Updated dependencies [02fc84a]
- Updated dependencies [e7e39a5]
- Updated dependencies [2b79b1b]
- Updated dependencies [9de799b]
  - @drzl/analyzer@1.21.0
  - @drzl/generator-zod@3.21.0
  - @drzl/generator-valibot@3.20.0
  - @drzl/generator-arktype@3.17.0
  - @drzl/generator-typebox@0.14.0
  - @drzl/validation-core@3.22.0
  - @drzl/generator-orpc@2.9.0
  - @drzl/generator-service@2.5.0

## 4.22.0

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

- 86253d9: A Hono route generator, in Hono's own idiom.

  `@drzl/generator-hono` emits one `Hono()` per table: real HTTP routes carrying
  `sValidator` from `@hono/standard-validator` (or `zValidator` from `@hono/zod-validator`,
  with `validator: 'zod'`), and an `index.ts` mounting them all and exporting the `AppType`
  a `hc<AppType>()` client is parameterised by.

  This is not an adapter for the routers DRZL already emits, because Hono needs no help
  mounting those: `@hono/trpc-server` takes a `@drzl/generator-trpc` router as middleware,
  and oRPC's `RPCHandler` mounts a `@drzl/generator-orpc` router on any fetch handler. What
  nothing emitted was Hono's own surface, which is what people choose Hono for.

  It is not a template package either. `ORPCTemplateHooks` hands back oRPC source text, so a
  Hono template written against it would emit a file that does not compile.

  The design follows `@drzl/generator-trpc` rather than the older oRPC choices:

  - The key comes from the table's real `primaryKey`, every column of it, at its real type. A
    table with no primary key keeps `GET /` and `POST /` and loses `GET /:id`, `PATCH /:id`
    and `DELETE /:id`, rather than gaining a fictional numeric `id`. A composite key becomes
    `/:orgId/:userId`.
  - A read-only table gets no write routes and no insert or update schema.
  - The response shape is stated on every route that returns rows. Hono has no `.output()`;
    what a client infers is the handler's return type, so an unannotated empty stub types the
    whole client from `never[]`.
  - The write stubs throw rather than returning their validated input, which is the insert
    shape where the declared response is the select shape.
  - Every emitted module imports only what it uses, so a route module that validates nothing
    does not import a validator package and loads without one installed.

  Path parameters are coerced strictly, which has no counterpart in the tRPC generator: a URL
  segment is always a string, and the idiomatic coercions are built on `Number()`, where
  `Number('')` and `Number(' ')` are both `0`. `GET /users/%20` addressing row `0` is the
  wrong row, not a loose coercion, so the emitted schemas reject it. The strict form is also
  the only one where zod, valibot and arktype agree.

  On `@drzl/cli`: a new `hono` generator kind, wired into both `generate` and `watch` through
  one shared options builder, a `generate-hono` pipeline name for `watch --pipeline`, and a
  `validator` config option. `databaseInjection` is refused with a warning on this kind,
  because it is a contract with `@drzl/generator-service` and these handlers never call one.
  `@drzl/generator-hono` is an **optional** dependency of the CLI, like the tRPC, effect and
  json-schema generators: a package that has never been published cannot publish through
  npm's trusted-publisher OIDC flow, so its first version goes out by hand, and naming it as a
  hard dependency in the same release would break `npm i @drzl/cli` for everyone until it
  exists.

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

- Updated dependencies [9939e4c]
- Updated dependencies [0e295da]
- Updated dependencies [1218361]
- Updated dependencies [45bb6f5]
- Updated dependencies [cc26f38]
- Updated dependencies [f29bff7]
  - @drzl/validation-core@3.21.0
  - @drzl/generator-zod@3.20.0
  - @drzl/generator-valibot@3.19.0
  - @drzl/generator-arktype@3.16.0
  - @drzl/generator-typebox@0.13.0
  - @drzl/analyzer@1.20.1

## 4.21.0

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
  - @drzl/validation-core@3.20.0
  - @drzl/generator-orpc@2.8.1

## 4.20.0

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

- c3465cc: Generate for a subset of a table's columns, without post-processing the output.

  `include`/`exclude` is all or nothing per table, and the column that should not appear in a
  generated schema is usually sitting in a table you do want: a `passwordHash` on `users`, an internal
  note beside the public fields, a `tenantId` the server sets from the session. The only previous
  answer was to edit the emitted file, which the next `drzl generate` overwrites.

  ```ts
  columns: {
    users: { omit: ['passwordHash'] },
    'app_*': { omit: ['deleted_at'] },
    audit_log: { pick: ['id', 'action', 'created_at'] },
  },
  ```

  The key is a table pattern in the same language `include`/`exclude` already uses, sharing the same
  implementation rather than a second copy of it: the database table name, anchored, with `*` as the
  only metacharacter. Column patterns are that language again. Every matching entry applies in the
  order written, and within one entry `pick` narrows before `omit` removes, so `omit` wins, which is
  the precedence `exclude` already has over `include`.

  Four decisions worth knowing:

  - **It narrows the analysis, once, before any generator is constructed**, at the same seam
    `filterTables` already uses. Not in `@drzl/analyzer`, which reads a schema module and has no
    config: `drzl analyze` has to keep printing what is really there. And not in each generator, of
    which there are nine plus two template packages: the one that forgot would emit a schema silently
    wider than the config asked for. Narrowing the analysis is also what keeps the validators, the
    OpenAPI document, the emitted `.meta()` facts and the service layer describing the same columns,
    since all of them read that one object.

  - **A pattern that matches nothing is an error, not a no-op.** `omit: ['passwrodHash']` treated as a
    no-op leaves the column exactly where it was while reading like a fix, and nothing downstream can
    tell that apart from a column that was never there. A table pattern matching no table and a
    column pattern matching no column both stop the run before anything is written, with every such
    problem in one message. A column pattern has to match in at least one of the tables its entry
    matched, not in all of them, which is what makes a wildcard table key usable.

  - **Omitting a primary key column is refused.** The generated `getById`, `update` and `delete`
    address rows by that key and every generator reads it differently, so the consequence would
    depend on which generators happened to be configured: the tRPC generator resolves the key against
    the columns and silently drops those three procedures, the oRPC generator never reads the key and
    keeps emitting them typed `{ id: number }`, the service generator falls back to a column literally
    named `id` and emits `eq(users.id, id)`, and the OpenAPI document drops its `/{id}` paths. One
    config, four outcomes, none announced. Refusing is also the reversible direction: an error can be
    relaxed to a warning later without breaking a config that works.

  - **Omitting a NOT NULL column with no default is a warning, and generates.** It really does produce
    an insert schema that cannot describe a whole row, and it is also the normal multi-tenant shape: an
    insert schema describes a request body, not a row, and the server fills in the rest. The warning
    says who has to supply the column. A CHECK naming an omitted column warns too, since nothing DRZL
    emits can enforce it any more, though the database still does.

  There is deliberately no per-mode form: a column cannot be kept in `select` and dropped from
  `insert`. The service generator's `Update<Table>` is `Partial<Omit<typeof users.$inferInsert, 'id'>>`
  taken from Drizzle's own types rather than from the analysis, so a per-mode narrowing would be
  invisible in half the generated tree.

  The narrowing covers more than the column list, because a table names its columns again in
  `primaryKey`, `unique`, `indexes`, `foreignKeys` and `checks`. `unique` reaches emitted TypeScript
  verbatim through `findDuplicate<Table>`, so a stale name there is a generated file that does not
  compile; `unique`, `indexes` and `foreignKeys` are narrowed with the columns. `checks` deliberately
  is not: the generators already skip a row check naming a column the mode does not carry, and leaving
  it lets `meta` keep listing the constraint as unenforced, which is the true answer.

  Measured, because a schema that stops describing a column and a schema that stops carrying its value
  are different claims. Pushing a row that still holds the omitted column through the emitted select,
  insert and update schemas: zod 4.4.3, valibot 1.4.2 and Effect 3.22.1 strip the key; TypeBox 0.34.52
  strips it under `Value.Parse` and `Value.Clean` while `Value.Check` alone still returns `true`;
  arktype 2.2.3 leaves it in place; and the JSON Schema output emits `additionalProperties: false`, so
  a validator rejects the payload instead of trimming it. Those are the validators' own policies about
  undeclared keys, not something DRZL sets.

- f110f7b: TypeBox schemas can now back a tRPC or oRPC router.

  `{ kind: 'typebox', path: 'src/validators/typebox', standardSchema: true }` gives every emitted
  schema a `~standard` key, so `t.procedure.input(InsertusersSchema)` and
  `os.input(InsertusersSchema)` both typecheck, validate, and infer the real shape on the client.

  TypeBox was the one validator DRZL emits with no route to Standard Schema, which is the stated
  reason both router generators exclude it. Measured on `@sinclair/typebox` 0.34.52: a bare
  `Type.Object()` has own keys `type,required,properties` and no `~standard`, and the package exports
  nothing matching `/standard/i` from its root or from `value`. zod 4.4.3, valibot 1.4.2 and arktype
  2.2.3 all carry one already, so the option exists on this generator alone and is not passed to the
  others.

  Implemented against `@standard-schema/spec` v1 as published in 1.1.0: `version` fixed at the
  literal `1`, a `vendor` string, and a `validate` that returns a result rather than throwing, plus
  the optional `types` that carries the input and output types. `validate` is synchronous, which the
  spec permits and which keeps an input check off the microtask queue.

  Four decisions worth knowing:

  - **The key is attached to the schema, not exported beside it.** A TypeBox schema is a plain
    extensible object, so the wrapper is the same object and nothing is dropped. It is defined
    non-enumerably, so `JSON.stringify` still produces the same JSON Schema document byte for byte,
    `Object.keys` still lists only JSON Schema keywords, and `Value.Check`, `TypeCompiler` and
    `Static<typeof X>` all see what they saw before. This is the difference from the Effect
    generator, which must export a second `Standard<Name>` form because
    `Schema.standardSchemaV1` returns a different object that has dropped `.fields`.
  - **The vendor is `drzl/typebox`, not `typebox`.** DRZL implements this and TypeBox does not, so
    claiming TypeBox's name would mislead anything that special-cases a vendor and would collide
    with a first-party implementation whose issues are not shaped like these.
  - **The implementation is emitted, not imported.** One `standard-schema.ts` per output directory,
    exported from the barrel and imported by each table module. Generated code in DRZL has never
    depended on a `@drzl/*` package at runtime and this does not start; a new package could not
    publish by npm OIDC on its first version anyway, and a generated tree that cannot resolve an
    import is the worst place to find that out.
  - **Off by default**, like `duplicateFinder`, because generated code ships in your bundle.

  Also fixes a latent defect the option surfaced. The character and byte cap predicates guarded only
  against `null`, on the assumption that the `Type.String()` beside them in the intersection had
  already passed. `Value.Check` does stop an intersection at its first failing branch, so that held;
  `Value.Errors` does not, so building an issue list for `{ email: 123 }` reached `[...123]` and
  threw. A real tRPC route answered `v is not iterable` with a 400 instead of naming the type it
  wanted. The predicates now guard on `typeof`, as the three other predicates this generator emits
  already did, and the wrapper keeps whatever it collected if a predicate throws anyway. Null and
  undefined still pass the branch exactly as before. Costs 12 bytes per cap branch.

  A union reports one summary error in TypeBox and hangs the branch failures off it, so a nullable
  capped column produced `Expected union value` where the useful message was one level down. The
  wrapper reports the branch failures in place of the summary, and a constraint TypeBox can only
  state as a registered kind reports what the constraint says rather than `Expected kind
'DrzlRowCheck'`. Array indices in `path` are reported as numbers, matching zod, valibot and
  arktype, so code that switches on `typeof segment` behaves the same whichever generator wrote the
  schema.

  `validation.library` on the `orpc` and `trpc` generators still takes `zod`, `valibot` or
  `arktype`. Those generators invent arguments, such as a lookup by primary key, and have no TypeBox
  spelling for them; that is separate work from the Standard Schema gap this closes.

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

- Updated dependencies [4efd19b]
- Updated dependencies [f110f7b]
- Updated dependencies [7a46b64]
  - @drzl/validation-core@3.19.0
  - @drzl/generator-zod@3.19.0
  - @drzl/generator-valibot@3.18.0
  - @drzl/generator-arktype@3.15.0
  - @drzl/generator-typebox@0.12.0
  - @drzl/analyzer@1.19.0

## 4.19.0

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

### Patch Changes

- Updated dependencies [3b53229]
  - @drzl/validation-core@3.18.0

## 4.18.0

### Minor Changes

- 9ca760c: `drzl doctor`: a human-readable report of what DRZL **cannot** type or enforce in your schema, and
  what to do about each one.

  Not `drzl analyze`. That prints the whole `Analysis` as JSON and leaves the reader to know which
  fields mean trouble. `doctor` prints only what will silently not work, and both of its headline
  failure modes produce a generated file that exists, compiles and validates nothing: an untypeable
  column gets a validator accepting **any** value, and a CHECK constraint DRZL will not translate is
  simply absent from the output.

  ```
  DRZL doctor  src/db/schema.ts
  postgres, 1 table, 11 columns, 12 CHECK constraints

  Columns DRZL cannot type  (2)
    These get a validator that accepts any value.

    - Column "credit" on table "accounts" has no known type (SQL type numeric(12,2)), so its
      validator will accept any value.
      A customType has no runtime shape to read. Declare it with .$type<T>() and turn on
      typedColumns to give the validator the type.

  CHECK constraints DRZL does not enforce  (9)
    Your database still enforces these. Nothing DRZL generates does.

    - CHECK "age_or" on "accounts" is not translated: contains OR. Expression: age >= 18 OR age <= 65
  ```

  **The CHECK section reads something the analyzer does not know.** `parseCheck` lives in
  `@drzl/validation-core` and every validation generator calls it; the analyzer carries the raw
  expression through and has no opinion on it. So `Analysis.issues` cannot say "this constraint is in
  your schema and nothing DRZL emits enforces it", and until now nothing said it at all: `drzl
generate` prints a count of untypeable columns and is silent about constraints. Measured on a
  Postgres table carrying twelve CHECKs through all five generators, nine produced no enforcement in
  any of them and DRZL reported none of the nine.

  Three CHECK cases are distinguished, because their fixes differ: the parser declined the expression
  (with its own reason, `contains OR`, `right side is not a literal`); the expression names a column
  the table does not have; the expression compares an array or structured column against a scalar
  literal. A constraint DRZL **does** translate is not listed, so the ones that matter are not buried.

  Also reported: a table with no primary key, and a composite primary key. The service generator keys
  `getById`, `update` and `delete` on `primaryKey.columns[0] ?? 'id'`, so a table with neither a key
  nor an `id` column emits a service that does not compile (measured: three `TS2339` errors under
  `tsc --strict`), and a composite key emits one matching on part of the key.

  **Exit `0` by default, even with findings.** A schema carrying a `customType`, or a CHECK this
  parser will not guess at, is normal and usable, and a doctor that failed every pipeline reading one
  would be switched off within a week. `--strict` exits `2` when anything is reported, and `1` is
  reserved for the case where the schema could not be read at all. `--json` emits the report with a
  stable `kind` per finding, so CI can count one category without matching on prose.

  Analyzer changes that go with it:

  - **`Issue.path` is now set.** It has been declared since the interface existed and set by nothing,
    so a consumer wanting to group warnings by table had to read the names back out of the English in
    `message`. `DRZL_ANL_UNKNOWN_COLUMN` carries `table.column`; `DRZL_ANL_EXTRACONFIG`,
    `DRZL_ANL_RELATIONS`, `DRZL_ANL_REL_V2` and `DRZL_ANL_TABLE` carry the table.
  - **A Gel temporal column gets its own hint.** The six `cal::`/duration columns are left `unknown`
    on purpose: the value is an instance of a class from the `gel` package, which DRZL cannot import,
    so no generator could emit a check for it even knowing the name. They used to carry the generic
    "open an issue naming the column type so it can be modelled", which sends their author to file an
    issue the arm already answers. `customType` and genuinely unmodelled columns keep their own
    wording.

### Patch Changes

- Updated dependencies [9ca760c]
  - @drzl/analyzer@1.18.0

## 4.17.0

### Minor Changes

- b1405a9: Emit a whole OpenAPI document, not just `components.schemas`. `document: true` on the `json-schema`
  generator writes `openapi.ts` (and/or `openapi.json`) with a path per table, the verbs on each, the
  request and response body per verb, and the component schemas embedded so the file stands alone.

  **The path parameter is the table's real primary key, never an invented `id`.** Every column of it,
  at its real type, so a uuid key is `/sessions/{token}` with `{ type: 'string', format: 'uuid' }` and
  a composite key is `/org_members/{orgId}/{userId}`. A table with no primary key keeps `GET` and
  `POST` on its collection and loses the by-id paths rather than gaining a fictional column. This
  follows `@drzl/generator-trpc`, which reads the key, rather than `@drzl/generator-orpc`, which emits
  `z.object({ id: z.number() })` whatever the key is. The case is stronger in a document than in a
  router: a tRPC client is typechecked against the router it calls, so a wrong `id` is caught at build
  time, while an OpenAPI document is read by code generators in other languages that have nothing to
  check it against.

  `POST` answers `201`, `DELETE` answers `204` with no body (returning the deleted row is not a true
  statement on every dialect DRZL supports: `RETURNING` is Postgres and SQLite, and MySQL has no such
  clause), by-id paths answer `404`, and anything that takes a body or a path parameter answers `400`
  when the schema refuses it, movable to `422` with `document: { validationStatus: 422 }`. `409` is
  emitted where a primary key or unique constraint can collide, with the constraint named in the
  description, because uniqueness is the one thing a per-row schema structurally cannot state.

  `servers` is absent unless supplied, which the specification reads as a single server at `/`; a
  placeholder host would be a fabrication that tooling then follows. `includeRelations: true` adds a
  read-only `GET /users/{id}/posts` where a child has exactly one foreign key to the whole of a
  parent's primary key.

  **Fixes two keywords the `openapi-3.0` target emitted that OpenAPI 3.0 does not have.** A pinned
  value was `const` and base64 bytes were `contentEncoding: 'base64'`; 3.0 has neither, and its Schema
  Object is closed (`additionalProperties: false`, plus `^x-`), so unlike plain JSON Schema where an
  unknown keyword is merely ignored, either one made a whole 3.0 document fail validation. They are
  now `enum: ['gold']` and `format: 'byte'`, which say the same things in that dialect. Both were
  found by running the emitted document through `@seriousme/openapi-schema-validator` against the
  official OpenAPI schemas, and neither was visible from reading the output. Only
  `target: 'openapi-3.0'` output changes; the default `draft-2020-12` and `openapi-3.1` are
  byte-for-byte unchanged.

  The CLI's `json-schema` branch now goes through one shared options builder for both `generate` and
  `watch`, so the two dispatch loops cannot drift on what this generator is given, and a test runs
  both commands over a config that sets every document field to something no default produces and
  compares the bytes.

## 4.16.0

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

### Patch Changes

- Updated dependencies [22f4cb7]
  - @drzl/validation-core@3.17.0
  - @drzl/generator-zod@3.18.0
  - @drzl/generator-valibot@3.17.0
  - @drzl/generator-arktype@3.14.0
  - @drzl/generator-typebox@0.11.0

## 4.15.0

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

## 4.14.4

### Patch Changes

- 55d1c31: A generator that fails is reported as what went wrong, not as a missing package.

  Every generator branch in the CLI except oRPC's wrapped `generate()` in a catch of one shape, so any
  error at all came back as, for example, `Zod generator missing. Install with: npm install
@drzl/generator-zod`. The real reason was demoted to a trailing detail line, and the headline named a
  package you already had installed. Ten places.

  A module that cannot be resolved and a module that threw while running are now told apart, so a
  genuinely absent optional generator still gets the install hint it is for, and a generator that
  failed reports its own error.

- Updated dependencies [55d1c31]
  - @drzl/validation-core@3.16.1

## 4.14.3

### Patch Changes

- Updated dependencies [734defc]
- Updated dependencies [b14cbed]
- Updated dependencies [8cc4de8]
- Updated dependencies [f019b03]
  - @drzl/generator-arktype@3.13.0
  - @drzl/validation-core@3.16.0
  - @drzl/analyzer@1.18.0
  - @drzl/generator-zod@3.17.0
  - @drzl/generator-valibot@3.16.0
  - @drzl/generator-typebox@0.10.0
  - @drzl/generator-service@2.4.0
  - @drzl/generator-orpc@2.8.0

## 4.14.2

### Patch Changes

- abd7b0c: `drzl --version` and `drzl -V` report the version you actually installed.

  Both printed `0.0.1` on every release the CLI has ever had. The registry lists 29 versions of
  `@drzl/cli` and 28 of them were wrong, so every version number in every bug report filed against
  this CLI has been `0.0.1` and none of them identified anything.

  **Where it came from.** `program.version('0.0.1')` in `src/cli.ts`, a literal written when the CLI
  was scaffolded. It was accurate for the first publish and for nothing after it. There was no
  manifest lookup to go wrong and no bundling involved: the number was simply typed into the source
  and left there while `package.json` moved on to `4.14.1`.

  **What it does now.** The version comes from the `version` field of the package's own
  `package.json`, read at startup from beside the running build. That file is the one the registry
  took the version from, so the two cannot disagree, including for anyone running a build from a
  branch or a tarball.

  Nothing falls back. If the manifest is missing, belongs to another package, or has no `version`,
  the CLI throws and names the path it looked at, because a placeholder standing in for a failed
  lookup is exactly what made this defect survive 28 releases.

  **Verified from an installed tarball**, not from the source tree: `pnpm pack`, `npm install` of the
  resulting `.tgz` into an empty directory, then the installed `drzl` binary, which prints `4.14.1`
  for `--version` and for `-V`. The published `@drzl/cli@4.14.1` prints `0.0.1` for both.

  The bin test in `packages/cli/test/every-entry-loads.spec.ts` ran the built binary throughout and
  asserted only that it printed something, which `0.0.1` did. It now asserts equality with the
  manifest, for `--version` and `-V`, from the ESM and CommonJS builds alike.

  One build change comes with this. `src/version.ts` locates the manifest through `import.meta.url`,
  which esbuild rewrites to `undefined` in a CommonJS output while warning `empty-import-meta`. The
  new `packages/cli/tsup.config.ts` gives the CommonJS build a real value for it, derived from
  `__filename`, rather than silencing the warning: that is the same shape as the
  `createRequire(import.meta.url)` defect in `@drzl/validation-core`, and leaving it silenced would
  have left the next unguarded use in this package resolving to `undefined` with nothing printed to
  say so. The banner repeats `"use strict"` so that the CommonJS bundles stay in strict mode.

## 4.14.1

### Patch Changes

- Updated dependencies [6fbdb22]
  - @drzl/analyzer@1.15.0
  - @drzl/generator-zod@3.16.0
  - @drzl/generator-valibot@3.15.0
  - @drzl/generator-arktype@3.12.0
  - @drzl/generator-typebox@0.9.0
  - @drzl/generator-orpc@2.7.0
  - @drzl/generator-service@2.3.0

## 4.14.0

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

- 9254a9c: Emit an OpenAPI `components.schemas` document

  `{ kind: 'json-schema', components: true }` also writes `components.ts`, one object keyed by name
  and ready to spread into an OpenAPI document. Assembling that from per-table modules is the step
  everyone repeats.

  Two details it handles. `$schema` is dropped, because a schema nested under `components.schemas`
  inherits the document's dialect and OpenAPI 3.1 reads a per-schema `$schema` as a dialect switch.
  `$id` is dropped rather than rewritten: setting it to `#/components/schemas/<name>` is the obvious
  first attempt and is invalid, since a draft 2020-12 `$id` may not contain a fragment. The map key
  is the identity.

  Also fixes a bug in the select schema found while testing this: a column with a database default
  was marked optional in every mode, so `id` was optional on a select schema, which describes a row
  that cannot exist. Only insert treats a defaulted column as omissible.

  Off by default.

### Patch Changes

- Updated dependencies [fbc0881]
- Updated dependencies [5578e93]
  - @drzl/analyzer@1.14.0
  - @drzl/validation-core@3.14.0
  - @drzl/generator-zod@3.15.0
  - @drzl/generator-valibot@3.14.0
  - @drzl/generator-arktype@3.10.0
  - @drzl/generator-typebox@0.8.0

## 4.13.1

### Patch Changes

- 98592df: Make `@drzl/generator-json-schema` an optional dependency, so the CLI installs again

  `@drzl/cli@4.13.0` shipped with a hard dependency on `@drzl/generator-json-schema@^0.2.0`, and
  that package failed to publish in the same release, so `npm install @drzl/cli` failed outright
  with a 404 for everyone.

  The publish failed because npm's trusted publishing has nothing to authenticate against for a
  package name that has never existed: `E404 PUT /@drzl%2fgenerator-json-schema`. The account
  disallows tokens, so the first version of any new package has to be published interactively before
  CI can take it over. That is a one-time step and it had not been done.

  An optional dependency that cannot be resolved is skipped rather than failing the install, so the
  CLI installs and works as it did before, and the JSON Schema generator is picked up automatically
  once it is on the registry. It is also the more honest declaration: the CLI imports every
  generator dynamically and already reports a missing one with an install hint.

## 4.13.0

### Minor Changes

- dc13c47: Add a JSON Schema and OpenAPI generator, and fix two analyzer gaps it uncovered on drizzle-orm 0.4x

  `{ kind: 'json-schema' }` emits plain JSON Schema per table, with no runtime dependency at all.
  The other four generators each target one validation library, so the output only helps a
  TypeScript program that installs that library. JSON Schema is what OpenAPI documents, API
  gateways, form builders and validators in other languages already read, and nothing in the
  official Drizzle family emits it.

  `target` picks the dialect: `draft-2020-12` (default), `openapi-3.1`, or `openapi-3.0`. The last
  is genuinely different rather than older, spelling nullable as `nullable: true` and an exclusive
  bound as a boolean beside the bound. Since JSON Schema ignores unknown keywords rather than
  rejecting them, emitting the wrong dialect gives a document that validates and then accepts what
  the constraint exists to reject.

  Running the new generator through the real CLI surfaced two analyzer bugs affecting **every**
  generator on drizzle-orm 0.4x, the version the analyzer depends on:

  - **`.array()` columns came back `unknown`.** 0.4x wraps the column in a `PgArray` whose
    `baseColumn` is the element; v1 leaves the class alone and raises `dimensions`. Only the v1
    signal was read.
  - **`pgEnum` columns came back `unknown`, on both majors.** The class map had no arm for
    `PgEnumColumn` and `describeV1Column` does not read `dataType: 'string enum'` either. The
    emitted schemas were still correct, because every generator reads `enumValues` ahead of
    `tsType`, so this one was a gap in the analysis model rather than a validation hole.

  The array bug did produce schemas that accepted anything, in all five generators, with nothing
  reporting a problem. `verify-packed.sh` pins `drizzle-orm@1.0.0-rc.4`, so the whole verification
  ladder only ever ran on one major; it now runs a stage against 0.4x that fails on any column the
  analyzer cannot name. That stage found the enum gap the first time it ran.

- 698e7b3: One options builder for every validation generator, and a default that was being dropped.

  Each of the four generator branches in the CLI hand-built its own options object. Three documented
  options had already been found silently dead that way: `typedJson` never reached typebox, and
  `coerceDates` and `applyDefaults` never reached anything but zod. Fixing each instance did not
  address the shape of the problem, so the four now share one builder and an option added once
  reaches everything that can act on it.

  What stays per-generator is a real capability rather than an oversight, and it is named as one:
  ArkType does not receive the schema-import options, because it emits one string per field and a
  TypeScript type reference has nowhere to live inside a string DSL.

  ### The default that was being dropped

  Auditing the result immediately turned up another: with `typedColumns` **and** `applyDefaults`
  both on, the typebox generator emitted no default at all.

  ```ts
  // before
  country: Type.Optional(Type.Unsafe<(typeof users.$inferInsert)['country']>(Type.String())),
  // after
  country: Type.Optional(Type.Unsafe<(typeof users.$inferInsert)['country']>(Type.String({ default: 'GB' }))),
  ```

  The default was being applied after the `Type.Unsafe` wrapper, where it lands on the wrapper
  rather than the schema, and the helper that attaches it declines anything that is not a bare
  `Type.X(...)`. So it returned the expression untouched and the default vanished without a word.
  It now goes on the schema before anything wraps it.

  Neither option is on by default, so this only affects a project that had turned both on.

- c29891a: Warn when a column gets a validator that accepts anything

  `tsType: 'unknown'` is the exact shape two real bugs took: `.array()` and `pgEnum` columns came
  back untyped on drizzle-orm 0.4x, every generator emitted a validator accepting any value, and
  nothing anywhere said so. The only way to find out was to read the generated file.

  `verify-packed.sh` now fails on it, which protects this repository and does nothing for a user
  whose schema uses a column type DRZL has not modelled. That is the case where it matters most,
  because their validators are silently open and nobody has told them.

  The analyzer now reports `DRZL_ANL_UNKNOWN_COLUMN` per column, and the CLI prints a summary after
  analysis, naming the column and its SQL type. It stays a warning: the rest of the schema still
  generates and the generated code is still useful.

  The condition is "the emitted validator will be wide", not "the type is unknown". A `json` column
  is also untyped and is not wide, since the generators emit the JSON value space for it. A
  `customType` is wide, and gets a hint pointing at `.$type<T>()` with `typedColumns`, which is the
  documented fix.

### Patch Changes

- Updated dependencies [19dfa3b]
- Updated dependencies [78aeca2]
- Updated dependencies [43c32de]
- Updated dependencies [03f7810]
- Updated dependencies [dc13c47]
- Updated dependencies [3e15ea8]
- Updated dependencies [b274391]
- Updated dependencies [698e7b3]
- Updated dependencies [c29891a]
  - @drzl/generator-arktype@3.9.0
  - @drzl/generator-typebox@0.7.0
  - @drzl/analyzer@1.13.0
  - @drzl/generator-zod@3.14.1
  - @drzl/generator-valibot@3.13.0
  - @drzl/generator-json-schema@0.2.0

## 4.12.0

### Minor Changes

- 96a36d8: `typedColumns` for the valibot generator.

  It shipped for zod and TypeBox. Valibot had no schema-import machinery at all, so this adds it
  along with the narrowing itself.

  ```ts
  role: v.pipe(v.string(), v.transform((x) => x as (typeof users.$inferSelect)['role'])),
  ```

  Valibot has no equivalent of TypeBox's `Type.Unsafe`, so the reference is appended as an identity
  transform: the value passes through unchanged and only `InferOutput` sees the narrower type. Every
  action the schema carried still runs, which the tests assert by parsing values through it rather
  than by reading the emitted text, and the transform is appended after the nullable and optional
  wrappers so neither is disturbed.

  Verified end to end through the CLI: a `text().$type<'admin' | 'member'>()` column produces output
  where assigning `'nope'` is a compile error and `'admin'` is not.

  That leaves ArkType as the one generator without it, and it is not an oversight: it emits one
  string per field, and a TypeScript type reference has nowhere to live inside a string DSL.

### Patch Changes

- Updated dependencies [96a36d8]
  - @drzl/generator-valibot@3.12.0

## 4.11.0

### Minor Changes

- c99ac3d: `applyDefaults` for every generator, `typedColumns` for TypeBox, and three options that silently
  did nothing.

  ### `applyDefaults` everywhere

  It shipped for zod only. Each library states a default in its own way, and all four now do:

  ```ts
  country: z.string().default("GB"),                        // zod
  country: v.optional(v.string(), "GB"),                    // valibot
  country: 'string = "GB"',                                 // arktype
  country: Type.Optional(Type.String({ default: "GB" })),   // typebox
  ```

  All four parse `{ name: 'x' }` into `{ name: 'x', country: 'GB', count: 0, flag: true }`, which is
  the row Postgres writes for the same insert. Checked by running the emitted modules rather than by
  reading them.

  One difference worth knowing: TypeBox's `Value.Check` does **not** materialise a default, only
  `Value.Parse` and `Value.Default` do. It separates validating from defaulting where zod and valibot
  fold the two together.

  ### `typedColumns` for TypeBox

  `Type.Unsafe<T>(schema)` wraps an existing schema, so every check it carries still runs and only
  the inferred type is replaced:

  ```ts
  role: Type.Unsafe<(typeof users.$inferSelect)['role']>(Type.String({ maxLength: 50 })),
  ```

  That leaves ArkType as the one generator that cannot do this, and it is not an oversight: it emits
  one string per field, and a TypeScript type reference has nowhere to live inside a string DSL.

  ### Three documented options that did nothing

  Found while wiring the above, each confirmed by generating and reading the output rather than by
  inspecting the code:

  - **`typedJson` on a `typebox` generator was ignored.** The CLI never passed it, so a json column
    emitted the generic `DrzlJsonValue` no matter what the config said.
  - **`coerceDates` was ignored by every generator.** It was documented on the zod generator, but the
    config schema had no such key, so `coerceDates: 'none'` parsed and was dropped. The output kept
    coercing.
  - **`applyDefaults` reached only zod**, for the same reason, until the other three branches were
    given it.

  Each generator branch in the CLI built its own options object by hand, so an option added to one
  was simply absent from the others. All four now pass everything they support.

### Patch Changes

- Updated dependencies [c99ac3d]
  - @drzl/generator-arktype@3.8.0
  - @drzl/generator-valibot@3.8.0
  - @drzl/generator-typebox@0.6.0
  - @drzl/generator-zod@3.10.0

## 4.10.0

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
  - @drzl/validation-core@3.10.0
  - @drzl/generator-zod@3.9.0
  - @drzl/analyzer@1.11.0

## 4.9.0

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
  - @drzl/generator-arktype@3.7.0
  - @drzl/generator-valibot@3.7.0
  - @drzl/validation-core@3.9.0
  - @drzl/generator-zod@3.8.0
  - @drzl/analyzer@1.10.0

## 4.8.0

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

### Patch Changes

- Updated dependencies [d557658]
  - @drzl/generator-arktype@3.6.0
  - @drzl/generator-valibot@3.6.0
  - @drzl/generator-typebox@0.5.0
  - @drzl/validation-core@3.8.0
  - @drzl/generator-zod@3.7.0

## 4.7.0

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
  - @drzl/generator-arktype@3.5.0
  - @drzl/generator-valibot@3.5.0
  - @drzl/generator-typebox@0.4.0
  - @drzl/validation-core@3.7.0
  - @drzl/generator-zod@3.6.0
  - @drzl/analyzer@1.9.0

## 4.6.0

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

### Patch Changes

- Updated dependencies [c3b978f]
  - @drzl/validation-core@3.6.0
  - @drzl/generator-zod@3.5.0

## 4.5.0

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
  - @drzl/generator-arktype@3.4.0
  - @drzl/generator-valibot@3.4.0
  - @drzl/generator-typebox@0.3.0
  - @drzl/generator-orpc@2.5.0
  - @drzl/validation-core@3.5.0
  - @drzl/generator-zod@3.4.0
  - @drzl/analyzer@1.8.0

## 4.4.0

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
  - @drzl/generator-arktype@3.3.0
  - @drzl/generator-valibot@3.3.0
  - @drzl/generator-typebox@0.2.0
  - @drzl/validation-core@3.4.0
  - @drzl/generator-zod@3.3.0
  - @drzl/analyzer@1.7.0

## 4.3.0

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

### Patch Changes

- Updated dependencies [5a99384]
  - @drzl/generator-typebox@0.1.0
  - @drzl/validation-core@3.3.0

## 4.2.0

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

### Patch Changes

- Updated dependencies [d2ac66d]
  - @drzl/generator-zod@3.2.0
  - @drzl/validation-core@3.2.0

## 4.1.0

### Minor Changes

- 6d6857f: **The analyzer no longer reports an unknown dialect as SQLite.** It did, with no diagnostic at
  all. Unrecognised columns returned `dbType: 'UNKNOWN'`, the `/At$/` heuristic then rewrote
  `createdAt` to `INTEGER`, and that fabricated INTEGER satisfied a "does anything look like a
  SQLite storage class" fallback. Verified before the fix:

      { "dialect": "sqlite", "issues": 0, "cols": ["id=UNKNOWN", "createdAt=INTEGER"] }

  Detection is keyed off `Symbol.for('drizzle:entityKind')` now, the static Drizzle stamps on every
  column class and uses internally for this. `constructor.name` remains only as a fallback, because
  it does not survive minification: a bundled schema presents its columns as `a`, `b`, `c`.

  `mssql` and `cockroach` are recognised, both added in Drizzle v1. Where nothing matches the
  result is `unknown` plus a `DRZL_ANL_DIALECT` warning, rather than a confident wrong answer.

  **Tables can now be filtered**, with top-level `include` and `exclude`:

  ```ts
  export default defineConfig({
    schema: 'src/db/schema.ts',
    exclude: ['session', 'account', 'verification', '__drizzle_*'],
    generators: [{ kind: 'orpc' }],
  });
  ```

  There was no way to say this, and every generator loops over every table it finds, so DRZL
  emitted unauthenticated CRUD over whatever shared the schema file. For a migrations table that is
  noise. For an auth table it is a leak: Better Auth puts `user`, `session`, `account` and
  `verification` alongside your own, and `account` holds `accessToken`, `refreshToken`, `idToken`
  and `password`.

  Matching is anchored, on the database table name, with `*` as the only metacharacter, so
  `exclude: ['user']` does not also drop `users`. `exclude` wins over `include`.

  Deliberately explicit rather than detecting any particular library. Better Auth's model names are
  all overridable, so a built-in list would miss a renamed table and, worse, silently skip an
  ordinary table called `user`, which is usually the application's own primary entity.

### Patch Changes

- Updated dependencies [c90fd42]
- Updated dependencies [6d6857f]
- Updated dependencies [6d6857f]
  - @drzl/validation-core@3.1.0
  - @drzl/generator-zod@3.1.0
  - @drzl/analyzer@1.6.0
  - @drzl/generator-valibot@3.1.0
  - @drzl/generator-arktype@3.1.0
  - @drzl/generator-orpc@2.4.1

## 4.0.0

### Major Changes

- 4021e52: Dependencies updated to their latest stable releases.

  **Breaking for `@drzl/cli`: Node 22 or newer is now required.** It declared `>=18.17.0`, which had
  become untrue: chalk 6 requires `>=22` and chokidar 5 requires `>=20.19`, so installing on Node 18
  produced a package whose own dependencies could not run. The other packages keep the lower floor,
  since none of them pull those in and raising it would exclude consumers for no reason.

  Runtime dependencies: chokidar 4 to 5 (now ESM only), chalk 5 to 6, ora 8 to 9, commander 14 to
  15, zod 4.1 to 4.4, jiti 2.5 to 2.7.

  Tooling: vitest 3 to 4, eslint 9 to 10, typescript-eslint 8.42 to 8.65, tsup, prettier,
  @changesets/cli, @types/node, sharp. GitHub Actions bumped to checkout v7, setup-node v7,
  configure-pages v6, deploy-pages v5, upload-pages-artifact v5.

  ESLint 10 no longer supports `/* eslint-env */`, and it surfaced a `.eslintrc.cjs` and
  `.eslintignore` that had been dead since the flat config was added: ESLint was reading
  `eslint.config.js` and linting the stale `.eslintrc.cjs` as an ordinary source file. Both are
  removed, `--ext .ts` is dropped from the lint script since flat config does not accept it, and the
  flat config is renamed to `eslint.config.mjs` so Node stops reparsing it.

  **TypeScript stays on 5.9.** 7.0 is the current `latest`, but it is the native rewrite: it exposes
  no `main`, publishes its API under `./unstable/*` subpaths, and `ts.ModuleKind` is simply absent,
  so the compiler-API assertions in this repo do not resolve. 6.0 fails too, in tsup's `--dts` step,
  which errors on a deprecated `baseUrl` it sets itself and cannot resolve Node's types. Neither is
  a defect in this repo and neither is fixable here, so the bump waits for tsup to support them.

### Patch Changes

- Updated dependencies [4021e52]
  - @drzl/analyzer@1.5.2

## 3.0.0

### Major Changes

- 114b91d: **`drzl watch` never regenerated.** It has been inert since the chokidar v4 upgrade: it did one
  build on startup and then sat there, no matter how many times the schema was saved.

  Chokidar removed glob support in v4 (September 2024). The watcher was handed
  `<schema dir>/**/*.{ts,tsx,js}` and, in v4, that is a literal path, so it watched a directory
  called `**` which does not exist. No event ever fired. The startup build is what made this look
  like it worked: run `drzl watch`, see files appear, assume the watcher is live.

  Watch targets are the schema's directory now, which chokidar recurses into by itself, and the
  extension filtering the glob used to do happens on the event instead, so an unrelated file next
  to the schema does not trigger a rebuild.

  Marked breaking because a project relying on `watch` has been silently running against stale
  output, and the command now genuinely reruns.

  ### Also, in the analyzer

  Analyzing the same path twice returned the first parse. The schema is loaded through jiti, which
  delegates to `require` and keeps a process-global module cache, so re-analysis in a long-lived
  process never saw the file as it now is. Constructing a fresh analyzer per run did not help; the
  cache is not the instance's. It passes `moduleCache: false` now.

  This has no effect on a one-shot `generate`, which analyzes once and exits. It matters for
  `watch`, and it would have made the fix above produce confidently stale output rather than no
  output at all, which is worse.

### Patch Changes

- Updated dependencies [ebf3da7]
- Updated dependencies [114b91d]
  - @drzl/generator-orpc@2.4.0
  - @drzl/analyzer@1.5.1

## 2.0.2

### Patch Changes

- Updated dependencies [b0543a4]
  - @drzl/validation-core@3.0.0
  - @drzl/generator-zod@3.0.0
  - @drzl/generator-valibot@3.0.0
  - @drzl/generator-arktype@3.0.0
  - @drzl/analyzer@1.5.0
  - @drzl/generator-orpc@2.3.2
  - @drzl/generator-service@2.1.2

## 2.0.1

### Patch Changes

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

- Updated dependencies [839cd23]
  - @drzl/generator-orpc@2.2.0

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

- Updated dependencies [2f9214e]
- Updated dependencies [6034a24]
- Updated dependencies [6903012]
- Updated dependencies [549ee51]
- Updated dependencies [20a5b9d]
  - @drzl/validation-core@2.0.0
  - @drzl/generator-zod@2.0.0
  - @drzl/generator-valibot@2.0.0
  - @drzl/generator-arktype@2.0.0
  - @drzl/generator-orpc@2.0.0
  - @drzl/generator-service@2.0.0
  - @drzl/analyzer@1.3.0

## 1.1.0

### Minor Changes

- c48d79a: sponsor initiatives

### Patch Changes

- Updated dependencies [c48d79a]
  - @drzl/generator-arktype@1.2.0
  - @drzl/generator-service@1.1.0
  - @drzl/generator-valibot@1.1.0
  - @drzl/generator-orpc@1.1.0
  - @drzl/generator-zod@1.1.0
  - @drzl/analyzer@1.2.0

## 1.0.0

### Major Changes

- 5da6f6b: support MySQL, SingleStore, and Gel; expand Postgres/SQLite; add tests (fixes #13)

### Patch Changes

- Updated dependencies [5da6f6b]
  - @drzl/analyzer@1.0.0
  - @drzl/generator-arktype@1.0.0
  - @drzl/generator-orpc@1.0.0
  - @drzl/generator-service@1.0.0
  - @drzl/generator-valibot@1.0.0
  - @drzl/generator-zod@1.0.0

## 0.3.1

### Patch Changes

- Updated dependencies [811dd61]
  - @drzl/generator-service@0.4.0
  - @drzl/generator-orpc@0.4.0

## 0.3.0

### Minor Changes

- b2b8e35: fix(cli-config): improve watch and config loading

### Patch Changes

- @drzl/analyzer@0.3.0
- @drzl/generator-arktype@0.3.0
- @drzl/generator-orpc@0.3.0
- @drzl/generator-service@0.3.0
- @drzl/generator-valibot@0.3.0
- @drzl/generator-zod@0.3.0

## 0.2.0

### Minor Changes

- f007329: fix(cli): correct config types and update readme

### Patch Changes

- @drzl/analyzer@0.2.0
- @drzl/generator-arktype@0.2.0
- @drzl/generator-orpc@0.2.0
- @drzl/generator-service@0.2.0
- @drzl/generator-valibot@0.2.0
- @drzl/generator-zod@0.2.0

## 0.1.0

### Minor Changes

- 250f5fd: Ensure @drzl/cli builds and exports its config module so consumers can import it directly.

### Patch Changes

- @drzl/analyzer@0.1.0
- @drzl/generator-arktype@0.1.0
- @drzl/generator-orpc@0.1.0
- @drzl/generator-service@0.1.0
- @drzl/generator-valibot@0.1.0
- @drzl/generator-zod@0.1.0

## 0.0.3

### Patch Changes

- 4227090: Fix missing generator dependencies and improve error messages
  - Add all generator packages (@drzl/generator-zod, @drzl/generator-service, @drzl/generator-valibot, @drzl/generator-arktype) as dependencies in CLI package.json
  - Update error handling to provide clearer installation instructions when generators are missing
  - Separate error details for better readability

  This resolves the "Cannot find package" errors when using generators other than ORPC.
  - @drzl/analyzer@0.0.3
  - @drzl/generator-arktype@0.0.3
  - @drzl/generator-orpc@0.0.3
  - @drzl/generator-service@0.0.3
  - @drzl/generator-valibot@0.0.3
  - @drzl/generator-zod@0.0.3

## 0.0.2

### Patch Changes

- Fix missing generator dependencies and improve error messages
  - Add all generator packages (@drzl/generator-zod, @drzl/generator-service, @drzl/generator-valibot, @drzl/generator-arktype) as dependencies in CLI package.json
  - Update error handling to provide clearer installation instructions when generators are missing
  - Separate error details for better readability

  This resolves the "Cannot find package" errors when using generators other than ORPC.
  - @drzl/analyzer@0.0.2
  - @drzl/generator-arktype@0.0.2
  - @drzl/generator-orpc@0.0.2
  - @drzl/generator-service@0.0.2
  - @drzl/generator-valibot@0.0.2
  - @drzl/generator-zod@0.0.2

## 0.0.1

### Patch Changes

- 6130ad2: Initial public release setup: lockstep versioning, CI publish, and branding.
  - @drzl/analyzer@0.0.1
  - @drzl/generator-orpc@0.0.1
