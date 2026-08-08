---
'@drzl/generator-orpc': patch
'@drzl/template-orpc-service': patch
'@drzl/template-standard': patch
---

oRPC addressing inputs and handler bodies are typed from the primary key instead of a hardcoded `{ id: z.number() }`

Every emitted `get`/`update`/`delete` input spelled `{ id: z.number() }` whatever the primary
key was, at two layers: the generator's input rewrite (in all three validation libraries, and
in the cross-table relation lookups), and both template packages' own procedure code, where
`@drzl/template-orpc-service` called `Service.getById(input.id)` through it. Measured on pg
books/composite/keyless beside the post-BP services: exactly 9 tsc errors confined to the
routers (3x TS2345 number-into-varchar on books, 3x TS2554 arity on a composite key, 3x TS2339
on a keyless table whose service correctly no longer has the methods).

The key is now read the way `@drzl/generator-service` and the tRPC generator read it: every
column of `primaryKey`, at its real type, in the configured library's spelling
(`{ isbn: z.string() }`, `v.object({ isbn: v.string() })`, `type({ isbn: 'string' })`, an enum
key's literals). A composite key keeps all of its columns, in key order, and the service
template composes the call as one argument per key column
(`Service.getById(input.orgId, input.userId)`). Update inputs are the same key beside the
patch. A table with no primary key emits `list` and `create` only, drops the relation lookups
that would take its key, and stops importing a shared update schema nothing references. A key
column DRZL cannot type arrives as the library's `unknown`; the service template stubs those
procedures with a note naming the column, because `unknown` is not assignable to the service's
typed key parameter. Templates cannot reintroduce the defect: the generator rewrites every
template's addressing inputs and drops keyless addressing procedures whatever the template
emitted.

Integer-key emissions are byte-identical to before, proved by running the previous build beside
this one over the same analyses (43 configurations across templates, libraries, relations,
shared validation, injection and naming: 172 file pairs, zero diffs; in the natural-key grid
the 45 files that differ are exactly the natural, composite, keyless, untypeable and enum-key
routers). This also restores the pairing BP left red: stub-mode services + oRPC on natural keys
now compile, because the typed stubs and the routers finally agree. Red-first: the 9 measured
errors reproduced against a real typed PgDatabase, 0 after; a real oRPC `call` round-trip
addresses a natural-key row and a composite row end to end, and the old `{ id: 1 }` payload is
now the one that fails validation.
