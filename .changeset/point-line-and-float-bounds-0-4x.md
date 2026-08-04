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
  values the column holds. This is a change on **both** majors, and it widens rather than narrows,
  so nothing that validated before stops validating.
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

So the bounds are the database's now. A 4 byte float is bounded at the one magnitude Postgres does
refuse, 3.4028234663852886e38, past which it answers `out of range for type real`. An 8 byte float
carries no magnitude bound, and states `integer: false` on its own so a bounded float is never
mistaken for an integer. `numeric({ mode: 'number' })` keeps the safe-integer range, which is about
what a JS number can carry rather than about the column.

Measured against this repository's ground-truth stages, which insert every probe into a real
Postgres: DRZL's agreement with the database rose from 1007 to 1012 on the validator schemas and
from 852 to 857 on the JSON Schema output, and the count of probes where DRZL disagrees with
Postgres and the first-party module does not stayed at 0.

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
