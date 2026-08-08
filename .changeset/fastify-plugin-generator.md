---
'@drzl/generator-fastify': minor
'@drzl/cli': minor
---

A Fastify plugin generator, with DRZL's JSON Schema fed straight into Fastify's own validation.

`@drzl/generator-fastify` emits one `FastifyPluginAsync` per table: real HTTP routes whose
`schema: { params, body, response }` Fastify compiles itself, AJV for the requests and
fast-json-stringify for the responses, plus an `index.ts` barrel plugin registering every table
under its prefix with the modules re-exported, consumable as `app.register(routes)` under any
prefix of your own.

Unlike the Hono generator (which imports validator middleware) and the Express generator (which
emits one), this generator emits no validator at all, because Fastify's native validation IS
JSON Schema. The schemas are produced by `@drzl/generator-json-schema`'s own `tableSchemas()`
builder, called at generation time as a real dependency and inlined as literals, so the two JSON
Schema producers cannot drift and every semantic the builder carries (CHECK constraint bounds,
byte caps, formats, integer detection) arrives for free. The emitted tree's only import is
`import type { FastifyPluginAsync } from 'fastify'`, which vanishes at build time. Three keys
are adapted from measurements on fastify 5.11.2: `$schema` (2020-12) is refused by Fastify's
default draft-07 AJV, `$id` is stripped as module identity the inline copies do not have, and
`prefixItems` is refused as an unknown keyword and respelled as homogeneous `items` with the
same bounds, which is the identical constraint because the builder only emits identical tuple
members.

Path parameters are where Fastify's defaults had to be constrained, from a measured grid rather
than memory: with the default `coerceTypes`, a key typed `{ type: 'integer' }` reads
`GET /users/%20` as row 0, `0x10` as 16, `1e5` as 100000, and silently rounds
`9007199254740993`. The emitted params schemas use the strict string spelling
(`^-?\d+(\.\d+)?$`, digits only for bigint, `format: 'date-time'` for Date keys, the member set
for enum keys), whose measured grid matches the Hono and Express generators row for row.

Request bodies keep Fastify's own semantics, documented and pinned rather than fought:
`coerceTypes: 'array'` accepts `{ email: 123 }` as `"123"` and `removeAdditional` strips
unnamed keys, where the other two route generators answer 400. Missing required fields, enum
outsiders, scalar-shaped violations and malformed JSON are still 400, and unparseable content
types are 415. Two builder semantics are inherited and stated plainly: a nullable column
without a default is required on insert (null is a value; omitting the key is not sending
null), and the update schema excludes the primary key columns.

The serializer is the Fastify-specific hazard and the reason the response schemas come from the
same builder: fast-json-stringify silently omits properties absent from the response schema,
throws a 500 for a missing required column or an inconvertible value, truncates floats declared
integer, writes `null` as `""` under a string, and serializes a `null` payload as `{}`. The
measured grid is recorded in the source and docs, the runtime suite proves a full row
round-trips through the emitted route with every column present and correctly typed (via
`fastify.inject()`, the full pipeline including serialization), and the byId stub answers a
declared 404 instead of returning `null` for exactly the `{}` reason.

The design otherwise follows the settled route-generator class:

- The key comes from the table's real `primaryKey`, every column of it, at its real type. A
  keyless table keeps `GET /` and `POST /` and loses the addressed routes; a composite key
  becomes `/:orgId/:userId`; a read-only table gets no write routes and no insert or update
  schema.
- The write stubs throw rather than echoing input, and every handler is held to its declared
  reply by the `Reply` route generics, verified by a compile canary.
- Every module imports only what it uses, and the docs state plainly that there is no inferred
  client for a Fastify app; the TypeBox type-provider road is named as future work, not built
  as a second variant.

On `@drzl/cli`: a new `fastify` generator kind, wired into both `generate` and `watch` through
one shared options builder with a byte-for-byte branch-parity spec, and a `generate-fastify`
pipeline name for `watch --pipeline`. `databaseInjection` is refused with a warning on this
kind, and so is `validation`, which no other router refuses but this one cannot read: there is
no library to choose and no shared schema module to import. `@drzl/generator-fastify` is an
**optional** dependency of the CLI, like the tRPC, Hono, Express, effect and json-schema
generators: a package that has never been published cannot publish through npm's
trusted-publisher OIDC flow, so its first version goes out by hand, and naming it as a hard
dependency in the same release would break `npm i @drzl/cli` for everyone until it exists.
