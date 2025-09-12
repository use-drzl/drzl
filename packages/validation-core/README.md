<div align="center">

# @drzl/validation-core

<div align="center">

[![CI](https://github.com/use-drzl/drzl/actions/workflows/ci.yml/badge.svg)](https://github.com/use-drzl/drzl/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40drzl%2Fvalidation-core)](https://www.npmjs.com/package/@drzl/validation-core)

</div>

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
