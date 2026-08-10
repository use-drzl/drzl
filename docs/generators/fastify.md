# Fastify Generator

Generates [Fastify 5](https://fastify.dev) plugins per table: real HTTP routes whose
`schema: { params, body, response }` is JSON Schema built by the same code as the
[JSON Schema generator](/generators/json-schema), fed straight into Fastify's own AJV validation
and fast-json-stringify serialization.

```bash
npm install -D @drzl/generator-fastify
npm install fastify
```

`@drzl/cli` depends on it, so installing the CLI already brought it along; the first line above is
for using the generator on its own. `drzl generate` tells you which package to install if it is
ever missing.

## Why this generator emits no validator

Fastify's native validation IS JSON Schema: the framework compiles every route's request schemas
with AJV and its response schemas with fast-json-stringify. The Hono generator imports a
validator middleware and the Express generator emits one; here there is nothing to add, because
the schemas are the validator. DRZL already builds JSON Schema from a Drizzle table in
`@drzl/generator-json-schema`, so this generator calls that builder at generation time and
inlines the results as literals. The two generators cannot drift, every semantic the builder
carries (CHECK constraint bounds, byte caps, formats, integer detection) arrives for free, and
the emitted tree has zero runtime dependencies beyond `fastify` itself: every module's only
import is `import type { FastifyPluginAsync } from 'fastify'`, which vanishes at build time.

Three keys are adapted on the way in, each from a measurement on fastify 5.11.2 rather than from
the specs: `$schema` naming draft 2020-12 is refused by Fastify's default draft-07 AJV at
`app.ready()`, `$id` is module identity the inlined copies do not have, and `prefixItems` (the
2020-12 tuple keyword, emitted for `point()` and friends) is refused as an unknown keyword, so it
is respelled as homogeneous `items` with the same `minItems`/`maxItems`, which is exactly the
same constraint because the builder only ever emits identical tuple members.

::: tip Not a template
DRZL's "templates" are `ORPCTemplateHooks`, and both shipped ones hand back oRPC source text. A
Fastify template written against that interface would emit a file that does not compile, which is
the same reason the Hono, Express and tRPC generators are generators.
:::

## What it emits

One module per table plus a barrel, into `path` (or `outDir` if you do not set one):

| File         | What it is                                                                        |
| ------------ | --------------------------------------------------------------------------------- |
| `<table>.ts` | one `FastifyPluginAsync` per table, plus the schemas its routes carry, as data    |
| `index.ts`   | one plugin registering every table's plugin under its prefix, modules re-exported |

There is no middleware module, unlike the Express generator: the schemas ARE the validation.

Consuming it:

```ts
import Fastify from 'fastify';
import { routes } from './src/routes/index.js';

const app = Fastify();
await app.register(routes);            // serves /users, /posts, ...
// or under a prefix of your own:
await app.register(routes, { prefix: '/api' });   // serves /api/users, ...
await app.listen({ port: 3000 });
```

Or register a single table's plugin into an app you already have:

```ts
import { usersRoutes } from './src/routes/users.js';

app.register(usersRoutes, { prefix: '/users' });
```

## Routes

| Route                      | Validates                                        | Responds                 |
| -------------------------- | ------------------------------------------------ | ------------------------ |
| `GET /`                    | nothing                                          | `200` `Select[]`         |
| `GET /:key`                | the primary key columns, as `params`             | `200` `Select` or `404`  |
| `POST /`                   | the insert schema, as `body`                     | `200` `Select`           |
| `PATCH /:key`              | the key as `params`, the update schema as `body` | `200` `Select`           |
| `DELETE /:key`             | the primary key columns, as `params`             | `200` `boolean`          |
| `GET /by-<column>/:column` | one foreign key column, as `params`              | `200` `Select[]`         |

The key is read off the table's actual `primaryKey`, every column of it, at its real type: a
`text` primary key is addressed as a string and a composite key becomes `/:orgId/:userId`. A
table with no primary key keeps `GET /` and `POST /` and loses every route that would have
addressed one row. A materialized view is read-only, so it keeps its reads and loses the three
writes along with its insert and update schemas.

`by-<column>` is emitted only under `includeRelations`, one per single-column foreign key. Its
literal prefix is load-bearing here, not just clearer: measured on fastify 5.11.2, registering a
bare `/:authorId` beside `/:id` throws `Method 'GET' already declared for route` at registration,
because find-my-way reads both as the same single-parameter route.

The `POST` and `PATCH` stubs throw rather than returning their validated input; Fastify answers
the rejected promise with a 500. The input is the insert shape, where generated and defaulted
columns are optional, and the declared reply is the select shape, where they are required, so
returning the input would be a compile error rather than a loose placeholder. The `GET /:key`
stub answers `404 { message }` through a declared response schema instead of returning `null`:
measured on fastify 5.11.2, a `null` payload under an object response schema serializes as `{}`.

## Path parameters

A URL path segment is always a string, and Fastify's default AJV is configured with
`coerceTypes`, so a key column typed `{ type: 'integer' }` would accept whatever `Number()`
accepts. Measured on fastify 5.11.2, against the emitted strict spelling:

| Segment              | `{ type: 'integer' }` (Fastify default) | emitted schema  |
| -------------------- | --------------------------------------- | --------------- |
| `1`                  | 200, id `1`                             | 200             |
| `1.5`                | 400                                     | 200             |
| `%20` (a space)      | 200, id `0`                             | 400             |
| `0x10`               | 200, id `16`                            | 400             |
| `1e5`                | 200, id `100000`                        | 400             |
| `abc`                | 400                                     | 400             |
| `9007199254740993`   | 200, id `9007199254740992` (rounded)    | 200, unchanged  |

`GET /users/%20` addressing row `0` is the wrong row, not a loose coercion, and it is the exact
case the [Hono](/generators/hono#path-parameters) and [Express](/generators/express) generators
measured and refuse. Their strict grid cannot be reproduced here by AJV options, because the AJV
instance belongs to the consumer's Fastify, so the emitted `params` schemas use the strict string
spelling instead: `{ type: 'string', pattern: '^-?\d+(\.\d+)?$' }` for a numeric key, digits only
for a `bigint` key, `format: 'date-time'` for a `Date` key (enforced, because Fastify's compiler
installs ajv-formats), and the member set itself for an enum key. The measured grid matches the
other two generators row for row, including accepting `1.5`, which their shared pattern also
admits.

One visible consequence: a validated key reaches your handler as the raw string segment. Without
a type provider Fastify hands handlers untyped params anyway, and `Number(req.params.id)` on a
segment the pattern accepted is safe.

## Request bodies keep Fastify's own semantics

This generator feeds Fastify's own machinery, and Fastify's default AJV runs
`coerceTypes: 'array'`, `removeAdditional: true` and `useDefaults: true`. Measured on 5.11.2:

- `{ email: 123 }` against `{ type: 'string' }` is coerced to `"123"` and accepted, and
  `["x"]` is unwrapped to `"x"`. The Hono and Express generators answer 400 to the same body.
- A key the schema does not name is silently stripped, not refused.
- Missing required properties, enum outsiders, objects where scalars belong and malformed JSON
  are still 400; a content type with no parser is 415.

That is how every hand-written Fastify app behaves, so it is documented and pinned in this
package's tests rather than fought. If you want the strict cross-library policy on bodies, the
Hono and Express generators enforce it.

Two more semantics are inherited from the shared builder and stated here because they decide what
a body may leave out:

- **A nullable column without a default may be omitted on insert**, and so may a defaulted one:
  the rule is that a column is optional exactly when the database can produce a row without it,
  and an `INSERT` that omits a nullable column stores `NULL`. This used to be decided the other
  way here, until a real Postgres was asked; the JSON Schema generator's own test suite pins the
  answer, and every generator now gives it.
- **The update schema excludes the primary key columns.** The key of the row being patched comes
  from the path, and a body that could rename it would be a different operation.

## The serializer, measured

Fastify serializes responses with fast-json-stringify compiled from the response schemas, which
is why every route declares one. Two behaviours make the response schema load-bearing, measured
on fastify 5.11.2:

| Payload against the select schema        | What is sent                                    |
| ---------------------------------------- | ----------------------------------------------- |
| property the schema does not name        | silently omitted                                |
| required column missing from the payload | 500, `"email" is required!`                     |
| `"abc"` where `integer` declared         | 500, `cannot be converted to an integer`        |
| `"42"` where `integer` declared          | coerced to `42`                                 |
| `1.9` where `integer` declared           | truncated to `1`, silently                      |
| `123` where `string` declared            | stringified to `"123"`                          |
| `null` where non-nullable `string`       | becomes `""`, silently                          |
| `NaN` where `number`                     | 500                                             |
| `Infinity` where `number`                | becomes `null`, silently                        |
| enum outsider                            | passes through unchanged                        |
| `Date` under `format: date-time`         | its ISO string                                  |
| `bigint` under the string spelling       | its decimal digits                              |
| `null` payload under an object schema    | becomes `{}`, which is why the stubs answer 404 |

The first row is the hazard this generator is designed around: a response schema that missed one
column would silently delete that column from every response, with no error anywhere. So the
select schemas come from the same builder as everything else, and the package's runtime suite
proves a full row round-trips through the emitted route with every column present and correctly
typed, driving the real pipeline through `fastify.inject()`.

## What a consumer gets, stated plainly

Typed handlers and exported schemas and row types. **There is no inferred client**: nothing
plays the role of Hono's `hc<AppType>()` for a Fastify app, and this generator does not pretend
otherwise. The contract lives in three places:

- the route schemas, which Fastify enforces at runtime on both directions,
- the `Reply` route generics on every handler (`app.post<{ Reply: SelectusersRow }>`), which is
  the one place Fastify's types hold a handler to its declared reply without a type provider,
  verified by a compile canary in this package's tests, and
- the exported `Select<Table>Row` interfaces and `<Mode><Table>Schema` objects, which you can
  reuse when filling in the stubs.

A TypeBox type provider road exists and looks genuinely promising: DRZL already emits TypeBox,
and `@fastify/type-provider-typebox` would derive static request and reply types from the same
schemas. It is future work, not a second variant here; one coherent deliverable beats two half
ones.

## Options

| Option                   | Default                                      | Meaning                                                        |
| ------------------------ | -------------------------------------------- | -------------------------------------------------------------- |
| `path`                   | `outDir`                                     | where to write                                                 |
| `includeRelations`       | `false`                                      | add a lookup route per single-column foreign key               |
| `naming.routerSuffix`    | `''` for the file, `'Routes'` for the export |                                                                |
| `naming.procedureCase`   |                                              | casing for file names, identifiers and the registered prefix   |
| `importExtension`        | `'js'`                                       | how relative specifiers spell their extension                  |
| `format`, `outputHeader` |                                              | as every other generator                                       |

There is no `validation` option, unlike the Hono and Express generators: there is no library to
choose and no shared schema module to import, and the config warns if you set one. Likewise
`databaseInjection` is not supported and warns: it is a contract between a router and
`@drzl/generator-service`, and these handlers are stubs that never call a service.

## A runnable config

```ts
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: 'src/db/schema.ts',
  outDir: 'src/routes',
  generators: [{ kind: 'fastify', path: 'src/routes', includeRelations: true }],
});
```

```bash
npx drzl generate
npx drzl watch --pipeline generate-fastify
```

## See also

- [JSON Schema Generator](/generators/json-schema), whose builder produces every schema these
  routes carry
- [Hono Generator](/generators/hono) and [Express Generator](/generators/express), which enforce
  the strict cross-library body policy and share the params grid this generator matches
- [Adapters (Overview)](/adapters/overview)
