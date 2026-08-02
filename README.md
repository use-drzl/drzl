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
- Generators: Zod, Valibot, ArkType, TypeBox validation; JSON Schema and OpenAPI; typed CRUD services; router templates (oRPC)
- Batteries: formatting, naming, reusable/shared schemas, relation support
- Verified against real databases every commit: 1365 type probes and 53 CHECK probes against Postgres
  (PGlite), 32 against SQLite (`node:sqlite`), and 37 against MySQL (a CI service container).
  On the CHECK probes DRZL accepts 0 rows the database rejects; `drizzle-orm/zod` accepts 22
- Monorepo: pnpm workspace, lockstep releases with Changesets

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
- `packages/generator-service`: typed service generator
- `packages/generator-zod`: Zod generator
- `packages/generator-valibot`: Valibot generator
- `packages/generator-arktype`: ArkType generator
- `packages/generator-typebox`: TypeBox generator
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
