---
'@drzl/analyzer': patch
---

The pgvector family is described instead of coming back `unknown`.

`vector`, `halfvec` and `sparsevec` were all `unknown` on drizzle-orm 0.4x, so their validators
accepted any value at all, and `halfvec` was `unknown` on v1 as well. Found by the analyzer fuzzer,
which was built for exactly this shape of defect.

The answers come from drizzle's own mappers rather than from the type names, and the three do not
agree with each other:

```
vector(3)     SELECT gives [1,2,3]          INSERT sends "[1,2,3]"
halfvec(3)    SELECT gives [1,2,3]          INSERT sends "[1,2,3]"
sparsevec(3)  SELECT gives "{1:1.5,3:2}/3"  INSERT sends "{1:1.5,3:2}/3"
```

So `vector` and `halfvec` are `number[]` carrying their dimension count, and `sparsevec` is a
`string`. Typing the sparse one as a vector for symmetry would have rejected every row the database
returns, which is the defect the family was filed under to begin with.

**What changes for you.** A `vector` or `halfvec` column's schema now checks that the value is an
array of numbers of the declared length, where it previously accepted anything. A `sparsevec` column
now requires a string.
