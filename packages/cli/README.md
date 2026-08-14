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
- Prefer a quick overview? The current goals and thank-yous are at
  https://use-drzl.github.io/drzl/sponsor.

## Commands

- Init: `pnpm dlx @drzl/cli init`
- Analyze: `pnpm dlx @drzl/cli analyze <schema.ts> [--relations] [--validate]`
- Explain: `pnpm dlx @drzl/cli explain <table>`, what DRZL understood about one table and what it did not
- Doctor: `pnpm dlx @drzl/cli doctor`, what DRZL cannot type or enforce in your schema, and why
- Generate: `pnpm dlx @drzl/cli generate -c drzl.config.ts`
- Watch: `pnpm dlx @drzl/cli watch -c drzl.config.ts`

All twenty-seven generators ship as dependencies of this package, so installing it is the only
install you need to run any of them.

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

- `format.engine: 'auto'` tries Prettier, then Biome. Both are your own: neither is bundled, and
  DRZL uses whichever it finds in your project, with your config. With neither installed the
  generated files are written exactly as rendered, which is the same valid TypeScript with worse
  whitespace. Add `prettier` as a dev dependency if you want it formatted.
- Naming an engine instead, `format.engine: 'prettier'` or `'biome'`, is a request rather than a
  preference, so an engine that cannot be loaded is reported on stderr with the reason. The files
  are still written, unformatted; nothing fails. `'auto'` stays silent, because it asked for
  whatever happened to be installed and no formatter is a legitimate answer to that.
