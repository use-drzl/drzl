# @drzl/generator-typebox

## 0.4.0

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
  - @drzl/validation-core@3.7.0
  - @drzl/analyzer@1.9.0

## 0.3.0

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

## 0.2.0

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

## 0.1.0

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
  - @drzl/validation-core@3.3.0
