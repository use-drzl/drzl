---
'@drzl/validation-core': patch
'@drzl/generator-typebox': patch
'@drzl/generator-valibot': patch
'@drzl/generator-arktype': patch
---

`date({ mode: 'date' })` and `timestamp({ mode: 'date' })` stop accepting a string that is not a
date, in the valibot, ArkType and TypeBox generators.

`coerceDates` lets a client send a date as a string, and a previous fix narrowed *which* strings may
be coerced: one that is entirely a number, or that starts with a sign, is refused, because V8 and
Postgres disagree about what such a string means. That was a gate on the shape of the input, and
these three generators asked nothing at all about the result. So every string that was not a bare
number went through: `'hello'`, `'zzz'`, `'25:99:99'`, `'not-a-uuid'`, `'10.0.0.1'`, a uuid, a
300-character run of `x` and a string of emoji all validated, all became an Invalid Date, and
Postgres refuses every one of them. Validation passed and the INSERT then failed at the server,
which is the one outcome an Insert schema exists to prevent.

The zod generator was already correct and is what the other three now match. `z.preprocess(coerce,
z.date())` validates what came *out* of the coercion, and an Invalid Date is a real `Date` instance
that `z.date()` still turns away, so no bare instance check would have done: the timestamp is the
only thing that differs and it is `NaN`.

Each library states it in the form it has. valibot adds a `v.check` after the transform, which sees
the transform's output rather than its input. ArkType adds a `.narrow`, because the constraint is a
predicate over the result of a call and its string DSL cannot state one. TypeBox has no declarative
form for it either, so it intersects the registered kind it already uses for character caps onto the
string branch; the `pattern` beside it still serialises into a JSON Schema, the intersected branch
does not.

**What changes for you.** On a `mode: 'date'` column, a string that `new Date` cannot parse is no
longer accepted on the write path. Everything that reads as a date is untouched: `'2020-01-01'`,
`'2020-01-01T00:00:00Z'`, `'1999-01-08 04:05:06'`, `'01/02/2020'`, `'January 8, 1999'`, `'2020-1-5'`
and `'  2020-01-01  '` all still pass, as does a real `Date`. `coerceDates` itself is unchanged and
its `all` / `none` / `input` behaviour is the same, so `'none'` still emits a plain date type and
`'all'` still narrows the select schema the same way as the write schemas.

`'12:00:00'` is worth naming, because the two parsers could have disagreed about it and do not.
`new Date('12:00:00')` is an Invalid Date, and Postgres refuses `'12:00:00'` for `date`, `timestamp`
and `timestamptz` with `invalid input syntax`. The types that do take it are `time`, `timetz` and
`interval`, none of which is ever a `mode: 'date'` column. So it is refused, and both sides agree it
should be.

The zod and JSON Schema generators do not change.
