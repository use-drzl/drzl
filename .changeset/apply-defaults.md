---
'@drzl/validation-core': minor
'@drzl/generator-zod': minor
'@drzl/analyzer': minor
'@drzl/cli': minor
---

`applyDefaults`: reproduce literal column defaults in the insert schema.

Drizzle knows what a column defaults to. `drizzle-orm/zod` reproduces none of them, so a parsed
insert is missing the values the database would have written.

```ts
{ kind: 'zod', path: 'src/validators/zod', applyDefaults: true }
```

```ts
country: z.string().default("GB"),
count: z.number().int().default(0),
```

`InserttSchema.parse({ name: 'x' })` returns `{ name: 'x', country: 'GB', count: 0 }`. Verified
against a real Postgres through PGlite: inserting only the column that has no default leaves the
database filling in exactly those three values.

Only **literal** defaults. `defaultNow()`, `defaultRandom()` and any `sql` default are evaluated by
the database, and `$defaultFn` is called by Drizzle at insert time. Those are told apart by shape
rather than by name: an SQL default carries `queryChunks`, a function default sets `defaultFn`.
Both stay `.optional()`, because a schema guessing at either would produce a different value than
the one actually stored.

Insert only, and `.default()` replaces `.optional()` rather than stacking with it: `.optional()`
wrapped around a default short-circuits on an absent key and returns undefined, leaving the default
unreachable.

Off by default, because it changes what parsing _returns_ rather than only what it accepts.
