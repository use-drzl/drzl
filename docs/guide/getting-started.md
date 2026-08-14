# Getting Started

Get up and running in seconds, with no global installs required.

Prereqs

- Node.js ≥ 22
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

- Eighteen generators emit routers or an API surface, and each is its own generator rather than a
  template: oRPC, tRPC, Hono, Express, Fastify, NestJS, GraphQL, Pothos, MCP, Next.js, the AI SDK,
  TanStack Start, h3, Effect HttpApi, ts-rest, openapi-fetch, forms and Elysia. Only oRPC takes
  templates, which is why the step above installs one. See [Adapters](/adapters/overview) for which
  to reach for.
- You do not install generators. All twenty-seven are dependencies of `@drzl/cli`, so the install in
  step 1 already brought every one of them. What you may need is the **validation library itself**,
  in your own app: `zod`, `valibot`, `arktype`, `@sinclair/typebox` or `effect`, since the generated
  files import from it. `effect` is an optional peer and is never installed for you; see
  [Effect](/generators/effect#which-effect) for why.
- Config file formats supported: `drzl.config.ts`, `.mjs`, `.js`, `.json`.

Next steps

- CLI commands → [/cli](/cli)
- Config reference → [/guide/configuration](/guide/configuration)
- Recipes → [/examples/recipes](/examples/recipes)
- Something failed → [/guide/troubleshooting](/guide/troubleshooting)
- Adapters → [/adapters/overview](/adapters/overview)
- Hosting on Supabase/Neon, PlanetScale or Cloudflare D1? → provider quickstarts for
  [Postgres](/quickstarts/supabase-neon), [MySQL](/quickstarts/planetscale) and
  [SQLite](/quickstarts/cloudflare-d1)
