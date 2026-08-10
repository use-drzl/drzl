<div align="center">

# @drzl/generator-orpc

<div align="center">

[![CI](https://github.com/use-drzl/drzl/actions/workflows/ci.yml/badge.svg)](https://github.com/use-drzl/drzl/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40drzl%2Fgenerator-orpc)](https://www.npmjs.com/package/@drzl/generator-orpc)

</div>

oRPC routers per table, with optional reuse of shared validation schemas.

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

## Use

Add to `drzl.config.ts`:

```ts
generators: [
  {
    kind: 'orpc',
    template: '@drzl/template-orpc-service',
    includeRelations: true,
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

## Behavior

- Reuses pre-generated Insert/Update/Select schemas when `validation.useShared` is true.
- Otherwise, inlines schemas using the chosen library (zod/valibot/arktype). TypeBox is not one of
  them: this generator invents arguments such as a lookup by primary key and has no TypeBox
  spelling for them. The Standard Schema half is no longer the obstacle, since
  `@drzl/generator-typebox`'s `standardSchema` option puts a real `~standard` on what it writes.
- Works with templates for different wiring (service-backed, minimal, custom). With `@drzl/template-orpc-service`, a `dbMiddleware` is emitted and `context.db` is passed to services.
