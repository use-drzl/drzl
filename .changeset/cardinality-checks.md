---
'@drzl/generator-valibot': minor
'@drzl/validation-core': minor
'@drzl/generator-zod': minor
---

`CHECK (cardinality(col) <op> n)` is now enforced on array columns.

```ts
// check('tags_rule', sql`cardinality(${t.tags}) > 0 AND cardinality(${t.tags}) < 4`)
tags: z.array(z.string())
  .refine((v) => v.length > 0, { message: 'tags_rule: cardinality(tags) > 0' })
  .refine((v) => v.length < 4, { message: 'tags_rule: cardinality(tags) < 4' }),
```

The array analogue of the `length()` support, and free of the question that one carries: an
element count is the same number in SQL and in JavaScript, with no encoding involved.
`array_length(col, 1)` reads the same way, because for a one-dimensional array it is that count.
`array_length(col, 2)` is refused, since a higher dimension is not an element count.

This is the one check an array column takes. Every other kind is skipped there, because a
comparison against a scalar literal says nothing usable about an array; this one is about the
array itself, so it is applied after the array wrapping rather than to an element.

Verified against Postgres for `CHECK (cardinality(tags) > 0 AND cardinality(tags) < 4)`: the
emitted schema and the database agree on all four probes.
