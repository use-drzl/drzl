# Validation Mix Example

You can mix validation libraries across generators or reuse shared schemas in oRPC.

## Separate validators, shared in oRPC

```ts
export default defineConfig({
  schema: 'src/db/schemas/index.ts',
  outDir: 'src/api',
  generators: [
    { kind: 'zod', path: 'src/validators/zod', schemaSuffix: 'Schema' },
    { kind: 'valibot', path: 'src/validators/valibot', schemaSuffix: 'Schema' },
    {
      kind: 'orpc',
      template: '@drzl/template-orpc-service',
      validation: {
        useShared: true,
        library: 'zod',
        importPath: 'src/validators/zod',
        schemaSuffix: 'Schema',
      },
    },
    // Required by the template above, which emits routers that delegate to a service layer.
    // Without it the routers import modules nothing ever writes.
    { kind: 'service', path: 'src/services' },
  ],
});
```

## Switch libraries

Change `validation.library` to `valibot` or `arktype` and the generator will adapt input/output wiring accordingly. Effect is not available here yet, though unlike TypeBox it has a route to one: `Schema.standardSchemaV1` produces a real Standard Schema and the [Effect generator](/generators/effect#two-forms-per-schema-and-why) emits it, so wiring it in is a change to the router generators rather than a dead end. TypeBox is not available here: see [TypeBox → Why it cannot back an oRPC router](/generators/typebox#why-it-cannot-back-an-orpc-router). Neither is `json-schema`, for the same reason: a router types its input and output as a Standard Schema, and a plain JSON Schema is data rather than a validator. Add a [`json-schema` generator](/generators/json-schema) alongside if you also want a document to publish.

::: tip Need something else?
If this example doesn't cover what you need, DM me on X (https://x.com/omardulaimidev) and we can scope it together.
:::
