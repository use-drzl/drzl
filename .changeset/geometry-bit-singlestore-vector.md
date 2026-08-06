---
'@drzl/analyzer': patch
---

`bit`, `geometry` and SingleStore's `vector` are described instead of returning `unknown`.

The last of the classes the drizzle-orm 0.4x path could not name, found by the analyzer fuzzer. Each
emitted a validator that accepted any value at all.

The answers come from drizzle's own mappers, and two of the four are not what the name suggests:

```
bit(3)                 SELECT gives "101"        a string of digits
geometry()             SELECT gives [1,2]        a tuple
geometry({mode:'xy'})  SELECT gives {x:1,y:2}    a different class entirely
ss vector(3)           SELECT gives [1,2,3]      a number array
```

v1 already answered all four correctly from its codec, so the two majors agree again rather than
this being a new opinion.

**What changes for you.** A `bit` column's schema now requires a string of exactly the declared
width. A `geometry` column requires a two-number tuple, or an object of `x` and `y` in `xy` mode. A
SingleStore `vector` requires an array of numbers of the declared length. All four previously
accepted anything.

One consequence beyond the types: a nullable column that could not be named emitted a union
containing `unknown`, and TypeBox lets such a key go missing, so a row omitting the column validated
against the select schema. Naming these columns closes that for every Postgres case.
