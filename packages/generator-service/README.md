<div align="center">

# @drzl/generator-service

Typed CRUD service classes per table — Drizzle‑aware or stubbed.

</div>

## Use

Add to `drzl.config.ts`:

```ts
generators: [
  { kind: 'service', path: 'src/services', dataAccess: 'drizzle', dbImportPath: 'src/db/connection', schemaImportPath: 'src/db/schemas' },
]
```

## Notes

- In drizzle mode, uses `$inferSelect` / `$inferInsert` for end‑to‑end types.
- `Update<T>` is derived from `Insert<T>` with PKs omitted and fields partial.
