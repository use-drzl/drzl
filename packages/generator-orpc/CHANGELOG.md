# @drzl/generator-orpc

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
