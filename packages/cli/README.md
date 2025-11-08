<div align="center">

# @drzl/cli

<div align="center">

[![CI](https://github.com/use-drzl/drzl/actions/workflows/ci.yml/badge.svg)](https://github.com/use-drzl/drzl/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40drzl%2Fcli)](https://www.npmjs.com/package/@drzl/cli)

</div>

Analyze your Drizzle schema and generate validation, services, and routers.

</div>

## 💚 Sponsor DRZL

<div align="center">

<strong>DRZL is crafted nights & weekends. Sponsorships keep the generators fast, tested, and free.</strong>

[![Sponsor DRZL](https://img.shields.io/badge/GitHub%20Sponsors-Support%20the%20project-ff69b4?logo=github)](https://github.com/sponsors/omar-dulaimi)

</div>

- Every dollar speeds up CI hardware and offsets long test runs on my aging laptop.
- Sponsors get roadmap input and priority responses in GitHub Issues.
- Prefer a quick overview? Check `docs/sponsor.md` for the current goals and thank-yous.

## Commands

- Init: `pnpm dlx @drzl/cli init`
- Analyze: `pnpm dlx @drzl/cli analyze <schema.ts> [--relations] [--validate]`
- Generate: `pnpm dlx @drzl/cli generate -c drzl.config.ts`
- Watch: `pnpm dlx @drzl/cli watch -c drzl.config.ts`

## Minimal config

```ts
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

Notes

- `format.engine: 'auto'` tries Prettier, then Biome.
