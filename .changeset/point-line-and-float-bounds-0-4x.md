---
'@drzl/analyzer': minor
'@drzl/generator-zod': minor
'@drzl/generator-valibot': minor
'@drzl/generator-arktype': minor
'@drzl/generator-typebox': minor
'@drzl/generator-json-schema': minor
'@drzl/generator-orpc': minor
'@drzl/generator-service': minor
---

Fixes two defects on drizzle-orm 0.4x, which is what `npm install drizzle-orm` still serves and
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
and is what keeps the *bounded* widths from being read as integers: `isIntegerColumn` falls back to
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
