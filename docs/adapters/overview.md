# Adapters (Overview)

DRZL is adapter agnostic: seven generators target a different stack each, and you pick per config
entry. Only the oRPC generator is template driven, for the reason given under "How it works" below;
the other six ship without a hook API on purpose rather than pending.

Current support:

- oRPC adapter, via `generator-orpc` and the two template packages
- tRPC adapter, via `generator-trpc`
- Hono adapter, via `generator-hono`
- Express adapter, via `generator-express`
- Fastify adapter, via `generator-fastify`
- NestJS DTOs, via `generator-nestjs` (DTO and entity classes plus a validation pipe; the
  controllers stay yours)
- GraphQL, via `generator-graphql` (SDL typeDefs, resolver stubs, enum value maps and scalar
  configs consumable by any GraphQL server; the resolvers stay yours)

Planned/possible adapters (community interest welcome):

- Next.js, and more

How it works:

- The oRPC generator is driven by a template interface (hooks) that tells it how to name files,
  export router identifiers, inject imports and a prelude, and render procedure code. You can write
  custom templates to adapt it to your runtime or conventions.
- The other six take no template module, and that is deliberate rather than pending.
  `ORPCTemplateHooks` hands back oRPC source text (`os.handler(...)`, `ORPCError`), none of which is
  valid in a tRPC, Hono, Express, Fastify, NestJS or GraphQL file, so a template written against
  that interface would emit something that does not compile. Each ships without a hook API rather
  than shipping one that only appears to work. The tRPC generator does read a `template` value, but
  it names one of its own built-in shapes rather than a package to load.

Which one to reach for:

- **oRPC or tRPC** if you want RPC. Hono hosts both, and neither needs anything from DRZL to do it:
  `@hono/trpc-server` mounts a tRPC router as middleware, and oRPC's `RPCHandler` from
  `@orpc/server/fetch` mounts on any fetch handler.
- **Hono** if you want HTTP: a URL per resource, a validator per route, and a client typed by
  `hc<AppType>()`.

See also:

- [Router Adapters](/adapters/router)
- [Custom Templates](/templates/custom)
