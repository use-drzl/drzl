<div align="center">

# @drzl/cli

<div align="center">

[![CI](https://github.com/use-drzl/drzl/actions/workflows/ci.yml/badge.svg)](https://github.com/use-drzl/drzl/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40drzl%2Fcli)](https://www.npmjs.com/package/@drzl/cli)

</div>

Analyze your Drizzle schema and generate validation, services, and routers.

</div>

## Commands

- Init: `drzl init`
- Analyze: `drzl analyze <schema.ts> [--relations] [--validate]`
- Generate: `drzl generate -c drzl.config.ts`
- Watch: `drzl watch -c drzl.config.ts`

## Minimal config

```ts
import { defineConfig } from '@drzl/cli/config'

export default defineConfig({
  schema: 'src/db/schemas/index.ts',
  outDir: 'src/api',
  generators: [
    { kind: 'zod', path: 'src/validators/zod' },
    { kind: 'service', path: 'src/services', dataAccess: 'drizzle' },
    { kind: 'orpc', template: '@drzl/template-orpc-service' },
  ],
})
```

Notes

- `format.engine: 'auto'` tries Prettier, then Biome.
