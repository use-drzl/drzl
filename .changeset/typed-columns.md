---
'@drzl/validation-core': minor
'@drzl/generator-zod': minor
'@drzl/cli': minor
---

`typedColumns`: take every column's static type from Drizzle, not just the untyped ones.

`.$type<T>()` is a compile-time cast on **any** column, not just json. Drizzle's implementation is
literally `$type() { return this }`, so `text().$type<'admin' | 'member'>()` is an ordinary string
to anything reading the column at runtime, and `drizzle-orm/zod` and DRZL alike emitted a plain
`z.string()` with the narrowing lost.

```ts
{ kind: 'zod', path: 'src/validators/zod', typedColumns: true }
```

```ts
role: z.string().max(50).pipe(z.custom<(typeof users.$inferSelect)['role']>()),
```

The runtime schema is untouched. The reference is appended rather than substituted, so a
`varchar(50)` keeps its length check and only its _type_ narrows, and a typo in
`if (user.role === 'admni')` becomes a compile error rather than dead code. Nothing narrows it at
runtime, because the cast leaves no trace there.

Appending happens after the nullable and optional wrappers, checked against zod rather than
assumed: `.pipe()` keeps a key optional both when parsing and in the inferred type. A json or
custom column still has its schema _replaced_ rather than appended to, since it has no runtime
type worth keeping.

Implies `typedJson`, since both need the schema imported back. Off by default: it adds a `.pipe()`
to every field, which is noise unless you use `.$type<T>()`.
