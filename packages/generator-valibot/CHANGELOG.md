# @drzl/generator-valibot

## 3.13.0

### Minor Changes

- b274391: Enforce row-level CHECK constraints in the valibot, TypeBox and ArkType generators

  `CHECK (start_date < end_date)` compares two columns, so it cannot be a field constraint. Only the
  zod generator applied one; the other three parsed it and dropped it, so a row the database refuses
  validated clean. Each generator now states it in its own idiom: `v.check` on a pipe for valibot,
  `.narrow` for ArkType, and for TypeBox a registered kind intersected with the object, which both
  `Value.Check` and `TypeCompiler` honour. Serialising a TypeBox schema to JSON Schema keeps the
  constraint as a description, since JSON Schema cannot compare two fields.

  Both sides are guarded for null first, matching SQL, where a comparison involving NULL leaves the
  CHECK satisfied. A constraint naming a column a given mode does not carry is left out rather than
  emitted against an undefined value.

  Also fixes an ArkType crash this uncovered: a CHECK on a column with no declared width, which is
  every numeric type but the integers, emitted `0 < number`. ArkType rejects a left bound with no
  right bound, so the generated module threw the moment anything imported it. A lone bound is now
  written as `number > 0`.

### Patch Changes

- 03f7810: Fold a numeric CHECK into valibot's range instead of adding an action beside it

  `CHECK (age >= 18)` on an integer column emitted `v.minValue(-2147483648), v.maxValue(2147483647),
v.check((val) => val >= 18)`: a bound that can never fail, plus a closure saying what the bound
  should have said. It is now `v.minValue(18), v.maxValue(2147483647)`, matching the fix already
  applied to the zod generator.

  valibot has the exclusive forms natively, so `> 0` becomes `v.gtValue(0)` and `< 10` becomes
  `v.ltValue(10)` rather than closures. The issue valibot raises then carries `requirement: 0` as
  data instead of a sentence this generator wrote, which is what a client needs in order to render
  its own message.

  The pg fixture's valibot output falls from 397 to 360 bytes per column.

- Updated dependencies [78aeca2]
- Updated dependencies [dc13c47]
- Updated dependencies [c29891a]
  - @drzl/analyzer@1.13.0

## 3.12.0

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

## 3.11.0

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

### Patch Changes

- Updated dependencies [c5fcb15]
  - @drzl/validation-core@3.13.0

## 3.10.0

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

### Patch Changes

- Updated dependencies [f98d84a]
  - @drzl/validation-core@3.12.0

## 3.9.0

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

### Patch Changes

- Updated dependencies [387b45b]
  - @drzl/validation-core@3.11.0

## 3.8.0

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

## 3.7.0

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
  - @drzl/validation-core@3.9.0
  - @drzl/analyzer@1.10.0

## 3.6.0

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
  - @drzl/validation-core@3.8.0

## 3.5.0

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

## 1.1.0

### Minor Changes

- c48d79a: sponsor initiatives

### Patch Changes

- Updated dependencies [c48d79a]
  - @drzl/validation-core@1.1.0
  - @drzl/analyzer@1.2.0

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
