# Express Generator

Generates [Express 5](https://expressjs.com) routers per table: real HTTP endpoints carrying a
validation middleware, backed by the validation schemas DRZL already generates (Zod, Valibot,
ArkType).

```bash
npm install -D @drzl/generator-express
npm install express
```

It is an optional dependency of `@drzl/cli`, so a normal install may or may not have brought it
along. `drzl generate` tells you which package to install if it is missing.

## Express 5 only

The write stubs throw from async handlers, the same settled design as the
[Hono generator](/generators/hono): the input is the insert shape, the declared response is the
select shape, so returning the input is a compile error and a bare throw says plainly that the
work is not done.

Express 5 routes a rejected handler promise to the error middleware and answers 500 without a
`next(err)` in sight. Express 4 does not: measured on express 4.22.2 under Node 22, the same
throwing stub is an unhandled promise rejection that kills the process without responding. The
emitted idiom is only honest on 5, and `express@latest` has been the 5.x line since 2024 (5.2.1
at the time of writing; 4.x continues on the `latest-4` dist-tag).

::: tip Not a template
DRZL's "templates" are `ORPCTemplateHooks`, and both shipped ones hand back oRPC source text
(`os.handler(...)`, `ORPCError`). An Express template written against that interface would emit a
file that does not compile, which is the same reason the Hono and tRPC generators are generators.
:::

## What it emits

Three kinds of file, into `path` (or `outDir` if you do not set one):

| File            | What it is                                                                 |
| --------------- | -------------------------------------------------------------------------- |
| `<table>.ts`    | one `Router()` per table, plus the schemas its routes validate against      |
| `validation.ts` | `validate(slot, schema)`: a dependency-free Standard Schema v1 middleware   |
| `index.ts`      | one `express()` app with every router mounted, and the modules re-exported |

`validation.ts` is emitted only when some route validates something, and each route module
imports only what it uses, so a module that validates nothing loads without it.

## What a consumer gets, stated plainly

Typed handlers and exported row types. **There is no Express counterpart of Hono's
`hc<AppType>()`**: nothing infers a client from an Express app, and this generator does not
pretend otherwise. The contract lives in two places a person filling in a stub works against:

- `Response<T>` on every handler, so `res.json` is held to the route's response shape, and
- the exported `Select<Table>Row` types, inferred from the select schemas.

If you want an inferred client, that is what the [Hono](/generators/hono),
[tRPC](/generators/trpc) and [oRPC](/generators/orpc) generators are for.

## The validation middleware

Express has no first-party validator ecosystem the way Hono has `@hono/standard-validator`, and
the third-party middlewares are AJV-based: they validate JSON Schema through a different pipeline
from the zod, valibot and arktype schemas every other DRZL router shares, with AJV's own coercion
rules. So the middleware is emitted instead of installed.

All three libraries DRZL emits implement Standard Schema v1, measured in this repository on zod
4.4.3, valibot 1.4.2 and arktype 2.2.3: every schema carries `~standard` with `version: 1` and a
`validate` function. The emitted `validate('params' | 'body', schema)`:

- answers `400` with `{ error: 'Validation failed', slot, issues: [{ message, path }] }` when
  validation fails, naming the offending fields, and
- replaces `req.params` or `req.body` with the parsed output and calls `next()` when it passes.

That replacement is how a coerced path parameter reaches your handler as a `number`: Express has
no side channel like Hono's `c.req.valid()`, and replacing the slot is what every Express
validation middleware does. Measured on express 5.2.1: the assignment survives to the handlers
behind it in the same chain.

`json()` from Express rides on each write route rather than on the app, so a single router
mounted into an app of your own still parses its own bodies. A body that is not JSON at all is
answered `400` by `json()` itself through Express's default error handler.

## Routes

| Route                      | Validates                                       | Responds         |
| -------------------------- | ----------------------------------------------- | ---------------- |
| `GET /`                    | nothing                                         | `Select[]`       |
| `GET /:key`                | the primary key columns, as `params`            | `Select \| null` |
| `POST /`                   | the insert schema, as `body`                    | `Select`         |
| `PATCH /:key`              | the key as `params`, the update schema as `body` | `Select`         |
| `DELETE /:key`             | the primary key columns, as `params`            | `boolean`        |
| `GET /by-<column>/:column` | one foreign key column, as `params`             | `Select[]`       |

`by-<column>` is emitted only under `includeRelations`, one per single-column foreign key, named
after the column rather than the table it points at. It takes a literal prefix rather than a bare
`/:authorId`: Express matches routes in declaration order, so a second single-segment route would
shadow the primary-key route or be shadowed by it.

## A table with no primary key

It keeps `GET /` and `POST /` and loses every route that would have addressed one row. Inserting
a row does not require being able to address one afterwards. The key is read off the table's
actual `primaryKey`, every column of it, at its real type, so a `text` primary key is addressed
as a string and a composite key becomes `/:orgId/:userId`.

A materialized view is read-only, so it keeps `GET /` and `GET /:key` and loses the three writes,
along with its insert and update schemas.

## Path parameters

A URL path segment is always a string. `GET /users/1` delivers `"1"`, so a `number` primary key
needs parsing before it matches the column, and the generated `params` schema does that. The
coercion is deliberately the strict one, shared with the Hono generator, which carries the
[measured grid](/generators/hono#path-parameters): the idiomatic coercions are built on
`Number()`, where `Number('')` and `Number(' ')` are both `0`, so `GET /users/%20` would address
row `0`. The strict form rejects `""`, `" "`, `"0x10"` and `"1e5"`, and is the only spelling
Zod, Valibot and ArkType agree on, so switching `validation.library` does not change which
requests your API accepts.

## The response shape

```ts
export type SelectusersRow = z.output<typeof SelectusersSchema>;

usersRoutes.get('/', async (_req, res: Response<SelectusersRow[]>) => {
  const rows: SelectusersRow[] = [];
  res.json(rows);
});
```

The `POST` and `PATCH` stubs throw rather than returning their validated input. The input is the
insert shape, where a generated column is absent, and the declared response is the select shape,
where it is required, so returning the input is a compile error rather than a loose placeholder.

## Options

| Option                   | Default                                      | Meaning                                                                          |
| ------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------- |
| `path`                   | `outDir`                                     | where to write                                                                   |
| `validation.useShared`   | `false`                                      | import the schemas from a sibling validation generator instead of declaring them |
| `validation.library`     | `'zod'`                                      | which library's expressions to emit: `zod`, `valibot` or `arktype`               |
| `validation.importPath`  |                                              | where the shared schemas live, resolved against the output directory             |
| `includeRelations`       | `false`                                      | add a lookup route per single-column foreign key                                 |
| `naming.routerSuffix`    | `''` for the file, `'Routes'` for the export |                                                                                  |
| `naming.procedureCase`   |                                              | casing for file names, identifiers and the mounted URL segment                   |
| `importExtension`        | `'js'`                                       | how relative specifiers spell their extension                                    |
| `format`, `outputHeader` |                                              | as every other generator                                                         |

There is no `validator` option, unlike the Hono generator: Express has no official validator
middlewares for a config to choose between, so the emitted Standard Schema middleware is the one
form.

`databaseInjection` is not supported and the config warns if you set it. It is a contract between
a router and `@drzl/generator-service`, and these handlers are stubs that never call a service.

## A runnable config

```ts
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: 'src/db/schema.ts',
  outDir: 'src/routes',
  generators: [
    { kind: 'zod', path: 'src/validators/zod' },
    {
      kind: 'express',
      path: 'src/routes',
      includeRelations: true,
      validation: { useShared: true, library: 'zod', importPath: 'src/validators/zod' },
    },
  ],
});
```

```bash
npx drzl generate
npx drzl watch --pipeline generate-express
```

Serving it:

```ts
import { app } from './src/routes/index.js';

app.listen(3000);
```

Or mount a single table's router into an app you already have; each module parses and validates
its own input, so nothing app-level is required:

```ts
import express from 'express';
import { usersRoutes } from './src/routes/users.js';

const app = express();
app.use('/users', usersRoutes);
```

## See also

- [Hono Generator](/generators/hono), which this one's design decisions are taken from, and which
  has the typed-client story Express structurally cannot offer
- [Adapters (Overview)](/adapters/overview)
