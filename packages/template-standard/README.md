<div align="center">

# @drzl/template-standard

Minimal oRPC router template (no service wiring) — great for quick starts.

</div>

## Use

Reference from the oRPC generator:

```ts
generators: [
  { kind: 'orpc', template: '@drzl/template-standard' },
]
```

## Hooks (template API)

- filePath(table, ctx)
- routerName(table, ctx)
- procedures(table)
- imports?(), prelude?(), header?(table)

