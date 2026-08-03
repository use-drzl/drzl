---
'@drzl/generator-arktype': patch
---

Apply a column's constraint to the element of a nullable array, not to the array

A constraint on an array column describes each element: `varchar({ length: 5 }).array()` caps every
entry at five characters. This generator recovered the element by stripping a trailing `[]` off the
rendered type, which is only correct when nothing else is wrapped around the brackets. A nullable
array renders as `(string[] | null)`, which has no trailing `[]`, so the whole union was treated as
the element and `.array()` wrapped that.

The result, for `varchar({ length: 5 }).array()` with no `.notNull()`:

| value | before | after |
| --- | --- | --- |
| `null` | rejected | accepted |
| `['ab']` | rejected | accepted |
| `[['ab']]` | accepted | rejected |

A two-dimensional array came out a dimension too deep for the same reason. Both now agree with
`drizzle-orm/arktype` and with DRZL's own zod, valibot and typebox output on every probe.

The constraint now stays on the value, where the type expression is already right about
dimensions and nullability, and the predicate walks in one `.every` per dimension instead. An
empty list satisfies a constraint on elements, and a null passes at every level, matching SQL.

**What changes for you.** If you have a nullable array column with a length cap, its generated
arktype schema was refusing valid rows and accepting nested ones. Both stop.
