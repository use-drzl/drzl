# @drzl/cli

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
