# @drzl/generator-json-schema

## 0.4.2

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

## 0.4.1

### Patch Changes

- 0fde945: A MySQL TEXT column now carries its cap in the emitted JSON Schema, and says what the format cannot
  express.

  The analyzer reports a MySQL `tinytext`, `text`, `mediumtext` or `longtext` column with `maxBytes`,
  the budget the column type itself imposes. The four validation generators encode the string and
  count the bytes. This one ignored the field, so on drizzle-orm 0.4x, where such a column carries no
  declared length either, the emitted schema was `{ "type": "string" }` and a document validated
  against it could still be refused by the database.

  Asked of a real MySQL 8 on utf8mb4 in `STRICT_TRANS_TABLES`, on a `TINYTEXT` column whose budget is
  255 bytes, with the emitted module compiled by ajv:

  ```
                         MySQL     before    after
  255 ascii, 255 bytes   accepts   accepts   accepts
  256 ascii, 256 bytes   REFUSES   accepts   REFUSES
   63 emoji, 252 bytes   accepts   accepts   accepts
   64 emoji, 256 bytes   REFUSES   accepts   accepts
  ```

  **What changes for you.** A string column with a byte budget gains `maxLength` holding that number,
  and a `description` naming the budget. If you were sending values over the cap, the database was
  already refusing the write. `varchar(n)` columns are untouched: that limit really is characters, and
  it already had one.

  **What it still cannot do.** JSON Schema has no byte-length keyword in any draft, and inventing one
  produces a document that either fails to compile in a strict validator or is silently ignored by a
  lax one. `maxLength` counts characters, and UTF-8 spends at least one byte per character, so the cap
  refuses nothing the column accepts and catches every overflow made of one-byte characters. It cannot
  catch a multi-byte string that fits the count and not the budget, which is the last row of the table
  above, so that is what the `description` says.

  Binary columns are unaffected, because they travel as base64 and a character cap taken from a byte
  budget would refuse a legal value.

- Updated dependencies [2dccd51]
- Updated dependencies [194eb72]
- Updated dependencies [bfda92d]
  - @drzl/analyzer@1.16.0

## 0.4.0

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

## 0.3.0

### Minor Changes

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

## 0.2.0

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

### Patch Changes

- Updated dependencies [78aeca2]
- Updated dependencies [dc13c47]
- Updated dependencies [c29891a]
  - @drzl/analyzer@1.13.0
