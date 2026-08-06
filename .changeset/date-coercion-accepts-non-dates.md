---
'@drzl/validation-core': patch
'@drzl/generator-zod': patch
'@drzl/generator-typebox': patch
'@drzl/generator-valibot': patch
'@drzl/generator-arktype': patch
---

`date({ mode: 'date' })` and `timestamp({ mode: 'date' })` stop accepting a string that is only a
number.

`coerceDates` lets a client send a date as a string, and every generator took any string at all in
that position. `new Date` reads a bare number as a year, or as `month.day`, so `'12.5'`, `'0101'`
and `'010'` were all real dates and Postgres refuses all three: validation passed and the INSERT
then failed at the server, which is the one outcome an Insert schema exists to prevent.

A coerced string now has to look like a date notation. The obvious justification for the rule, that
Postgres refuses a bare number, turned out to be false and the real one is stronger. Postgres reads
a six or eight digit run as a compact `YYMMDD` / `YYYYMMDD` date and takes it happily, but where
both parsers accept such a string they never agree on which date it is. Measured against a real
Postgres over every all-digit string in the probe set that both accept, ten of them, the two answers
differed every single time:

```
'250101'    Postgres 2025-01-01    V8 the year 250101
'241231'    Postgres 2024-12-31    V8 the year 241231
'121212'    Postgres 2012-12-12    V8 the year 121212
'000101'    Postgres 2000-01-01    V8 0100-12-31
'20200101'  Postgres 2020-01-01    V8 refuses it outright
```

So coercing a bare number either sends the server a value it rejects or silently writes a different
date than the database would have stored. A leading `+` or `-` goes the same way: `'+2020-01-01'`
and `'-2020-01-01'` are valid dates in V8 and Postgres refuses both.

**What changes for you.** On a `mode: 'date'` column, a string that is entirely a number, or that
starts with a sign, is no longer coerced and no longer validates. Everything that reads as a date to
both parsers is untouched: `'2020-01-01'`, `'2020-01-01T00:00:00Z'`, `'1999-01-08 04:05:06'`,
`'01/02/2020'`, `'January 8, 1999'`, `'2020-1-5'` and `'  2020-01-01  '` all still pass, as does a
real `Date`. `coerceDates` itself is unchanged and its `all` / `none` / `input` behaviour is the
same; this narrows what a coerced string may be, it does not remove coercion. Numbers are untouched
too, so an epoch millisecond still coerces.

The JSON Schema generator does not change. Dates arrive as strings once serialised, whatever
`coerceDates` does in TypeScript, and it already describes them as such.
