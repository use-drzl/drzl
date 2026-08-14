# Adapters (Overview)

DRZL is adapter agnostic: eighteen generators target a different stack each, and you pick per
config entry. Only the oRPC generator is template driven, for the reason given under "How it works"
below; every other one ships without a hook API on purpose rather than pending.

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
- Pothos, MCP, Next.js, the AI SDK, TanStack Start, h3 and Nitro, Effect HttpApi, ts-rest,
  openapi-fetch, forms and Elysia, each via its own `generator-*` package. See the
  "APIs and routers" section of the sidebar for a page on each.

Planned/possible adapters (community interest welcome):

- Ask for one. Next.js was listed here as planned long after `@drzl/generator-next` shipped, which
  is the failure mode this section has: it is a list of absences, and nothing makes it notice when
  one of them stops being absent.

How it works:

- The oRPC generator is driven by a template interface (hooks) that tells it how to name files,
  export router identifiers, inject imports and a prelude, and render procedure code. You can write
  custom templates to adapt it to your runtime or conventions.
- Every other one takes no template module, and that is deliberate rather than pending.
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
