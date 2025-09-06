<div align="center">

# @drzl/analyzer

<div align="center">

[![CI](https://github.com/use-drzl/drzl/actions/workflows/ci.yml/badge.svg)](https://github.com/use-drzl/drzl/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40drzl%2Fanalyzer)](https://www.npmjs.com/package/@drzl/analyzer)

</div>

Drizzle schema → normalized analysis for fast, reliable codegen.

</div>

## Use

```ts
import { SchemaAnalyzer } from '@drzl/analyzer'

const analyzer = new SchemaAnalyzer('src/db/schemas/index.ts')
const analysis = await analyzer.analyze({
  includeRelations: true,
  validateConstraints: true,
})
```

The CLI consumes this analysis to generate validation, services, and routers.

## Output (high level)

- dialect, tables, columns, keys, indexes
- relations (incl. inferred), enums
- issues (warnings/errors) for constraints and shape

## Notes

- Best‑effort introspection aligned with Drizzle symbols across versions.
