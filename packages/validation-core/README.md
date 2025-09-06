<div align="center">

# @drzl/validation-core

Shared interfaces and helpers used by validation generators.

</div>

## Exports (essentials)

- ValidationLibrary: `'zod' | 'valibot' | 'arktype'`
- ValidationRenderer<TOptions>
  - `library`
  - `renderTable(table, opts)`
  - `renderIndex?(analysis, opts)`
- Helpers
  - `insertColumns(table)`, `updateColumns(table)`, `selectColumns(table)`
  - `formatCode(code, filePath, formatOpts)`

