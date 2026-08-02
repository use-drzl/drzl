# @drzl/generator-arktype

## 3.4.0

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

## 3.3.0

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
  - @drzl/validation-core@3.4.0
  - @drzl/analyzer@1.7.0

## 3.2.0

### Minor Changes

- ac4d6ff: CHECK constraints are now enforced by the Valibot and ArkType generators too, matching what the
  Zod generator gained in the previous release. No official Drizzle validator module enforces them
  in any library.

  **Valibot** adds them as pipeline actions:

  ```ts
  age: v.pipe(v.number(), v.integer(), v.minValue(-2147483648), v.maxValue(2147483647),
              v.check((val) => val >= 18, "age_adult: age >= 18")),
  ```

  **ArkType** folds them into the type expression instead, which is the better result rather than a
  workaround: one statement about the type, not a bound plus an opaque predicate.

  ```ts
  age:   "18 <= number <= 2147483647",   // CHECK (age >= 18) narrowing a smallint
  score: "(0 <= number <= 100 | null)",  // CHECK (score BETWEEN 0 AND 100)
  tier:  "'gold'",                       // CHECK (tier = 'gold')
  ```

  An exclusive comparison stays exclusive, so `CHECK (n > 0)` yields `0 < number`. An equality on a
  string becomes a literal type.

  Both use the same `parseCheck` from `@drzl/validation-core`, so all three generators refuse
  exactly the same things: cross-column comparisons, compound predicates, function calls and regex
  matches are skipped rather than guessed at. And both place the constraint on the inner schema so
  nullability wraps it, reproducing SQL's rule that a CHECK passes on TRUE or NULL.

  Every ArkType form emitted here is executed against arktype itself in the test suite, parsing a
  valid value and rejecting an invalid one. An expression ArkType cannot parse throws on import and
  takes the importing module with it, so "it looks right" is not a sufficient check.

## 3.1.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [c90fd42]
- Updated dependencies [6d6857f]
- Updated dependencies [6d6857f]
  - @drzl/validation-core@3.1.0
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
  - @drzl/validation-core@3.0.0
  - @drzl/analyzer@1.5.0

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

- Updated dependencies [2f9214e]
- Updated dependencies [6034a24]
- Updated dependencies [6903012]
- Updated dependencies [549ee51]
  - @drzl/validation-core@2.0.0
  - @drzl/analyzer@1.3.0

## 1.2.0

### Minor Changes

- c48d79a: sponsor initiatives

### Patch Changes

- Updated dependencies [c48d79a]
  - @drzl/validation-core@1.1.0
  - @drzl/analyzer@1.2.0

## 1.1.0

### Minor Changes

- 2ca4b77: Fix ArkType generator emitting double-wrapped enum strings; pgEnum unions now render with JSON-escaped literals so `drzl generate` succeeds even when

### Patch Changes

- Updated dependencies [2ca4b77]
  - @drzl/analyzer@1.1.0

## 1.0.0

### Major Changes

- 5da6f6b: support MySQL, SingleStore, and Gel; expand Postgres/SQLite; add tests (fixes #13)

### Patch Changes

- Updated dependencies [5da6f6b]
  - @drzl/analyzer@1.0.0
  - @drzl/validation-core@1.0.0

## 0.3.0

### Patch Changes

- @drzl/analyzer@0.3.0
- @drzl/validation-core@0.3.0

## 0.2.0

### Patch Changes

- @drzl/analyzer@0.2.0
- @drzl/validation-core@0.2.0

## 0.1.0

### Patch Changes

- @drzl/analyzer@0.1.0
- @drzl/validation-core@0.1.0

## 0.0.3

### Patch Changes

- @drzl/analyzer@0.0.3
- @drzl/validation-core@0.0.3

## 0.0.2

### Patch Changes

- @drzl/analyzer@0.0.2
- @drzl/validation-core@0.0.2

## 0.0.1

### Patch Changes

- @drzl/analyzer@0.0.1
- @drzl/validation-core@0.0.1
