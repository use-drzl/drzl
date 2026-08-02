---
'@drzl/generator-valibot': minor
'@drzl/cli': minor
---

`typedColumns` for the valibot generator.

It shipped for zod and TypeBox. Valibot had no schema-import machinery at all, so this adds it
along with the narrowing itself.

```ts
role: v.pipe(v.string(), v.transform((x) => x as (typeof users.$inferSelect)['role'])),
```

Valibot has no equivalent of TypeBox's `Type.Unsafe`, so the reference is appended as an identity
transform: the value passes through unchanged and only `InferOutput` sees the narrower type. Every
action the schema carried still runs, which the tests assert by parsing values through it rather
than by reading the emitted text, and the transform is appended after the nullable and optional
wrappers so neither is disturbed.

Verified end to end through the CLI: a `text().$type<'admin' | 'member'>()` column produces output
where assigning `'nope'` is a compile error and `'admin'` is not.

That leaves ArkType as the one generator without it, and it is not an oversight: it emits one
string per field, and a TypeScript type reference has nowhere to live inside a string DSL.
