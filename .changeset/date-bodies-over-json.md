---
'@drzl/generator-express': patch
'@drzl/generator-hono': patch
'@drzl/generator-trpc': patch
---

A `Date` column can now be written over JSON, which it could not before

The Express, Hono and tRPC generators typed a `Date` column as `z.date()` in every mode, insert and
update included. `JSON.stringify(new Date())` is a string, so no JSON body ever holds a `Date`
instance and every one of those schemas refused every spelling a client could send. A request
carrying a date column could not be written at all, in any of the three.

Measured through each emitted app rather than inferred: on tRPC's fetch adapter, against the exact
base this generator emits, both an ISO string and an epoch number were rejected.

The write side now takes the strict ISO datetime string and hands the handler a real `Date`, which
is what the NestJS generator already did. The read side is unchanged and stays `z.date()`, because
that is what the driver produces. Strict on purpose: `new Date('1')` is the year 2001, so a lenient
parse turns a typo into a row.

tRPC takes a union of both instead, `z.union([z.date(), <the ISO form>])`. Its builder carries the
transformer, and the emitted base creates one with none, so the default wire is plain JSON; adding
superjson to that same base is the documented tRPC answer for dates and then a real `Date` arrives.
Both are legitimate configurations of the tree this generator writes, and an ISO-only schema would
reject the value superjson exists to carry.

The oRPC generator is deliberately unchanged. Its RPC protocol carries a `Date` natively through its
own tagging, measured: a tagged body arrives at the handler as a real `Date` and `z.date()` is the
right schema for it, while a plain-JSON body is refused by the protocol before any schema runs.

None of the three had a `Date` column on a writable table in its fixtures, which is why this
survived: Express and Hono never posted one, and tRPC's runtime spec calls procedures through
`createCallerFactory`, which hands the resolver whatever JS value it is given and never crosses a
transformer. All three fixtures now carry one, and each suite asserts over its real wire that an ISO
string is accepted, that `"1"` is refused, and for tRPC that a real `Date` still works in process.
