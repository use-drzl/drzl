---
'@drzl/generator-zod': patch
---

A date column says what it accepts, instead of reporting `unknown`

The coercing spelling for a date column was a `z.preprocess`, which accepts anything, so
`z.input<typeof InsertusersSchema>` reported `unknown` for that column. Every consumer that reads a
schema's input type got nothing from it, and zod was the outlier: valibot and ArkType already
reported `string | number | Date` for the same column.

It is now a union of the three input types it really takes:

```ts
publishedAt: z.union([
  z.date(),
  z.number().transform((v) => new Date(v)).pipe(z.date()),
  z.string().regex(/.../).transform((v) => new Date(v)).pipe(z.date()),
]),
```

Behaviour is unchanged, measured over eighteen values rather than argued: a real Date, an ISO
string, a date-only string, an epoch number, `0`, `'12.5'`, `'0101'`, `'010'`, `'1'`, `'hello'`,
`null`, `true`, `[1, 2]`, `undefined`, `NaN`, an Invalid Date, a string that parses to an Invalid
Date, and a plain object. Identical verdicts on every one. The `.pipe(z.date())` after each
transform is what keeps the last two identical: without it a string the pattern admits but
`new Date` cannot read would come back as an Invalid Date, where the `z.date()` behind the old
preprocess refused it.

What this does not do, measured rather than hoped: it does not remove the validator cast in the
TanStack Form recipe. That constraint holds the input type in a property, so the check is invariant
and a wider input is rejected exactly as a narrower one would be. The docs grid is corrected to say
so, and the row it does improve is the one where `defaultValues` is cast to the schema's input:
that state is now `string | number | Date` in all three libraries rather than `unknown` in zod.
