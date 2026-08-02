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

Change `validation.library` to `valibot` or `arktype` and the generator will adapt input/output wiring accordingly.

::: tip Need something else?
If this example doesn't cover what you need, DM me on X (https://x.com/omardulaimidev) and we can scope it together.
:::
