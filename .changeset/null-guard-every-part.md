---
'@drzl/validation-core': patch
'@drzl/cli': patch
'@drzl/generator-arktype': patch
'@drzl/generator-effect': patch
'@drzl/generator-fast-check': patch
'@drzl/generator-json-schema': patch
'@drzl/generator-seed': patch
'@drzl/generator-typebox': patch
'@drzl/generator-valibot': patch
'@drzl/generator-zod': patch
---

Refuse a null guard unless every part of the predicate it guards names the guarded column

`col IS NULL OR P` reduces to `P` because a CHECK passes on NULL and the predicates this parser
keeps after a guard are NULL when their column is. That covers a part of `P` only if the part names
`col`. The test checked that `col` was named somewhere in `P`, so a conjunction where one part named
it and another did not was reduced anyway, and the other part became an unconditional rule on its
own column:

```ts
// check('hold_context', sql`${t.purpose} IS NULL OR (${t.kind} = 'hold' AND ${t.purpose} IN ('storage', 'settling'))`)
```

restricted `kind` to `'hold'` in every schema, so `{ kind: 'other', purpose: null }` was refused by
the schema and accepted by Postgres. The same happened with two guards in front of field rules that
each name only one of them, as in `a IS NULL OR b IS NULL OR (a > 0 AND b > 0)`.

Each part now has to name every guarded column. Where one does not, the constraint is refused whole,
as `a IS NULL OR b > 0` already was, and `drzl doctor` reports it. Guards whose every part names the
column and that hold no null test, including `a IS NULL OR a < b` and
`a IS NULL OR b IS NULL OR a < b`, still reduce as before. The test errs toward refusing: a part that
can never be FALSE, such as `length(b) >= 0`, is refused too.
