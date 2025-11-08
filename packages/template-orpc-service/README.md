<div align="center">

# @drzl/template-orpc-service

<div align="center">

[![CI](https://github.com/use-drzl/drzl/actions/workflows/ci.yml/badge.svg)](https://github.com/use-drzl/drzl/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40drzl%2Ftemplate-orpc-service)](https://www.npmjs.com/package/@drzl/template-orpc-service)

</div>

oRPC router template wired to the generated Service layer.

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
generators: [
  {
    kind: 'orpc',
    template: '@drzl/template-orpc-service',
    validation: { library: 'valibot' },
    databaseInjection: {
      enabled: true,
      databaseType: 'Database',
      databaseTypeImport: { name: 'Database', from: 'src/db/db' },
    },
    servicesDir: 'src/services',
  },
];
```

## Hooks (template API)

- filePath(table, ctx)
- routerName(table, ctx)
- procedures(table)
- imports?(tables, ctx)
- header?(table)

When `databaseInjection.enabled` is true, the template emits a `dbMiddleware` and expects `context.db` to be provided by your runtime (e.g., Cloudflare Workers via D1).
