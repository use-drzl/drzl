# @drzl/analyzer

## 1.17.1

### Patch Changes

- 6e551ca: A MySQL or SingleStore enum column is described as the string it is, on drizzle-orm 0.4x.

  Those two dialects give an enum its own column class and state no `codec`, so the class-name map is
  the only path, and it had an arm for `PgEnumColumn` and none for the other two. The column came back
  `tsType: 'unknown'` while carrying a full `enumValues` array.

  **The emitted validator was never wrong.** Every generator reads `enumValues` before it reads
  `tsType`, so a MySQL enum column has always produced a real enum of exactly its members. What was
  wrong was the description, and the description reached you anyway, through the untyped-column
  warning:

  ```
  Column "m_enum" on table "t" has no known type (SQL type enum('a','b','c')),
  so its validator will accept any value.
  ```

  The emitted schema accepted exactly three values. A warning that is wrong about the one column it
  names teaches you to skip the true ones, which is the cost this fix is really paying off.

  Nothing about the generated output changes. `drizzle-orm@1.0.0-rc.4` already answered `string` for
  the same column, so the two majors now agree, and the cross-major diff that carried the
  disagreement has one fewer filed defect.

## 1.17.0

### Minor Changes

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

### Patch Changes

- 1af970b: `decimal` and `numeric` are typed by their mode on drizzle-orm 0.4x, instead of every mode being a
  number.

  Drizzle gives each mode its own class, and the class-name path folded all three into one regex,
  `/Decimal|Numeric|Float|Double|Real/i`, which answered `number` for every one of them. Two of the
  three then rejected every row the database hands back, and their insert schemas rejected the value
  the driver wants. Read back through `db.select()` from a real MySQL 8.4.11 over mysql2, on a
  `decimal(10,2)` holding `'1234.56'` and a `decimal(20,0)` holding `'9007199254740993'`:

  ```
  mode              class                 driver returns     0.4x said   0.4x says
  (default/string)  MySqlDecimal          '1234.56'          number      string
  mode: 'number'    MySqlDecimalNumber    1234.56            number      number
  mode: 'bigint'    MySqlDecimalBigInt    9007199254740993n  number      bigint
  ```

  The same three modes measured identically on Postgres through PGlite and on SQLite through
  better-sqlite3, and official `drizzle-zod` 0.8.3 accepts exactly those three types on the same three
  columns and refuses the other two on each.

  **What changes for you.** On drizzle-orm 0.4x:

  - MySQL and SingleStore `decimal()` and `decimal({ mode: 'string' })` emit a string schema, matching
    `numeric` on Postgres, which has been a string here for exactly this reason.
  - MySQL and SingleStore `decimal({ mode: 'bigint' })` emit a bigint schema.
  - SQLite `numeric({ mode: 'number' })` and `numeric({ mode: 'bigint' })` were `unknown`, so their
    validators accepted anything; they now emit a number and a bigint schema.
  - Postgres `numeric({ mode: 'bigint' })` was already a bigint but was labelled `dbType: 'BIGINT'`,
    picked up from the arm meant for `bigint` columns. It is `'NUMERIC'` now. Nothing generated
    changes: `dbType` is read outside the analyzer only by `isIntegerColumn`, which asks whether it is
    exactly `'INTEGER'`.

  **What does not change.** `decimal({ mode: 'number' })` and `numeric({ mode: 'number' })` stay
  numbers on every dialect; that mode was the one the old answer got right. Nothing on drizzle-orm v1
  moves, since `describeV1Column` already reads the mode off `dataType` and got all three right. The
  `numeric` format check stays attached on v1 only, so a 0.4x string schema is a bare string and still
  takes `'hello'`, as the Postgres one already did.

## 1.16.0

### Minor Changes

