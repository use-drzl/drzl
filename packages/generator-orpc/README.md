<div align="center">

# @drzl/generator-orpc

oRPC routers per table — with optional reuse of shared validation schemas.

</div>

## Use

Add to `drzl.config.ts`:

```ts
generators: [
  {
    kind: 'orpc',
    template: '@drzl/template-orpc-service',
    includeRelations: true,
    validation: { useShared: true, library: 'zod', importPath: 'src/validators/zod' },
  },
]
```

## Behavior

- Reuses pre-generated Insert/Update/Select schemas when `validation.useShared` is true.
- Otherwise, inlines schemas using the chosen library (zod/valibot/arktype).
- Works with templates for different wiring (service-backed, minimal, custom).

