# @drzl/generator-arktype

## 3.13.0

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

- 734defc: `applyDefaults` emits a module that loads, for every shape a Drizzle default comes in.

  ArkType checks a default against its own type when the module is built, not when a row arrives, so
  a default it cannot hold is a `ParseError` at import: not a wrong verdict on a row but no verdict
  at all, and every file that imports the schema goes down with it. Five ordinary column shapes did
  exactly that, and one killed the generator before it wrote anything:

  ```
  varchar(2).default('GB')            ParseError: Defaultable definitions like 'number = 0' are
                                      only valid as properties in an object or tuple
  varchar(2).default(null)            the same
  jsonb().default({ a: 1 })           ParseError: '{"a"' is unresolvable
  text().array().default(['a'])       ParseError: Expected an expression before '["a"]'
  timestamp().default(new Date(...))  ParseError: Default for x must be a Date (was string),
                                      under coerceDates: 'none'
  doublePrecision().default(Infinity) ParseError: Default for x must be a number (was null),
                                      because JSON.stringify(Infinity) is the string "null"
  bigint({ mode: 'bigint' }).default(7n)
                                      TypeError: Do not know how to serialize a BigInt, thrown by
                                      the generator itself
  ```

  The first two are the common case: **any** capped string column with a literal default, which is
  what `varchar(n)` with a `DEFAULT` is. One 23-column table with `applyDefaults: true` produced a
  file that could not be imported at all.

  A default now goes where ArkType can hold it. It stays in the string DSL when the field is a plain
  DSL string and the value is a literal the DSL can spell; otherwise it moves to `.default()` on the
  Type, after the narrows rather than inside the string, where an object and an array arrive as
  `() => (...)` and a Date as `() => new Date(...)`.

  Moving it there also closes a silent hole. A bigint column states its range through a narrow,
  because the DSL cannot carry a bigint bound at all, and that narrow used to be dropped whenever a
  default was applied: `bigint({ mode: 'bigint' }).default(null)` accepted `2n ** 70n` on insert and
  refused it on select and update. The same value now gets the same answer from all three, and the
  insert schema is the one that runs before a write.

  A literal that cannot be written down exactly is left out rather than approximated, and the key
  stays merely optional, which is what an `sql` default and a `$defaultFn` have always done.

  With `applyDefaults` off the emitted text is byte-identical to before, checked over a 23-column
  table carrying caps, bigints, arrays, enums and CHECK constraints.

- Updated dependencies [b14cbed]
- Updated dependencies [8cc4de8]
- Updated dependencies [f019b03]
  - @drzl/validation-core@3.16.0
  - @drzl/analyzer@1.18.0

## 3.12.1

### Patch Changes

- d8eb257: A MySQL or SingleStore `binary(n)`/`varbinary(n)` column is a string, and its schemas stop rejecting
  every row.

  The same wrong answer took two forms, one per drizzle major. On 0.4x the analyzer read the word
  "Binary" out of the class name and typed all four column builders as `Uint8Array`; on v1 it read the
  `string binary` dataType those columns share with a Postgres `bit(n)` and gave them a bit string, so
  all five generators emitted `^[01]*$` capped at n. Both are wrong about the same thing, and it was
  settled by asking a live MySQL 8.4 through drizzle on both majors rather than by reading any of the
  three layers in between:

  ```
  raw mysql2          vbin -> Buffer <00 ff 41>
  drizzle 0.45.2      vbin -> string, 3 code points, instanceof Uint8Array false
  drizzle 1.0.0-rc.4  vbin -> string, identical
  ```

  Measured through the emitted modules against that server, before and after, on both majors: the old
  schemas rejected **every** row the column returned in zod, valibot, arktype and typebox, and the new
  ones accept every one of them. The JSON Schema generator accepted them on 0.4x only by accident,
  because `contentEncoding: 'base64'` is an annotation no validator enforces.

  The declared width means two different things depending on direction, and both were measured:

  - **out**, the decode is lossy, so n bytes become at most n code points. `<ff ff ff>` stored in a
    `varbinary(3)` comes back as 3 characters that re-encode to 9 UTF-8 bytes, so a byte cap on a
    select schema refuses a row the column itself returned.
  - **in**, the server counts the encoded bytes. A `varbinary(8)` takes 8 ascii characters and refuses
    9, and takes 2 emoji (8 bytes) and refuses 3 (12 bytes), so a character cap on an insert schema
    promises a write the server refuses.

  So the column now carries a `{ kind: 'byteString', length }` shape and each generator picks the
  measurement its mode needs: characters on select, bytes on insert and update. Over a pool of writes
  against the live server, the four typed generators went from 16 disagreements with it to 0 on each
  major.

  **What changes for you.** A select schema for one of these columns now accepts the string your
  driver hands you and rejects a `Uint8Array`, which is the opposite of the 0.4x behaviour. An insert
  schema accepts any string inside the byte budget, including the empty string and anything that is
  not a run of `0` and `1`, and rejects one that is too long in bytes. `Column.tsType` for these four
  builders is `'string'` and `Column.dbType` is `'BINARY'` on both majors, where 0.4x used to say
  `Uint8Array`/`BLOB`; the declared width moved off `maxLength` and onto the shape.

  **What does not change.** A Postgres `bit(n)` and a Cockroach `bit(n)`/`varbit(n)` keep the bit
  string, which is correct for them. MSSQL `binary`/`varbinary` report `object buffer` and were never
  on this path. Gel `bytes` really does hand back a Buffer and stays a `Uint8Array`. The JSON Schema
  generator states the code-point cap in every mode, since JSON Schema has no keyword that counts
  bytes; that is a necessary condition on insert rather than the whole one.

  `drizzle-orm/zod` emits a bare unbounded string for these columns on 0.4x and the same rejects-every-row
  bit string on v1, so this output is deliberately neither.

