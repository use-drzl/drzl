# @drzl/generator-fastify

Generate [Fastify 5](https://fastify.dev) plugins from a Drizzle schema: one route module per
table whose `schema: { params, body, response }` is JSON Schema built by
`@drzl/generator-json-schema`'s own builder, fed straight into Fastify's native AJV validation
and fast-json-stringify serialization, plus a barrel plugin registering them all.

## Why this generator emits no validator

Fastify's native validation IS JSON Schema. The Hono generator imports a validator middleware
and the Express generator emits one; here there is nothing to add, because the schemas are the
validator. This package depends on `@drzl/generator-json-schema` and calls its `tableSchemas()`
at generation time, inlining the results as literals, so the two JSON Schema producers cannot
drift and every semantic the builder carries (CHECK constraint bounds, byte caps, formats,
integer detection) arrives for free. The emitted tree's only import is
`import type { FastifyPluginAsync } from 'fastify'`, which vanishes at build time: zero runtime
dependencies beyond Fastify itself.

Three keys are adapted before inlining, each measured on fastify 5.11.2 rather than assumed:
`$schema` naming draft 2020-12 is refused by Fastify's default draft-07 AJV at `app.ready()`,
`$id` is module identity the inline copies do not have, and `prefixItems` is refused as an
unknown keyword, so it is respelled as homogeneous `items` bounded by the same
`minItems`/`maxItems`, which is exactly the same constraint because the builder only emits
identical tuple members.

## Install

```bash
npm install -D @drzl/generator-fastify
npm install fastify
```

## Configure

```ts
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: 'src/db/schema.ts',
  outDir: 'src/routes',
  generators: [{ kind: 'fastify', path: 'src/routes', includeRelations: true }],
});
```

## Consume

```ts
import Fastify from 'fastify';
import { routes } from './src/routes/index.js';

const app = Fastify();
await app.register(routes); // serves /users, /posts, ...
await app.listen({ port: 3000 });
```

Or one table's plugin into an app of your own:

```ts
import { usersRoutes } from './src/routes/users.js';
app.register(usersRoutes, { prefix: '/users' });
```

## The shape of the routes

- The key comes from the table's real `primaryKey`, every column of it, at its real type: a
  composite key becomes `/:orgId/:userId`, a keyless table keeps `GET /` and `POST /` and loses
  the addressed routes, and a read-only table loses every write.
- Path parameters are validated as strict strings. Fastify's default AJV coerces params, and
  `{ type: 'integer' }` reads `GET /users/%20` as row 0, `0x10` as 16 and `1e5` as 100000
  (measured); the emitted `^-?\d+(\.\d+)?$` spelling matches the measured grid of the Hono and
  Express generators row for row.
- Request bodies keep Fastify's own semantics, documented and pinned: `coerceTypes` turns
  `{ email: 123 }` into `"123"`, and `removeAdditional` strips unnamed keys. Missing required
  fields, enum outsiders and malformed JSON are still 400.
- The write stubs throw rather than echoing input, so a valid body answers 500 until you fill
  the stub in, and `GET /:key` answers a declared 404 rather than serializing `null` into `{}`
  (measured; the source carries the full serializer grid).
- Every handler is held to its reply by the `Reply` route generics, and `Select<Table>Row`
  interfaces plus every schema object are exported for reuse.

There is no inferred client, and the docs say so plainly: nothing plays the role of Hono's
`hc<AppType>()` for a Fastify app. A TypeBox type-provider variant is named as future work.

## Docs

https://use-drzl.github.io/drzl/generators/fastify

## License

Apache-2.0
