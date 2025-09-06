# Configuration

DRZL reads a `drzl.config.ts` that describes your schema path and generators.

```ts
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: 'src/db/schemas/index.ts',
  outDir: 'src/api',
  analyzer: { includeRelations: true, validateConstraints: true },
  generators: [
    { kind: 'zod', path: 'src/validators/zod', schemaSuffix: 'Schema' },
    {
      kind: 'service',
      path: 'src/services',
      dataAccess: 'drizzle',
      dbImportPath: 'src/db/connection',
      schemaImportPath: 'src/db/schemas',
    },
    {
      kind: 'orpc',
      template: '@drzl/template-orpc-service',
      includeRelations: true,
      naming: { routerSuffix: 'Router', procedureCase: 'kebab' },
      validation: {
        useShared: true,
        library: 'zod',
        importPath: 'src/validators/zod',
        schemaSuffix: 'Schema',
      },
    },
  ],
});
```

## Config File Formats

DRZL accepts multiple config formats:

- TypeScript: `drzl.config.ts`
- ES Module: `drzl.config.mjs`
- CommonJS: `drzl.config.js`
- JSON: `drzl.config.json`

When using JSON, ensure it’s strict JSON (no comments/trailing commas). TS/JS configs can export either a default object or use `defineConfig(...)`.

See package READMEs for generator‑specific options.
