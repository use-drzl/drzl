<div align="center">

# @drzl/generator-service

<div align="center">

[![CI](https://github.com/use-drzl/drzl/actions/workflows/ci.yml/badge.svg)](https://github.com/use-drzl/drzl/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40drzl%2Fgenerator-service)](https://www.npmjs.com/package/@drzl/generator-service)

</div>

Typed CRUD service classes per table — Drizzle‑aware or stubbed.

</div>

## Use

Add to `drzl.config.ts`:

```ts
generators: [
  {
    kind: 'service',
    path: 'src/services',
    dataAccess: 'drizzle',
    schemaImportPath: 'src/db/schema',
    databaseInjection: {
      enabled: true,
      databaseType: 'Database',
      databaseTypeImport: { name: 'Database', from: 'src/db/db' }
    }
  },
]
```

## Notes

- In drizzle mode, uses `$inferSelect` / `$inferInsert` for end‑to‑end types.
- `Update<T>` is derived from `Insert<T>` with PKs omitted and fields partial.
- `databaseInjection` makes services accept `db: Database` (or your chosen type) instead of importing a global singleton — ideal for serverless runtimes.
