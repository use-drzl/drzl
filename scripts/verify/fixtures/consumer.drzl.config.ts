export default {
  schema: './src/db/schema.ts',
  outDir: './src/generated/api',
  generators: [
    { kind: 'zod', path: './src/generated/zod' },
    { kind: 'valibot', path: './src/generated/valibot' },
    { kind: 'arktype', path: './src/generated/arktype' },
    { kind: 'service', path: './src/generated/services' },
    // template-orpc-service on purpose, not the default. The default template imports nothing
    // that DRZL generated, so running only that one exercised no cross-module specifier and
    // missed the service import being emitted bare and extensionless.
    { kind: 'orpc', template: '@drzl/template-orpc-service', includeRelations: true },
    // Its own `path`, because oRPC claims `outDir`. The service template and the shared-schema
    // option are what put this tree through the specifier sweep below, which is the only stage
    // that compiles the emitted `.js` imports the way a consumer's compiler will under bundler,
    // node16 and nodenext.
    //
    // No `databaseInjection` here, and the reason is a real constraint rather than an omission.
    // Injection is a contract between a router and a service: the router emits
    // `Service.get(ctx.db, id)` and only a service generated in the same mode takes that
    // parameter. There is one service generator in this config and two routers, and oRPC above
    // does not inject, so no single service can satisfy both. Setting it here emitted ten
    // TS2554s. The config also runs `dataAccess: 'stub'`, whose bodies take no database whatever
    // the flag says, which the CLI warns about. Injection is covered by the generator's own
    // tests; what this entry is here for is the specifier sweep.
    { kind: 'effect', path: './src/generated/effect' },
    {
      kind: 'trpc',
      path: './src/generated/trpc',
      template: 'service',
      includeRelations: true,
      validation: { useShared: true },
    },
  ],
};
