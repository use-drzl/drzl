---
'@drzl/validation-core': patch
'@drzl/generator-zod': patch
'@drzl/generator-valibot': patch
'@drzl/generator-arktype': patch
'@drzl/generator-typebox': patch
'@drzl/generator-effect': patch
---

Character caps stop spreading the string when it cannot matter

Every emitted character cap counted code points as `[...v].length`, which allocates an array of
code points on the path every ordinary row takes. A UTF-16 unit count is free and is never smaller
than a code-point count, since only a surrogate pair spends two units on one code point, so a
string already short enough in units cannot be too long in characters:

```ts
// before
.refine((v) => [...v].length <= 64, { message: 'at most 64 characters' })
// after
.refine((v) => v.length <= 64 || [...v].length <= 64, { message: 'at most 64 characters' })
```

Measured on real emitted output, validating a whole five-column row rather than a lone field, with
the two modules differing in exactly that one expression: zod `1646k/s` to `6925k/s`, 4.2x; TypeBox
on the compiled path `2098k/s` to `31856k/s`, 15.2x. Both accepted exactly the same rows. On the
check alone at a cap of 64, ordinary ASCII rows go `23171k/s` to `215029k/s`, and rows sitting at
the cap `4250k/s` to `235657k/s`.

The same rewrite applies to every length `CHECK` the parser reads, in the direction each operator
allows: a cap short-circuits on the accept side, a minimum on the reject side, `=` on the reject
side and `<>` on the accept side. Which rewrite is sound for which operator is now decided once, in
`codePointCompare`, rather than in the five generators that each had their own operator table.

Nothing changes about what is accepted. The equivalence is asserted rather than argued: every
operator is evaluated against the bare spread over astral pairs, combining marks, a lone surrogate,
the empty string and CJK at the bound, and then over a 4000-string pseudo-random pool, 24000
comparisons in all.
