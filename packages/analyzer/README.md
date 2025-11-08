<div align="center">

# @drzl/analyzer

<div align="center">

[![CI](https://github.com/use-drzl/drzl/actions/workflows/ci.yml/badge.svg)](https://github.com/use-drzl/drzl/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40drzl%2Fanalyzer)](https://www.npmjs.com/package/@drzl/analyzer)

</div>

Drizzle schema → normalized analysis for fast, reliable codegen.

</div>

## 💚 Sponsor DRZL

<div align="center">

<strong>DRZL is crafted nights & weekends. Sponsorships keep the generators fast, tested, and free.</strong>

[![Sponsor DRZL](https://img.shields.io/badge/GitHub%20Sponsors-Support%20the%20project-ff69b4?logo=github)](https://github.com/sponsors/omar-dulaimi)

</div>

- Every dollar speeds up CI hardware and offsets long test runs on my aging laptop.
- Sponsors get roadmap input and priority responses in GitHub Issues.
- Prefer a quick overview? Check `docs/sponsor.md` for the current goals and thank-yous.

## Use

```ts
import { SchemaAnalyzer } from '@drzl/analyzer';

const analyzer = new SchemaAnalyzer('src/db/schemas/index.ts');
const analysis = await analyzer.analyze({
  includeRelations: true,
  validateConstraints: true,
});
```

The CLI consumes this analysis to generate validation, services, and routers.

## Output (high level)

- dialect, tables, columns, keys, indexes
- relations (incl. inferred), enums
- issues (warnings/errors) for constraints and shape

## Notes

- Best‑effort introspection aligned with Drizzle symbols across versions.
