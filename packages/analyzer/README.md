<div align="center">

# @drzl/analyzer

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
