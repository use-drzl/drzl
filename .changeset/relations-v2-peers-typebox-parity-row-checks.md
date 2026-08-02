---
'@drzl/generator-arktype': minor
'@drzl/generator-valibot': minor
'@drzl/validation-core': minor
'@drzl/generator-zod': minor
'@drzl/analyzer': minor
'@drzl/cli': minor
---

Relations v2, declared peer ranges, TypeBox measured against official, and row-level CHECKs.

### `defineRelations` produced no relations at all

Drizzle v1 added a second way to declare relations and the analyzer only knew the first, so a
schema using `defineRelations` came back with an empty relations array and the oRPC and service
generators emitted no relation endpoints. Nothing failed; the output was simply missing.
Confirmed against `@drzl/cli@4.8.0`, which returns `[]` for the schema this now reads.

The v2 shape is better than v1 for one case in particular: a many-to-many states its join table
through `through`, where v1 leaves it to a heuristic over tables whose columns are all foreign
keys. So a join table carrying extra columns is now recognised rather than missed.

### Zod 4 output with no declared peer

The emitted schemas use `z.uuid()` and `z.json()`, both Zod 4 only, and `@drzl/generator-zod`
declared no peer dependency on zod whatsoever. A Zod 3 project got code that does not compile and
nothing said why. All three now declare what they emit for: `zod >=4.0.0`, `valibot >=1.0.0`,
`arktype >=2.0.0`, matching what `@drzl/generator-typebox` already did.

### TypeBox is now measured against the official module

The parity gate could only cross-check the typebox output against DRZL's own generators, and the
docs said that was unavoidable. It was not: `drizzle-orm/typebox` targets the newer `typebox`
package and throws on import against the released one, but `drizzle-orm/typebox-legacy` is the
same module built for `@sinclair/typebox`, which is what this generator emits for.

Turning it on immediately found a divergence, in DRZL's favour: official emits
`Type.String({ format: 'uuid' })`, and TypeBox **fails** a format it has no entry for rather than
ignoring it, so that schema rejects every valid uuid in any project that has not populated
`FormatRegistry` first. DRZL emits a pattern, which needs no setup.

### Row-level CHECK constraints

`CHECK (start_date < end_date)` was skipped, because neither column alone can say whether it
holds. It goes on the object schema instead:

```ts
.refine((v) => v['startDate'] == null || v['endDate'] == null || v['startDate'] < v['endDate'],
  { message: 'date_order: startDate < endDate', path: ['startDate'] })
```

Both sides are guarded for null, reproducing SQL, where a comparison involving NULL yields NULL and
a CHECK passes on NULL. The error is reported against the left column so it has somewhere to land,
and a constraint naming a column the mode does not carry is left out rather than compared against
`undefined`.

Verified against a real Postgres through PGlite: for a table with `CHECK (start_date < end_date)`
and `CHECK (price <= max_price)`, the emitted schema and the database agree on all five probe rows.