- bfda92d: A view in your schema now produces schemas on drizzle-orm 0.x, as it already did on 1.0.0.

  On every 0.x release a view answers `undefined` to `drizzle:Columns`, `drizzle:Name` and
  `drizzle:Schema`; its columns and its name live only in `Symbol.for('drizzle:ViewBaseConfig')`. On
  1.0.0 `View` declares all three as getters over that same config. The analyzer identifies a
  table-like export by asking for `drizzle:Columns`, so on 0.x it skipped every view, and said
  nothing about it. `@drzl/analyzer` and `@drzl/cli` both depend on `drizzle-orm@^0.45.2`, so the
  broken major was the default one.

  Probed with a fresh install of each: invisible on 0.29.5, 0.33.0, 0.36.4, 0.39.3, 0.44.7, 0.45.0
  and 0.45.2; visible on 1.0.0-beta.1, beta.24, rc.1 and rc.4. Every dialect with a view API is
  affected: `pgView`, `pgMaterializedView`, `mysqlView` and `sqliteView`, in their query-builder,
  explicit-column-list, `.existing()` and schema-qualified forms alike.

  **What changes for you.** On 0.x, a schema file with views now emits a module per view and a line
  per view in the barrel, where it emitted nothing before. A fixture of 2 tables and 7 views went
  from 3 emitted files to 10. A file of nothing but views also stops reporting
  `dialect: unknown` with a spurious `DRZL_ANL_DIALECT` warning, because the loop that identifies
  the dialect read the raw symbol rather than going through the resolver, and was the one read site
  a fallback in the resolver did not reach.

  The measured target was parity, and it is met: on a fixture covering join, aggregate, `.existing()`,
  schema-qualified and materialized views, 0.45.2's analysis is byte-identical to 1.0.0-rc.4's, and
  so is the emitted zod. 1.0.0-rc.4's own analysis is unchanged by this release.

  **A SQLite view is now read-only.** SQLite refuses every write to a view, measured with
  `node:sqlite`: `insert`, `update` and `delete` all fail with `cannot modify <name> because it is a
view`. That is the argument `readOnly` already makes for a materialized view, so a `sqliteView` now
  carries it too and gets a select schema and nothing else. Postgres and MySQL both accept a write to
  a simple auto-updatable view, verified against a real server on each, so their plain views are
  unchanged.

  **Two things a view inherits from Drizzle that the server does not agree with**, both already
  present on 1.0.0 and neither addressed here. A view's columns keep the base column's `notNull` and
  its `primary`, because that is what Drizzle records in `selectedFields`. Postgres reports every view
  column nullable, so `SelectuserOrdersSchema` rejects `{"userId":2,"userName":"bob","total":null}`,
  a row PGlite really returned from a `LEFT JOIN` view. MySQL agrees for the join column and disagrees
  for the simple view's, computing nullability per column. Neither reports a primary key on a view,
  while DRZL reports one for the join view and the service and oRPC generators build by-id, update and
  delete endpoints on it. Both are filed.

  New export: `isDrizzleView(val)`, which asks `drizzle:ViewBaseConfig` rather than
  `drizzle:IsDrizzleView`; the latter looks like the obvious question and was only introduced in
  drizzle-orm 0.39.0.

### Patch Changes

- 2dccd51: Seven Gel column types are described from what a live Gel server actually returns.

  `boolean()` had no case in the analyzer's Gel arm at all and fell off the end to `unknown`, so every
  generator emitted a field that refused nothing. The six `cal::` and duration columns were typed
  `string`, which is worse: a wrong type rejects every row rather than accepting every value.

  Measured on a live Gel 7.1 (`geldata/gel:7`, `sys::get_version_as_str()` -> `7.1+08db576`) through
  `drizzle-orm/gel` 0.45.2 on `gel@2.2.0`, writing one row and reading it back:

  ```
  column        gel-core declares        SELECT hands back    INSERT accepts
  boolean       boolean                  boolean  true        -
  timestamp     LocalDateTime            LocalDateTime        LocalDateTime
  localDate     LocalDate                LocalDate            LocalDate
  localTime     LocalTime                LocalTime            LocalTime
  dateDuration  DateDuration             RelativeDuration     DateDuration
  relDuration   RelativeDuration         RelativeDuration     RelativeDuration
  duration      Duration                 RelativeDuration     Duration
  timestamptz   Date        (control)    Date                 -
  decimal       string      (control)    string  '12.34'      -
  ```

  A string is refused on insert by all six and returned by none, so `string` was wrong in both
  directions, not merely loose. `dateDuration` and `duration` contradict drizzle's own `.d.ts` on the
  way out and agree with it on the way in; the server is the arbiter for both halves.

  **What changes for you.** A Gel `boolean()` column now emits a real boolean check: `'yes'`, `12345`
  and `{ a: 1 }` were accepted before and are rejected now. The six temporal columns now report
  `tsType: 'unknown'`, so their emitted field goes from a string check that rejected every row to one
  that accepts the value the driver hands back, and each raises a `DRZL_ANL_UNKNOWN_COLUMN` warning
  naming its Gel type (`cal::local_datetime`, `cal::local_date`, `cal::local_time`, `dateDuration`,
  `edgedbt.relative_duration_t`, `duration`).

  **Why `unknown` and not a class name.** The value is an instance of a class from the `gel` package,
  which DRZL cannot import, so no generator can emit a check for it. A tsType naming the class would
  also suppress the unknown-column warning, which fires on `unknown`. Stating nothing and saying so is
  the honest answer; the check itself stays open and is tracked separately.

  **What does not change.** `integer`, `smallint`, `bigintT`, `bigint`, `text`, `uuid`, `json`, `real`,
  `doublePrecision`, `decimal`, `bytes`, `timestamptz` and `.array()` are all unaffected, and every one
  of them was read out of the same row.

