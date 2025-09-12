<div align="center">

# @drzl/template-standard

<div align="center">

[![CI](https://github.com/use-drzl/drzl/actions/workflows/ci.yml/badge.svg)](https://github.com/use-drzl/drzl/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40drzl%2Ftemplate-standard)](https://www.npmjs.com/package/@drzl/template-standard)

</div>

Minimal oRPC router template (no service wiring) — great for quick starts.

</div>

## Use

Reference from the oRPC generator:

```ts
generators: [{ kind: 'orpc', template: '@drzl/template-standard' }];
```

## Hooks (template API)

- filePath(table, ctx)
- routerName(table, ctx)
- procedures(table)
- imports?(), prelude?(), header?(table)
