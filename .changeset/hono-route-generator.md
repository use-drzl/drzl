---
'@drzl/generator-hono': minor
'@drzl/cli': minor
---

A Hono route generator, in Hono's own idiom.

`@drzl/generator-hono` emits one `Hono()` per table: real HTTP routes carrying
`sValidator` from `@hono/standard-validator` (or `zValidator` from `@hono/zod-validator`,
with `validator: 'zod'`), and an `index.ts` mounting them all and exporting the `AppType`
a `hc<AppType>()` client is parameterised by.

This is not an adapter for the routers DRZL already emits, because Hono needs no help
mounting those: `@hono/trpc-server` takes a `@drzl/generator-trpc` router as middleware,
and oRPC's `RPCHandler` mounts a `@drzl/generator-orpc` router on any fetch handler. What
nothing emitted was Hono's own surface, which is what people choose Hono for.

It is not a template package either. `ORPCTemplateHooks` hands back oRPC source text, so a
Hono template written against it would emit a file that does not compile.

The design follows `@drzl/generator-trpc` rather than the older oRPC choices:

- The key comes from the table's real `primaryKey`, every column of it, at its real type. A
  table with no primary key keeps `GET /` and `POST /` and loses `GET /:id`, `PATCH /:id`
  and `DELETE /:id`, rather than gaining a fictional numeric `id`. A composite key becomes
  `/:orgId/:userId`.
- A read-only table gets no write routes and no insert or update schema.
- The response shape is stated on every route that returns rows. Hono has no `.output()`;
  what a client infers is the handler's return type, so an unannotated empty stub types the
  whole client from `never[]`.
- The write stubs throw rather than returning their validated input, which is the insert
  shape where the declared response is the select shape.
- Every emitted module imports only what it uses, so a route module that validates nothing
  does not import a validator package and loads without one installed.

Path parameters are coerced strictly, which has no counterpart in the tRPC generator: a URL
segment is always a string, and the idiomatic coercions are built on `Number()`, where
`Number('')` and `Number(' ')` are both `0`. `GET /users/%20` addressing row `0` is the
wrong row, not a loose coercion, so the emitted schemas reject it. The strict form is also
the only one where zod, valibot and arktype agree.

On `@drzl/cli`: a new `hono` generator kind, wired into both `generate` and `watch` through
one shared options builder, a `generate-hono` pipeline name for `watch --pipeline`, and a
`validator` config option. `databaseInjection` is refused with a warning on this kind,
because it is a contract with `@drzl/generator-service` and these handlers never call one.
`@drzl/generator-hono` is an **optional** dependency of the CLI, like the tRPC, effect and
json-schema generators: a package that has never been published cannot publish through
npm's trusted-publisher OIDC flow, so its first version goes out by hand, and naming it as a
hard dependency in the same release would break `npm i @drzl/cli` for everyone until it
exists.
