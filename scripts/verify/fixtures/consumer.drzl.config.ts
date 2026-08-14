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
    // The MCP server, on the shared schemas, which is the combination the constraint story
    // depends on: the bounds a model reads come from the zod generator's output above, and this
    // entry is what proves that import resolves in a real install rather than only in this
    // repository's workspace.
    // The Next.js actions, on the same shared schemas. The import path is *not* set here on
    // purpose: deriving it from the zod entry above is wiring only `nextOptions` does, and a
    // fixture that spelled it out would never exercise that.
    { kind: 'next', path: './src/generated/next' },
    // TanStack Start server functions, with the import path derived from the zod entry above
    // rather than spelled out, which is wiring only `tanstackStartOptions` does.
    { kind: 'tanstack-start', path: './src/generated/tanstack-start' },
    // h3 v1, which is what released Nitro depends on, so this compiles the adapter.
    { kind: 'h3', path: './src/generated/h3' },
    // Effect HttpApi, on the effect schemas the config already generates above.
    { kind: 'effect-http', path: './src/generated/effect-http' },
    // Seed rows, which read the CHECK constraints directly and import from no validation
    // generator at all: this is the one generator whose output depends on nothing but the analysis.
    { kind: 'seed', path: './src/generated/seed' },
    // fast-check arbitraries, from the same constraint reading as the seed entry above. This is
    // the entry that puts `noNaN` through a real install: fast-check is a peer of the emitted
    // modules, not of the generator, so nothing here resolves it except a consumer's own install.
    { kind: 'fast-check', path: './src/generated/arbitraries' },
    // Elysia on the zod schemas, with the import path derived from the zod entry above rather
    // than spelled out, which is wiring only `elysiaOptions` does.
    //
    // Deliberately not TypeBox, though Elysia is the one router whose validator slot accepts one.
    // TypeBox ships separate `.d.ts` and `.d.mts` declarations branded with distinct unique
    // symbols and Elysia's types are declared as CommonJS, so under node16 and nodenext the two
    // resolve to different copies and the schema is not assignable. This stage compiles under all
    // three resolutions, so the combination it covers is the one that works everywhere. The
    // TypeBox path has its own compile case, and its own must-fire test for the incompatibility,
    // in the generator's suite.
    { kind: 'elysia', path: './src/generated/elysia' },
    // The ts-rest contract, on the zod schemas, with the import path derived from the zod entry
    // above rather than spelled out, which is wiring only `tsRestOptions` does. This is also the
    // entry that puts a release-candidate peer through a real npm install: @ts-rest/core's `latest`
    // is 3.52.1, which peers on zod 3 and cannot share a tree with the zod 4 this config emits.
    { kind: 'ts-rest', path: './src/generated/ts-rest' },
    // The openapi-fetch client, on the same zod schemas. This is the entry that compiles the
    // emitted `paths` type against real openapi-fetch through a real npm install, which is the
    // only place the client and the document it is derived from are built by the same run.
    { kind: 'openapi-fetch', path: './src/generated/openapi-fetch' },
    // The form resolvers and field metadata, on the same zod schemas, emitting both targets so the
    // react-hook-form resolver and the TanStack Form options are both compiled by the consumer.
    { kind: 'forms', path: './src/generated/forms', target: 'both' },
    // The Pothos builder, which reads nothing from a validation generator: its object types are
    // checked against row interfaces it writes itself. This entry is what proves @pothos/core and
    // graphql resolve from a real install rather than only from this workspace.
    { kind: 'pothos', path: './src/generated/pothos' },
    // The AI SDK tools, on the shared schemas, and on valibot rather than zod on purpose: valibot
    // is the library whose tools carry the emitted adapter, so this is the entry that compiles it.
    {
      kind: 'ai',
      path: './src/generated/ai',
      validation: { useShared: true, library: 'valibot', importPath: 'src/generated/valibot' },
    },
    {
      kind: 'mcp',
      path: './src/generated/mcp',
      // `src/generated/zod`, not `./src/generated/zod`. A path written with a leading `./` is
      // resolved against the *output* directory rather than the project root, which is the
      // documented rule for every generator that takes this option, so the dotted spelling here
      // emitted `./src/generated/zod/index.js` from inside `src/generated/mcp/` and resolved to
      // nothing. Caught by the specifier sweep below, which is the only stage that compiles these
      // imports the way a consumer's compiler does.
      validation: { useShared: true, importPath: 'src/generated/zod' },
    },
  ],
};