- Updated dependencies [d8eb257]
- Updated dependencies [1af970b]
  - @drzl/analyzer@1.17.0

## 3.12.0

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

## 3.11.0

### Minor Changes

- 04e06a2: Bound bigint columns in the arktype output, which accepted values no int64 can hold

  A `bigint({ mode: 'bigint' })` column emitted the bare ArkType type `bigint` and nothing else, so
  the generated schema accepted `2n ** 70n`. zod, valibot and typebox all bound the same column, and
  so does `drizzle-orm/arktype`, which made this the one place where DRZL's output was _looser_ than
  the first-party validator rather than stricter. On Postgres, MySQL and SQLite alike, a row this
  schema passed could be one the database refuses.

  The reason it was left unstated was half right. ArkType's string DSL genuinely cannot carry the
  bound: `type('bigint >= -9223372036854775808n')` throws "Comparator >= must be followed by a
  corresponding literal", and the same bound written as a number rounds, since 9223372036854775807
  is not representable as a double. But `.narrow` can carry it, and this generator already used
  `.narrow` for every `varchar(n)` character cap and every MySQL byte cap. Bigint columns now use
  the same mechanism, and a `CHECK` folds into the bound exactly as it does for a number column.

  Null still passes, matching SQL and matching the existing cap narrows. An array column bounds its
  element rather than the array. A bound that could only be rendered as a syntax error, such as a
  fractional one, is left off rather than emitted, because a module ArkType cannot parse throws at
  import and takes whatever imported it down.

  **What changes for you.** Generated arktype schemas for `bigint`, `bigserial` and SQLite
  `blob({ mode: 'bigint' })` columns now reject a bigint outside the int64 range. If you were
  relying on a value larger than the column can store passing validation, it will now be refused,
  which is the behaviour the zod, valibot and typebox generators already had, and the behaviour of
  `drizzle-orm/arktype` itself.

### Patch Changes

- 9e75c84: Apply a column's constraint to the element of a nullable array, not to the array

  A constraint on an array column describes each element: `varchar({ length: 5 }).array()` caps every
  entry at five characters. This generator recovered the element by stripping a trailing `[]` off the
  rendered type, which is only correct when nothing else is wrapped around the brackets. A nullable
  array renders as `(string[] | null)`, which has no trailing `[]`, so the whole union was treated as
  the element and `.array()` wrapped that.

  The result, for `varchar({ length: 5 }).array()` with no `.notNull()`:

  | value      | before   | after    |
  | ---------- | -------- | -------- |
  | `null`     | rejected | accepted |
  | `['ab']`   | rejected | accepted |
  | `[['ab']]` | accepted | rejected |

  A two-dimensional array came out a dimension too deep for the same reason. Both now agree with
  `drizzle-orm/arktype` and with DRZL's own zod, valibot and typebox output on every probe.

  The constraint now stays on the value, where the type expression is already right about
  dimensions and nullability, and the predicate walks in one `.every` per dimension instead. An
  empty list satisfies a constraint on elements, and a null passes at every level, matching SQL.

  **What changes for you.** If you have a nullable array column with a length cap, its generated
  arktype schema was refusing valid rows and accepting nested ones. Both stop.

