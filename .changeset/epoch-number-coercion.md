---
'@drzl/generator-typebox': patch
'@drzl/generator-valibot': patch
'@drzl/generator-arktype': patch
---

`date({ mode: 'date' })` and `timestamp({ mode: 'date' })` accept an epoch number on write in the
valibot, ArkType and TypeBox generators, which is what `coerceDates` has always documented.

`coerceDates` is described as taking a date string **or an epoch number** on insert and update. Only
the zod generator ever had a number branch. The other three never had one, so every date and
timestamp column took `Date.now()` in one of the four generators and refused it in the other three,
on insert and on update alike, and which of your schemas accepted an epoch depended on which
validator you had chosen rather than on anything you wrote. Measured across all four generators on
11 date and timestamp columns, the divergence was the same single signature on every one of them.

The zod generator is the reference the other three now match, and it does not change. Each of the
other three states the branch in the form its library has. valibot adds a second pipe beside the
string one, `v.number()` into a transform into the same result check. ArkType adds `number` to the
union in its string DSL and widens the `.narrow` that already guards the string, so one predicate
answers for both. TypeBox adds a `Type.Number()` branch intersected with the registered `DrzlRowCheck`
kind, which is where a predicate can live at all in that library, exactly as its string branch does.

**A number that is not a date is still refused, in all four.** `new Date(NaN)` and
`new Date(Infinity)` are Invalid Dates, and so is any finite number past the +-8.64e15 where the
`Date` range ends, so `1e300` is a good number and not a date. The result check each generator
already applied to the coerced string now covers the coerced number too, and it is load-bearing
rather than belt-and-braces: `v.number()` and ArkType's `number` refuse `NaN` on their own and take
both infinities, `Type.Number()` refuses all three and takes `1e300`, so no library turns all of them
away by itself.

**What changes for you.** On a `mode: 'date'` column, `Date.now()` and any other epoch millisecond
value is accepted on the write path by all four generators. Nothing else moves: a real `Date`, an
ISO string and every other notation both parsers read the same way still pass, and `'hello'`,
`'12.5'`, `null`, booleans and arrays are still refused. `coerceDates` itself is unchanged and its
`all` / `none` / `input` behaviour is the same, so `'none'` still accepts only a real `Date`
anywhere, `'input'` leaves the select schema strict, and `'all'` extends the same coercion to select.

The zod and JSON Schema generators do not change.
