# Service Generator

Generates typed CRUD service classes per table (Drizzle or stub).

Key options:

- `outDir`, `dataAccess`, `dbImportPath`, `schemaImportPath`

See the [package README](https://github.com/use-drzl/drzl/blob/master/packages/generator-service/README.md) for details.

## Examples

### Drizzle mode

```ts
export default defineConfig({
  schema: 'src/db/schemas/index.ts',
  generators: [
    {
      kind: 'service',
      path: 'src/services',
      dataAccess: 'drizzle',
      dbImportPath: 'src/db/connection',
      schemaImportPath: 'src/db/schemas',
    },
  ],
});
```

Produces services using `table.$inferSelect` / `$inferInsert` types and CRUD methods.

### Stub mode

```ts
export default defineConfig({
  generators: [{ kind: 'service', path: 'src/services', dataAccess: 'stub' }],
});
```

Stubs return sample values for quick prototyping.

## Generated Output License

- You own the generated output. DRZL grants you a worldwide, royalty‑free, irrevocable license to use, copy, modify, and distribute the generated files under your project’s license.
- A short header is added by default. Configure via `outputHeader` in `drzl.config.ts`:
  - `outputHeader.enabled = false` to disable
  - `outputHeader.text = '...'` to customize
