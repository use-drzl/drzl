---
'@drzl/analyzer': patch
'@drzl/generator-zod': patch
'@drzl/generator-valibot': patch
'@drzl/generator-arktype': patch
'@drzl/generator-typebox': patch
'@drzl/generator-json-schema': patch
'@drzl/generator-orpc': patch
'@drzl/generator-service': patch
---

Fixes two defects on drizzle-orm 0.4x, which is what `npm install drizzle-orm` still serves and
what this workspace itself depends on. Both were filed by the cross-major analyzer diff and the
0.4x parity pass and are now gone from both ledgers.

`point` and `line` were typed `string`. 0.4x carries no codec, so those columns reach the analyzer
by class name, and a coarse `/Point|Line/i` answered `string` for a value the driver hands back as
a tuple. A real Postgres settles it rather than the first-party module: drizzle 0.45.2 maps
`[1, 2]` to the literal `(1,2)`, the column takes it and `mapFromDriverValue` returns `[1, 2]`;
the string `"1,2"` is mapped to `(1,,)`, because `mapToDriverValue` indexes the value by position,
and Postgres refuses it with `invalid input syntax for type point`. So a select schema generated
on 0.4x rejected every row the column returned, and an insert schema accepted the one string shape
the column cannot be given. `point()` is now `[number, number]` and `line()` `[number, number, number]`,
matching what the analyzer already emitted on v1.

Inexact numeric columns carried no bounds. `real`, `double precision`, `numeric({ mode: 'number' })`
on Postgres, `real`, `double` and `float` on MySQL and SingleStore, and `real` on SQLite all
reached the same class-name path, where the only range table held integers. That left DRZL looser
than `drizzle-zod@0.8.3`, the first-party validator for the very same major: its `real` schema
refused 9000000, 2147483648 and 9007199254740993 where DRZL's took all three. Each column now
carries the width drizzle states for it on v1, and `integer: false` with it, so a bounded float is
not mistaken for an integer and does not start refusing `1.5`.

The bounds are drizzle's, not the database's, and the difference is measured rather than assumed.
Asked through PGlite, a `real` column accepts 8388608, 9000000, 2147483648, Infinity and NaN, and
holds every integer exactly up to 16777216, twice the bound emitted for it; `double precision`
returns every one of those unchanged. A `numeric(10,2)` runs the other way and refuses 2147483648
outright with `numeric field overflow`, so the safe-integer bound is still looser than that column
is. DRZL matches the first-party module on all of them, because a generated schema that disagreed
with it about the same column would be the more surprising outcome.

Only the analyzer's source changes. The generators are listed because what they emit for these
columns changes with it: a tuple where there was a string, and a range where there was none, in
the validators, in the JSON Schema, and in the TypeScript the service and oRPC generators write.
