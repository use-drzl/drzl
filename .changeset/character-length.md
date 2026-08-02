---
'@drzl/generator-valibot': minor
'@drzl/validation-core': minor
'@drzl/generator-zod': minor
---

A `varchar(n)` limit counts characters, not UTF-16 code units.

Postgres and MySQL count `varchar(n)` in **characters**. Every JavaScript validator counts
`.length`, which is UTF-16 code units. The two agree until the text leaves the basic plane, and
then they do not.

Measured against Postgres through PGlite for a `varchar(10)` column:

| value               | database    | `.max(10)`  |
| ------------------- | ----------- | ----------- |
| 10 plain characters | accepts     | accepts     |
| 8 emoji             | **accepts** | **refuses** |
| 10 emoji            | **accepts** | **refuses** |
| 11 emoji            | refuses     | refuses     |

So the generated schema was turning away a bio, display name or message the column would have
stored quite happily. `drizzle-orm/zod` emits `.max(n)` and does the same.

The zod and valibot generators now count code points, which is what the database counts:

```ts
name: z.string().refine((v) => [...v].length <= 10, { message: 'at most 10 characters' }),
```

TypeBox and ArkType keep the UTF-16 form, and it is not an oversight: both state a length
declaratively with no predicate to hook, so their output stays approximate for astral text. That
is documented on each.

The probe pool behind the ground-truth stage gained astral characters, since it had none and that
is why the gate never saw this. It remains a class the gate cannot fail on by itself, because DRZL
and `drizzle-orm` were wrong in exactly the same way and the gate only fires when DRZL is uniquely
wrong. Finding it needed the pool to contain a value that tells the two counts apart.
