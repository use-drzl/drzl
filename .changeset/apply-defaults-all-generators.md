---
'@drzl/generator-arktype': minor
'@drzl/generator-valibot': minor
'@drzl/generator-typebox': minor
'@drzl/generator-zod': minor
'@drzl/cli': minor
---

`applyDefaults` for every generator, `typedColumns` for TypeBox, and three options that silently
did nothing.

### `applyDefaults` everywhere

It shipped for zod only. Each library states a default in its own way, and all four now do:

```ts
country: z.string().default("GB"),                        // zod
country: v.optional(v.string(), "GB"),                    // valibot
country: 'string = "GB"',                                 // arktype
country: Type.Optional(Type.String({ default: "GB" })),   // typebox
```

All four parse `{ name: 'x' }` into `{ name: 'x', country: 'GB', count: 0, flag: true }`, which is
the row Postgres writes for the same insert. Checked by running the emitted modules rather than by
reading them.

One difference worth knowing: TypeBox's `Value.Check` does **not** materialise a default, only
`Value.Parse` and `Value.Default` do. It separates validating from defaulting where zod and valibot
fold the two together.

### `typedColumns` for TypeBox

`Type.Unsafe<T>(schema)` wraps an existing schema, so every check it carries still runs and only
the inferred type is replaced:

```ts
role: Type.Unsafe<(typeof users.$inferSelect)['role']>(Type.String({ maxLength: 50 })),
```

That leaves ArkType as the one generator that cannot do this, and it is not an oversight: it emits
one string per field, and a TypeScript type reference has nowhere to live inside a string DSL.

### Three documented options that did nothing

Found while wiring the above, each confirmed by generating and reading the output rather than by
inspecting the code:

- **`typedJson` on a `typebox` generator was ignored.** The CLI never passed it, so a json column
  emitted the generic `DrzlJsonValue` no matter what the config said.
- **`coerceDates` was ignored by every generator.** It was documented on the zod generator, but the
  config schema had no such key, so `coerceDates: 'none'` parsed and was dropped. The output kept
  coercing.
- **`applyDefaults` reached only zod**, for the same reason, until the other three branches were
  given it.

Each generator branch in the CLI built its own options object by hand, so an option added to one
was simply absent from the others. All four now pass everything they support.