- 194eb72: `mssql` and `cockroach` columns no longer lose their boolean and string families to `unknown`.

  Both cores arrived with Drizzle v1 and neither had a fixture anywhere in this repository. Measured
  by running the real analyzer over a real `mssqlTable` and a real `cockroachTable` on
  drizzle-orm 1.0.0-rc.4: **7 of 23 mssql columns and 6 of 27 cockroach columns came back
  `tsType: 'unknown'`**, and all thirteen were booleans or strings.

  ```
  mssql       flag(bit) name(varchar) nname(nvarchar) code(char) ncode(nchar) body(text) nbody(ntext)
  cockroach   flag(boolean) name(varchar) code(char) body(text) str(string) tags(text[])
  ```

  `describeV1Column` recognised a v1 column by its `codec` or by the semantic half of its `dataType`.
  Swept across every column builder the two cores export, 22 and 27 of them, **not one states a
  codec**, and those thirteen state a bare `dataType` with no semantic half either: a `bit` says
  `boolean`, and `varchar`/`nvarchar`/`char`/`nchar`/`text`/`ntext`/`string` all say `string`. That is
  indistinguishable from a Drizzle 0.4x column, so all thirteen fell to the class-name path, which has
  arms for Pg, MySql, SingleStore and Gel and none for these two. `drizzle:entityKind` is now a third
  v1 marker, sound for exactly these two because `mssql-core` and `cockroach-core` ship only on v1:
  the strings `MsSql` and `Cockroach` appear nowhere in the installed 0.45.2 package.

  The emitted validators accepted every value for those columns. Executed, not read, across all five
  generators, against values two real servers handed back or refused: 25 of 50 mssql probes and 25 of
  60 cockroach probes were wrong before, and 0 of each after. SQL Server 2022 refuses `'yes'` for a
  `bit` and refuses a 121st character in a `varchar(120)`; CockroachDB v24.3 refuses `1` for a `bool`
  and refuses a bare string for a `string[]`. Every one of those was accepted by the generated select
  and insert schemas in zod, valibot, arktype, typebox and JSON Schema.

  A cockroach `real` is also now bounded where Postgres bounds one rather than where MySQL does.
  `information_schema` reports its `crdb_sql_type` as `FLOAT4` and it speaks the Postgres wire
  protocol, so it carries the Postgres read-back this package already records: measured on v24.3,
  inserting the largest finite float32 makes the column hand back `3.4028235e+38`, a _larger_ double,
  so the MySQL bound refused a row the column had just returned. MSSQL keeps MySQL's bound, which is
  where falling through already put it and which SQL Server 2022 confirms: a `real` stores
  `3.4028234663852886e38` and refuses the next candidate up with an arithmetic overflow.

  **What changes for you.** If you generate from an mssql or cockroach schema, those columns now
  produce a real validator instead of one that accepts anything, and the `DRZL_ANL_UNKNOWN_COLUMN`
  warning they raised is gone. Input that only ever validated because nothing was checking it will
  now be rejected, which is the point. No other dialect is affected: the new marker only matches
  class names those two cores own.

## 1.15.0

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

## 1.14.0

### Minor Changes

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

### Patch Changes

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

## 1.13.0

### Minor Changes

- 78aeca2: Give json columns the JSON value space, and stop losing SQLite's mode columns

  Every generator has a branch for `shape: { kind: 'json' }` that emits a real definition of what
  JSON can hold. Nothing ever set that shape outside the drizzle v1 path, so a plain `json()` column
  landed on `tsType: 'any'` and the branch never ran. The emitted validator was `z.any()`, which
  accepts `undefined`, `NaN`, `Infinity`, a bigint, a Date and a Buffer, none of which survive a
  round trip through a json column. It is now `z.json()`.

  SQLite spells a mode as a distinct class rather than as config, so `text({ mode: 'json' })` is a
  `SQLiteTextJson` and `blob({ mode: 'bigint' })` is a `SQLiteBigInt`. Neither matched any arm of
  the class-name map, so both came back `UNKNOWN`, which is wider still than `any`.

  Found by the untyped-column warning firing on a json column, which was correct.

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

## 1.12.0

### Minor Changes

- 0fbed6a: A materialized view gets a select schema and nothing else.

  `INSERT INTO mv ...` fails with `cannot change materialized view`, verified against Postgres, so
  `InsertuserStatsSchema` and `UpdateuserStatsSchema` described an operation the database will
  always refuse. They are no longer emitted, along with their type aliases.

  **If you import one of those, your build will now fail.** That is the point: the call it was
  enabling could never have worked, and a compile error is a better way to find that out than a
  runtime error from the database.

  An ordinary view keeps all three. Postgres accepts an `INSERT` into a simple auto-updatable view,
  and whether a given view qualifies depends on its query rather than on anything the schema file
  states, so refusing them all would take away something that works. That distinction was checked
  against Postgres rather than assumed: a plain `SELECT a, b FROM t` view accepts an insert, an
  aggregate view does not, and a materialized view does not.

  Detection is on Drizzle's own `PgMaterializedViewConfig` marker rather than on a name.

## 1.11.0

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

## 1.10.0

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

## 1.9.0

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
