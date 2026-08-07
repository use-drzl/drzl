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

Change `validation.library` to `valibot` or `arktype` and the generator will adapt input/output wiring accordingly. Effect and TypeBox are not available here yet, and neither is a dead end: Effect's [`Schema.standardSchemaV1`](/generators/effect#two-forms-per-schema-and-why) produces a real Standard Schema and the Effect generator emits it, and TypeBox's [`standardSchema` option](/generators/typebox#standardschema) attaches one to every schema it writes. Both back a tRPC or oRPC route you write yourself. What is missing in both cases is a dialect in the router generators, which invent arguments such as a lookup by primary key and can only spell them in zod, valibot or arktype today. Neither is `json-schema`, for the same reason: a router types its input and output as a Standard Schema, and a plain JSON Schema is data rather than a validator. Add a [`json-schema` generator](/generators/json-schema) alongside if you also want a document to publish.

::: tip Need something else?
If this example doesn't cover what you need, DM me on X (https://x.com/omardulaimidev) and we can scope it together.
:::
