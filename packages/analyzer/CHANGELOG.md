# @drzl/analyzer

## 1.8.0

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

## 1.7.0

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

## 1.6.0

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

## 1.5.2

### Patch Changes

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

## 1.5.1

### Patch Changes

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

## 1.5.0

### Minor Changes

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

## 1.4.0

### Minor Changes

- 53a72d2: Foreign keys, relations, indexes, composite primary keys and check constraints are now actually
  detected. Every one of them silently came back empty before, on current stable Drizzle.

  `analyze --relations` and `includeRelations` are documented features that returned `relations: []`
  for every schema, and `Column.references` was always `undefined`. Four independent causes:
  - **Foreign keys were read from `col.references`**, which does not exist on a Drizzle column.
    The real data lives per dialect under `drizzle:PgInlineForeignKeys`,
    `drizzle:MySqlInlineForeignKeys` and `drizzle:SQLiteInlineForeignKeys`, none of which the
    analyzer referenced.
  - **The table's extra-config callback was invoked with the table** where Drizzle passes its
    `ExtraConfigColumns`. That throws, and the throw sat under a bare `catch {}`, so every index,
    unique index, composite primary key, check constraint and table-level foreign key was
    discarded without a word.
  - **`relations()` was read as `val.config.relations`.** `config` is a function, so the expression
    was always `undefined` and the branch never executed.
  - **Enums were only collected when relations were requested**, so a caller that just wanted
    tables got none.

  New in the analysis:
  - `Table.foreignKeys`, including composite keys. Single-column keys are also mirrored onto
    `Column.references`.
  - Relations derived from foreign keys in both directions, `one` from the child and `many` from
    the parent, deduplicated against anything `relations()` already declared.
  - Many-to-many inference through a join table, reported as `kind: 'manyToMany'` with `via`. Only
    tables whose every column participates in a foreign key qualify, so a table carrying its own
    data is never mistaken for plumbing.
  - Check constraint expressions render as readable SQL instead of `[object Object]`.

  Column names in foreign keys, indexes and keys are TypeScript property names, matching
  `Column.name`, rather than the database names Drizzle reports internally. Postgres reports
  `no action` for a referential action where MySQL and SQLite report nothing; since that is the
  default, it is normalised away so the same schema analyses identically across dialects.

  A table whose extra-config callback throws now records a `DRZL_ANL_EXTRACONFIG` issue instead of
  losing its constraints silently, and an unreadable `relations()` records `DRZL_ANL_RELATIONS`.

  Heuristic name-based relations, still off by default, now only fire for columns that carry no
  real foreign key, so a properly constrained schema is never second-guessed.

  Tested against real drizzle-orm rather than stand-in classes. The existing suites build fake
  `PgInteger`-style classes, which cannot reproduce any of this and were green throughout.

## 1.3.0

### Minor Changes

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

## 1.2.0

### Minor Changes

- c48d79a: sponsor initiatives

## 1.1.0

### Minor Changes

- 2ca4b77: Fix ArkType generator emitting double-wrapped enum strings; pgEnum unions now render with JSON-escaped literals so `drzl generate` succeeds even when

## 1.0.0

### Major Changes

- 5da6f6b: support MySQL, SingleStore, and Gel; expand Postgres/SQLite; add tests (fixes #13)

## 0.3.0

## 0.2.0

## 0.1.0

## 0.0.3

## 0.0.2

## 0.0.1
