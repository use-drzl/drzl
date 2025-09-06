<div align="center">

# @drzl/template-orpc-service

<div align="center">

[![CI](https://github.com/use-drzl/drzl/actions/workflows/ci.yml/badge.svg)](https://github.com/use-drzl/drzl/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40drzl%2Ftemplate-orpc-service)](https://www.npmjs.com/package/@drzl/template-orpc-service)

</div>

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

