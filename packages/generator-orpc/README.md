<div align="center">

# @drzl/generator-orpc

<div align="center">

[![CI](https://github.com/use-drzl/drzl/actions/workflows/ci.yml/badge.svg)](https://github.com/use-drzl/drzl/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40drzl%2Fgenerator-orpc)](https://www.npmjs.com/package/@drzl/generator-orpc)

</div>

oRPC routers per table — with optional reuse of shared validation schemas.

</div>

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
- Otherwise, inlines schemas using the chosen library (zod/valibot/arktype).
- Works with templates for different wiring (service-backed, minimal, custom). With `@drzl/template-orpc-service`, a `dbMiddleware` is emitted and `context.db` is passed to services.
