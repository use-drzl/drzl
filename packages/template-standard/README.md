<div align="center">

# @drzl/template-standard

<div align="center">

[![CI](https://github.com/use-drzl/drzl/actions/workflows/ci.yml/badge.svg)](https://github.com/use-drzl/drzl/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40drzl%2Ftemplate-standard)](https://www.npmjs.com/package/@drzl/template-standard)

</div>

Minimal oRPC router template (no service wiring), great for quick starts.

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

Reference from the oRPC generator:

```ts
generators: [{ kind: 'orpc', template: '@drzl/template-standard' }];
```

## Hooks (template API)

- filePath(table, ctx)
- routerName(table, ctx)
- procedures(table)
- imports?(), prelude?(), header?(table)
