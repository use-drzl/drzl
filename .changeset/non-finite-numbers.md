---
'@drzl/analyzer': patch
'@drzl/validation-core': patch
'@drzl/generator-zod': patch
'@drzl/generator-typebox': patch
'@drzl/generator-valibot': patch
'@drzl/generator-arktype': patch
---

Postgres float columns accept `NaN` and the infinities they actually store.

`real` and `double precision` hold `NaN`, `Infinity` and `-Infinity`, and Postgres hands all three
back on SELECT. Every emitted schema refused them, so reading a row holding one failed validation on
a column behaving exactly as documented. That is the read path, which no application can avoid.

No range could have fixed it. A `>=`/`<=` pair refuses `Infinity` whatever the numbers are and `NaN`
compares false against both ends, so the fact is now carried on the column as `allowsNaN` and
`allowsInfinity` and each generator renders it as a union beside the range. The range is unchanged
and still describes the column's finite values, so a `real` still refuses `1e300`.

Measured against PostgreSQL 18.3, on the bound-parameter path a validator guards:

```
real, double precision   NaN, Infinity and -Infinity all stored and returned unchanged
numeric (no typmod)      the same three, faithfully
numeric(10,2)            NaN faithful; either infinity refused, 22003 numeric field overflow
integer, bigint          all three refused
```

**What changes for you.** On Postgres, a `real` or `double precision` column's schema now accepts
`NaN`, `Infinity` and `-Infinity`. A `numeric({ mode: 'number' })` column accepts `NaN` and keeps
refusing both infinities: nothing in the analysis reads a column's precision or scale, so an
unconstrained `numeric` and a `numeric(10,2)` are indistinguishable, and admitting the infinities
would promise what the server refuses for the commoner of the two. Integer columns are untouched,
because Postgres refuses all three there. MySQL and SQLite are untouched; SQLite returns both
infinities and silently turns `NaN` into NULL, which is a separate answer that has to arrive whole.

The JSON Schema generator does not change. JSON has no `NaN` and no `Infinity`, so there is nothing
for it to admit.
