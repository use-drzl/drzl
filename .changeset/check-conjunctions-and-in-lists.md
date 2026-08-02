---
'@drzl/generator-arktype': minor
'@drzl/generator-valibot': minor
'@drzl/generator-typebox': minor
'@drzl/validation-core': minor
'@drzl/generator-zod': minor
'@drzl/cli': minor
---

CHECK constraints: `IN` lists and conjunctions.

The two most common shapes a CHECK is written in were both skipped. No official Drizzle validator
module enforces any CHECK at all, so these are added to a list that already had no competition.

### `IN` lists become enums

```ts
// check('status_valid', sql`${t.status} IN ('active', 'archived')`)
status: z.enum(['active', 'archived'] as const),
```

A set constraint is what an enum is, so it takes the enum's shape in each library rather than
becoming an opaque predicate, and the static type narrows with it: `v.picklist` for valibot,
`'active' | 'archived'` for ArkType, `Type.Union([Type.Literal(...)])` for TypeBox.

### Conjunctions split into one check per part

```ts
// check('n_bounds', sql`${t.n} > 0 AND ${t.n} < 10 AND ${t.n} <> 5`)
n: z.number().int()
  .refine((v) => v > 0, { message: 'n_bounds: n > 0' })
  .refine((v) => v < 10, { message: 'n_bounds: n < 10' })
  .refine((v) => v !== 5, { message: 'n_bounds: n <> 5' }),
```

Every part of an `AND` has to hold on its own, which is exactly what a list of refinements means.

The split walks the expression rather than splitting on the text, so the `AND` inside `BETWEEN 1
AND 10` and the one inside `'A AND B'` are both left alone. Lifting `BETWEEN` above the split was
necessary for that: taking the naive order silently turned every `BETWEEN` into an unparseable
pair and dropped a constraint that had been enforced since the feature shipped.

### What is still refused, and why it grew

`OR` and `NOT` anywhere in the expression disqualify it. A conjunction is safe to break apart
because each part holds independently; a disjunction is not, and separating them inside a mixed
expression needs a real parser. A conjunction where any single part is not understood is refused
whole rather than partially applied, since enforcing half of a constraint is enforcing a different
constraint.

Verified against a real Postgres through PGlite: for `CHECK (status IN ('active','archived'))`,
`CHECK (age >= 18 AND age <= 65)` and `CHECK (n > 0 AND n < 10 AND n <> 5)`, the emitted schema and
the database agree on all 19 probes, NULL included.