## 3.10.1

### Patch Changes

- b692e95: Cap array elements again in the ArkType and TypeBox generators

  Moving `varchar(n)` caps off the UTF-16 keywords dropped them for array columns: `varchar(50).array()`
  emitted a bare `string[]` and `Type.Array(Type.String())`. The cap describes the element, not the
  list, so it now goes on the element, with `.array()` wrapping it in ArkType.

  For TypeBox that also fixed an emitted module that threw on import. The check deciding whether to
  emit the registry preamble still excluded array columns while the expression no longer did, so a
  file used `[Kind]` without importing it. Both now read one shared predicate.

  Found by regenerating the documentation examples, which is the only reason anything looked at a
  capped array.

## 3.10.0

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

- 5578e93: Count MySQL TEXT caps in bytes, and stop rejecting valid `varchar(n)` values in TypeBox and ArkType

  Two different measurements were both being got wrong, in opposite directions. Measured against a
  real MySQL 8 on utf8mb4 and a real Postgres, not reasoned about:

  - `varchar(10)` counts **characters** in both databases: ten thumbs-up characters are a valid row.
    TypeBox emitted `maxLength: 10` and ArkType `string <= 10`, both of which count UTF-16 code
    units, so both **refused a row the database accepts**. That is the direction that breaks working
    code. zod and valibot already counted code points.
  - MySQL's TEXT family counts **bytes**: `tinytext` takes 255 ascii characters and 63 thumbs-up
    ones (252 bytes), refusing 64 (256 bytes). The cap was carried as a character count, so a
    tinytext holding 64 emoji validated clean and MySQL refused the row. It is now a separate
    `maxBytes`, applied by encoding the string.

  On drizzle-orm 0.4x the TEXT caps were absent entirely: every member of the family shares the
  `MySqlText` class there, so only the SQL type tells a `tinytext` from a `longtext`.

  Both caps now sit on the field rather than the object, so the differential parity harness, which
  compares column by column, can still see them.

- Updated dependencies [fbc0881]
- Updated dependencies [5578e93]
  - @drzl/analyzer@1.14.0
  - @drzl/validation-core@3.14.0

## 3.9.0

### Minor Changes

- 19dfa3b: Apply `cardinality()` CHECK constraints in the ArkType and TypeBox generators

  `CHECK (cardinality(tags) >= 2)` was parsed and then dropped by both, so an array the database
  refuses validated clean. zod and valibot already applied it.

  Each states it natively rather than as a predicate. ArkType bounds an array's length with the same
  operators it bounds a number with, so it folds into the type: `string[] >= 2`. TypeBox uses
  `minItems` and `maxItems`, which means the constraint survives serialisation to JSON Schema. JSON
  Schema has no exclusive form of either keyword, but a length is an integer, so `> 2` becomes
  `minItems: 3` and nothing is approximated.

  The bound binds to the outermost array, so it counts what `cardinality()` counts, and it sits
  inside the union with null on a nullable column, so null still passes.

- 3e15ea8: Apply `length()` CHECK constraints in the ArkType and TypeBox generators

  `CHECK (length(name) >= 3)` was parsed, applied by zod and valibot, and dropped in silence by the
  other two: ArkType emitted a bare `string` and TypeBox a bare `Type.String()`. A constraint the
  database enforces and the validator does not is precisely the gap these generators exist to close.

  Neither uses its native length keyword, and that is deliberate. ArkType's `string >= 3` and
  TypeBox's `minLength` both count UTF-16 code units, while SQL's `length()` counts characters, so
  three thumbs-up characters are six units to both. On a minimum that only under-enforces; on a
  maximum it refuses rows the database accepts, which is the `varchar(n)` bug the zod generator
  already avoids by counting code points.

  So each goes where an exact count can be expressed: a `.narrow()` on the object for ArkType, and a
  branch of the same registered-kind intersection the row checks use for TypeBox. Null and absent
  both pass, matching SQL.

  The cost for TypeBox is that this constraint does not survive serialisation to JSON Schema, where
  a bare `minLength` would. Emitting the wrong count in a form that serialises is not a better
  trade.

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

- Updated dependencies [78aeca2]
- Updated dependencies [dc13c47]
- Updated dependencies [c29891a]
  - @drzl/analyzer@1.13.0

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
