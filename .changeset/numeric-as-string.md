---
'@drzl/analyzer': minor
'@drzl/generator-zod': minor
'@drzl/generator-valibot': minor
'@drzl/generator-arktype': minor
'@drzl/generator-service': minor
'@drzl/generator-orpc': minor
'@drzl/cli': minor
---

Type `numeric` and `decimal` columns as strings, matching what Drizzle returns.

Generated validators previously typed them as numbers, so a select schema
rejected every row the database returned ("expected number, received string"),
and an insert schema rejected the string the driver wants while accepting a
number it does not.

`bigint({ mode: 'number' })` is now read as a number rather than a bigint, and
`real`/`doublePrecision` are separated from `numeric` since those really are
JS numbers.

If you were working around the old behaviour by coercing numeric values, that
workaround should be removed.
