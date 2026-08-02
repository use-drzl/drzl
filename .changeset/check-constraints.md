---
'@drzl/validation-core': minor
'@drzl/generator-zod': minor
'@drzl/analyzer': patch
---

**Generated Zod schemas now enforce CHECK constraints. No official Drizzle validator does.**

Verified against `drizzle-orm/zod` at 1.0.0-rc.4: a table declaring
`check('age_adult', sql`${t.age} >= 18`)` produces an insert schema that accepts `{ age: 5 }`.
The constraint is right there in the schema, the database will reject the row, and the validator
says nothing. Same for valibot, arktype and typebox.

DRZL emits:

```ts
age: z.number().int().gte(-2147483648).lte(2147483647)
  .refine((v) => v >= 18, { message: "age_adult: age >= 18" }),
```

`BETWEEN 0 AND 100` becomes two refinements. The constraint name is in the message, so a failure
points at the thing in the schema that caused it.

### It refuses more than it accepts, on purpose

Only a comparison naming one column against one literal is translated. A schema that quietly
enforces a *guess* at your constraint is worse than one enforcing nothing, because it rejects
rows the database would have accepted. Skipped, not guessed: comparisons between two columns
(`start_date < end_date`, a statement about the row rather than a field), compound predicates,
function calls, and regex matches, whose `~` in Postgres is POSIX ERE and not JavaScript's
dialect.

### Two pieces of SQL semantics that a naive version gets wrong

**A CHECK passes on TRUE or NULL.** So `CHECK (score >= 0)` on a nullable column accepts NULL.
The refinement is applied to the inner type and `.nullable()` wraps it, which reproduces that
exactly rather than being stricter than the database.

**The bound has to survive.** `sql`${t.age} >= ${MIN}`` used to render as `age >= ?`, because
`renderSql` mapped an interpolated value to `?`. Drizzle puts a primitive into the chunk list as
itself rather than wrapping it, so the value was there all along and was being discarded. Any
refinement built from that expression would have been built from a hole. Fixed in the analyzer,
which also makes `Table.checks[].expression` correct for anything else reading it.

Valibot and ArkType keep their current output; the parser lives in `@drzl/validation-core` as
`parseCheck`, so they can adopt it without reimplementing it.
