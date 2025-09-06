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
  ],
});
```

## Switch libraries

Change `validation.library` to `valibot` or `arktype` and the generator will adapt input/output wiring accordingly.
