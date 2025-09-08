# Getting Started

Get up and running in seconds — no global installs required.

Prereqs

- Node.js ≥ 18.17 (LTS or newer)
- A Drizzle schema (TypeScript)

1. Install the CLI

Add DRZL CLI to your project (no globals needed):

::: code-group

```bash [pnpm]
pnpm add -D @drzl/cli
```

```bash [npm]
npm i -D @drzl/cli
```

```bash [yarn]
yarn add -D @drzl/cli
```

```bash [bun]
bun add -d @drzl/cli
```

:::

2. One complete example (oRPC + Zod + Service)

Add a single config to generate Zod validators and oRPC routers that reuse them, plus typed services:

```ts
// drzl.config.ts
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: 'src/db/schemas/index.ts',
  outDir: 'src/api',
  generators: [
    // 1) Zod validators
    { kind: 'zod', path: 'src/validators/zod', schemaSuffix: 'Schema' },

    // 2) Routers (oRPC adapter), reusing Zod schemas
    {
      kind: 'orpc',
      template: '@drzl/template-orpc-service',
      includeRelations: true,
      outputHeader: { enabled: true },
      validation: {
        useShared: true,
        library: 'zod',
        importPath: 'src/validators/zod',
        schemaSuffix: 'Schema',
      },
    },
    // 3) Typed services (Drizzle-aware or stub)
    {
      kind: 'service',
      path: 'src/services',
      dataAccess: 'drizzle', // or 'stub'
      dbImportPath: 'src/db/connection',
      schemaImportPath: 'src/db/schemas',
    },
  ],
});
```

3. Install Templates

The CLI comes with all the generators you need. You only need to install any templates you want to use. For this example, we'll install the oRPC service template:

::: code-group

```bash [pnpm]
pnpm add -D @drzl/template-orpc-service
```

```bash [npm]
npm i -D @drzl/template-orpc-service
```

```bash [yarn]
yarn add -D @drzl/template-orpc-service
```

```bash [bun]
bun add -d @drzl/template-orpc-service
```

:::

4. Generate:

::: code-group

```bash [pnpm]
pnpm dlx @drzl/cli generate -c drzl.config.ts
```

```bash [npm]
npx @drzl/cli generate -c drzl.config.ts
```

```bash [yarn]
yarn dlx @drzl/cli generate -c drzl.config.ts
```

```bash [bun]
bunx @drzl/cli generate -c drzl.config.ts
```

:::

This writes validators to `src/validators/zod`, routers to `src/api`, and services to `src/services`.

Notes

- Router generation is adapter‑based (currently oRPC). Additional adapters (tRPC, Express, NestJS, Next.js, Prisma, etc.) can be added via templates.
- For Zod/Valibot/ArkType or Service generators, install the matching package in your app (as shown above).
- Config file formats supported: `drzl.config.ts`, `.mjs`, `.js`, `.json`.

Next steps

- CLI commands → [/cli](/cli)
- Config reference → [/guide/configuration](/guide/configuration)
- Adapters → [/adapters/overview](/adapters/overview)
