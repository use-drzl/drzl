<p align="center">
  <img src="docs/public/banner.png" alt="DRZL: Zero‑friction codegen for Drizzle ORM" width="1200" />

</p>

<div align="center">

# DRZL

Zero‑friction codegen for Drizzle ORM. Analyze your schema. Generate validation, services, and routers fast.

<br/>

<p align="center">
  <a href="https://github.com/use-drzl/drzl/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/use-drzl/drzl/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://www.npmjs.com/package/@drzl/cli"><img alt="npm" src="https://img.shields.io/npm/v/%40drzl%2Fcli" /></a>
  <a href="https://pnpm.io"><img alt="pnpm" src="https://img.shields.io/badge/pnpm-workspace-4B37A5?logo=pnpm&logoColor=white" /></a>
  <img alt="typescript" src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white" />
  <img alt="node" src="https://img.shields.io/badge/Node-22%2B-339933?logo=node.js&logoColor=white" />
</p>

</div>

## Sponsor

- GitHub Sponsors: https://github.com/sponsors/omar-dulaimi
- Want something prioritized? Look for issues labeled `sponsor-wanted` (or open one) and DM @omardulaimidev so we can reserve it for you.
- Custom template/generator/adapter requests happen via X DM. Paid work ships back into DRZL so everyone benefits.

## What’s Inside

- Analyzer: turns Drizzle schemas into a normalized analysis model
- Generators: Zod, Valibot, ArkType, TypeBox and Effect Schema validation; JSON Schema and OpenAPI;
  typed CRUD services; routers for oRPC, tRPC, Hono, Express, Fastify, NestJS and GraphQL; and an
  MCP server whose tools carry the table's CHECK constraints into what a model is allowed to write.
  Fourteen in all, and installing `@drzl/cli` brings every one of them
- Batteries: formatting, naming, reusable/shared schemas, relation support
- Monorepo: pnpm workspace, lockstep releases with Changesets

### Verified against three real databases

Postgres in-process via PGlite, SQLite via `node:sqlite`, and MySQL as a CI service container, on
every commit. The run behind this README printed:

```
    1476 probes against a real Postgres (41 columns)
    59 CHECK probes against a real Postgres (15 constrained columns)
    rows Postgres rejects and the validator accepts: DRZL 0, drizzle-orm 24
    32 CHECK probes against a real SQLite (10 constrained columns)
    37 probes against a real MySQL
```

Those lines are compared against the run itself, line by line, by
`scripts/verify/stages/35-docs-numbers.sh`, so a number here that stops being true fails the build
rather than sitting in a README nobody rechecks. See [how it is
verified](https://use-drzl.github.io/drzl/guide/verification).

## Install & Use

- Install the CLI and init a config

```bash
pnpm add @drzl/cli -D
pnpm drzl init
```

- Generate code

```bash
pnpm drzl generate -c drzl.config.ts
```

Minimal config

```ts
// drzl.config.ts
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: 'src/db/schemas/index.ts',
  outDir: 'src/api',
  generators: [
    { kind: 'zod', path: 'src/validators/zod' },
    { kind: 'service', path: 'src/services', dataAccess: 'drizzle' },
    { kind: 'orpc', template: '@drzl/template-orpc-service' },
  ],
});
```

Runtime

- ESM / ES2021 output
- Node ≥ 22 for the `drzl` CLI, which is what its own dependencies require
- Node ≥ 18.17 for the generator and template libraries, if you call them directly

## Packages

- `packages/analyzer`: schema analysis
- `packages/cli`: CLI (`drzl`)
- `packages/generator-orpc`: oRPC router generator
- `packages/generator-trpc`: tRPC v11 router generator
- `packages/generator-hono`: Hono route generator
- `packages/generator-express`: Express 5 router generator
- `packages/generator-fastify`: Fastify 5 plugin generator
- `packages/generator-nestjs`: NestJS DTO and entity class generator
- `packages/generator-graphql`: GraphQL SDL and resolver-stub generator\n- `packages/generator-effect-http`: Effect Platform HttpApi generator\n- `packages/generator-h3`: h3 and Nitro route handler generator
- `packages/generator-ai`: AI SDK tool generator\n- `packages/generator-mcp`: Model Context Protocol tool generator\n- `packages/generator-next`: Next.js server action generator\n- `packages/generator-tanstack-start`: TanStack Start server function generator
- `packages/generator-service`: typed service generator
- `packages/generator-zod`: Zod generator
- `packages/generator-valibot`: Valibot generator
- `packages/generator-arktype`: ArkType generator
- `packages/generator-typebox`: TypeBox generator
- `packages/generator-effect`: Effect Schema generator
- `packages/generator-json-schema`: JSON Schema and OpenAPI generator
- `packages/validation-core`: shared validation utilities
- `packages/template-orpc-service`: oRPC router template (service‑backed)
- `packages/template-standard`: minimal oRPC router template

See each package’s README for details.

## Development

- Install: `pnpm install`
- Build: `pnpm -r run build`
- Test: `pnpm -r test`
- Lint: `pnpm lint`

## Examples

Runnable applications live in `examples/`. They are workspace members that depend on the
workspace copy of `@drzl/cli`, so `pnpm build` and `pnpm -r test` cover them and a regression in a
generator breaks them.

- [`examples/nextjs-server-actions`](examples/nextjs-server-actions): a Drizzle schema,
  `drzl generate`, and the emitted zod schemas validating what a form posts to a Next.js server
  action, with field errors attributed to the constraint that caused them.

## Docs

VitePress site lives in `docs/` (kept out of releases). Local dev:

```bash
pnpm -C docs dev
```

## Funded Features

- _None yet. Be the first!_ If you need a template, generator, or adapter that doesn’t exist yet, DM me on X (https://x.com/omardulaimidev) and we can scope a sponsored build. Funded work lands in this repo under Apache‑2.0 so everyone benefits.

## Contributing

Contributions welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

Apache-2.0
