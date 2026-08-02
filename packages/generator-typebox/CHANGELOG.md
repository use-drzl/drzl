# @drzl/generator-typebox

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
