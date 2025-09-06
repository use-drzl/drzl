# Relations Example

Enable `includeRelations` to generate relation endpoints in oRPC routers.

```ts
export default defineConfig({
  schema: 'src/db/schemas/index.ts',
  outDir: 'src/api',
  generators: [{ kind: 'orpc', includeRelations: true }],
});
```

This will add endpoints like `listByParentId`, `listChildren`, or similar, depending on your template’s `procedures` definitions.

Tip: ensure foreign keys and joining table metadata are present in your Drizzle schema so analyzer can infer relations.
