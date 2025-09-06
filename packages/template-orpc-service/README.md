<div align="center">

# @drzl/template-orpc-service

oRPC router template wired to the generated Service layer.

</div>

## Use

Reference from the oRPC generator:

```ts
generators: [
  {
    kind: 'orpc',
    template: '@drzl/template-orpc-service',
    validation: { useShared: true, library: 'zod', importPath: 'src/validators/zod' },
  },
]
```

## Hooks (template API)

- filePath(table, ctx)
- routerName(table, ctx)
- procedures(table)
- imports?(tables, ctx)
- header?(table)

