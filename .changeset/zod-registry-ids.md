---
'@drzl/validation-core': minor
'@drzl/generator-zod': minor
'@drzl/cli': minor
---

Add `meta: { registryIds: true }` to the zod generator, which gives each emitted schema an `id` and
so puts it in zod's registry under a name.

```ts
{ kind: 'zod', path: './src/validators/zod', meta: { registryIds: true } }
```

Two things follow, both measured against zod 4.4.3. A schema that references another emits
`$ref: '#/$defs/usersSelect'` rather than a second copy of it, and the whole registry converts in one
call keyed by those names:

```ts
z.toJSONSchema(z.globalRegistry);
// { schemas: { usersInsert: { … }, usersUpdate: { … }, usersSelect: { … } } }
```

which is the shape an OpenAPI `components.schemas` block wants. That is what "self-describing"
means here: a consumer holding the emitted modules can produce a named document without being told
what anything is called.

**The id is built from the qualified table name**, through a new `metaSchemaId` in
`@drzl/validation-core`, so `reporting.users` becomes `reporting_usersSelect` while a table in the
default schema keeps the short `usersSelect`. That is not tidiness. Two schemas sharing an id do not
report the collision: measured, `z.toJSONSchema(registry)` keeps the last one and **silently drops
the other**. Two tables, one entry, no warning, and nothing a consumer can check. Any schema
declaring two SQL schemas can produce that collision, because `table.name` is the bare name.

It is a separate flag from `meta: true` because it is the only metadata key with a failure mode.
Everything else `meta` writes is inert data a consumer may ignore.

Off by default, so no existing output changes.
