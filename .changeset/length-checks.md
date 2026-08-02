---
'@drzl/generator-valibot': minor
'@drzl/validation-core': minor
'@drzl/generator-zod': minor
---

`CHECK (length(col) <op> n)` is now enforced, counted in characters.

The one function call the check parser reads, because the mapping is exact:

```ts
// check('name_len', sql`length(${t.name}) >= 3 AND length(${t.name}) <= 8`)
name: z.string()
  .refine((v) => [...v].length >= 3, { message: 'name_len: length(name) >= 3' })
  .refine((v) => [...v].length <= 8, { message: 'name_len: length(name) <= 8' }),
```

`char_length` is the same function in Postgres and is read too. Counted in code points, for the
same reason a `varchar(n)` limit is: Postgres counts characters and `.length` counts UTF-16 units.
Verified against Postgres for `CHECK (length(name) >= 3 AND length(name) <= 8)`, which agrees on
all eight probes including three, eight and nine emoji.

`octet_length` is deliberately **not** read: it counts bytes, which depends on the encoding and
cannot be derived from a JavaScript string without choosing one. Nor is `lower`, which would need
a locale to be faithful. The rule is unchanged, only its reach: read what maps exactly, refuse the
rest rather than guess.

TypeBox and ArkType do not carry these, for the same reason they carry an approximate `varchar(n)`:
both state constraints declaratively with no predicate to hook. Each generator's docs say so.

The parity probe pool gained astral characters as well, so a cross-generator disagreement about
character counting is visible rather than invisible.
