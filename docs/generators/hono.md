# Hono Generator

Generates [Hono](https://hono.dev) routes per table: real HTTP endpoints carrying a validator
middleware, backed by the validation schemas DRZL already generates (Zod, Valibot, ArkType).

```bash
npm install -D @drzl/generator-hono
npm install hono @hono/standard-validator
```

`@drzl/cli` depends on it, so installing the CLI already brought it along; the first line above is
for using the generator on its own. `drzl generate` tells you which package to install if it is
ever missing.

## Why this exists, when Hono already hosts tRPC and oRPC

It does host both, and neither integration needs anything from DRZL. `@hono/trpc-server` mounts a
`@drzl/generator-trpc` router as middleware, and oRPC's `RPCHandler` from `@orpc/server/fetch`
mounts a `@drzl/generator-orpc` router on any fetch handler. If you want RPC on Hono, use those:
they are a few lines each and they are documented upstream.

This generator is for the other case, which nothing covered: you chose Hono because you want HTTP
routes, a URL per resource, and a client typed by `hc<AppType>()` rather than by an RPC proxy.

::: tip Not a template
DRZL's "templates" are `ORPCTemplateHooks`, and both shipped ones hand back oRPC source text
(`os.handler(...)`, `ORPCError`). A Hono template written against that interface would emit a file
that does not compile, which is the same reason `@drzl/generator-trpc` has no hook API.
:::

## What it emits

Two kinds of file, into `path` (or `outDir` if you do not set one):

| File         | What it is                                                                          |
| ------------ | ----------------------------------------------------------------------------------- |
| `<table>.ts` | one `Hono()` per table, plus the schemas its routes validate against                |
| `index.ts`   | one app with every table mounted, and the `AppType` your client is parameterised by |

```ts
import { hc } from 'hono/client';
import type { AppType } from './routes/index.js';

const client = hc<AppType>('http://localhost:8787');
const res = await client.users.$get();
const one = await client.users[':id'].$get({ param: { id: '1' } });
```

## Routes

| Route                      | Validates                                       | Responds         |
| -------------------------- | ----------------------------------------------- | ---------------- |
| `GET /`                    | nothing                                         | `Select[]`       |
| `GET /:key`                | the primary key columns, as `param`             | `Select \| null` |
| `POST /`                   | the insert schema, as `json`                    | `Select`         |
| `PATCH /:key`              | the key as `param`, the update schema as `json` | `Select`         |
| `DELETE /:key`             | the primary key columns, as `param`             | `boolean`        |
| `GET /by-<column>/:column` | one foreign key column, as `param`              | `Select[]`       |

`by-<column>` is emitted only under `includeRelations`, one per single-column foreign key, named
after the column rather than the table it points at: two keys frequently reference the same table
(`authorId` and `editorId` both pointing at `users`), and naming by table would emit one path twice.
It takes a literal prefix rather than a bare `/:authorId`, which would be indistinguishable from
the primary-key route and would shadow it.

The routes are chained, and that is not a style choice. `hc<AppType>()` infers the client from the
accumulated route type, and that type only accumulates through the return value of each `.get` and
`.post`. A loop calling `app.get(...)` and discarding the result compiles, runs identically, and
infers an app with no routes on it at all.

## A table with no primary key

It keeps `GET /` and `POST /` and loses every route that would have addressed one row.

```ts
export const auditLogRoutes = new Hono()
  .get('/', async (c) => { ... })
  .post('/', sValidator('json', InsertauditLogSchema), async (_c) => { ... });
```

Inserting a row does not require being able to address one afterwards, so `POST /` stays. The key
is read off the table's actual `primaryKey`, every column of it, at its real type, so a `text`
primary key is addressed as a string and a composite key becomes `/:orgId/:userId`.

A materialized view is read-only, so it keeps `GET /` and `GET /:key` and loses the three writes,
along with its insert and update schemas.

## Path parameters

A URL path segment is always a string. `GET /users/1` delivers `"1"`, so a `number` primary key
needs parsing before it matches the column, and the generated `param` schema does that. The
coercion is deliberately the strict one:

| segment  | `z.coerce.number()` | what DRZL emits |
| -------- | ------------------- | --------------- |
| `""`     | `0`                 | rejected        |
| `" "`    | `0`                 | rejected        |
| `" 1 "`  | `1`                 | rejected        |
| `"0x10"` | `16`                | rejected        |
| `"1e5"`  | `100000`            | rejected        |
| `"abc"`  | rejected            | rejected        |

`GET /users/%20` addressing row `0` is not a coercion working loosely, it is the wrong row. The
strict form is also the only one where Zod, Valibot and ArkType agree, so switching
`validation.library` does not change which requests your API accepts.

## A `Date` column, which JSON cannot carry

`JSON.stringify(new Date())` is a string, so `c.req.json()` never hands the validator a `Date`
instance. The body schemas therefore take the strict ISO datetime string and hand your handler a
real `Date`, while the select shape stays a `Date` because that is what the driver produces:

```ts
// insert and update
seenAt: z.iso.datetime().transform((s) => new Date(s)),
// select
seenAt: z.date(),
```

Strict, because `new Date('1')` is the year 2001: a lenient parse turns a typo into a row. This
used to be `z.date()` on every mode, which no JSON body could satisfy, so a request carrying a date
column could not be written at all.

At the edges the three libraries differ, and the difference is in what counts as ISO rather than in
whether the value is a date: zod's `z.iso.datetime()` is the strictest and takes the `Z`-suffixed
form only, valibot's `isoTimestamp` also takes a numeric offset, and arktype's `string.date.iso`
takes any ISO 8601 form including a bare `2020-01-01`. So `validation.library` does change which
date spellings this API accepts, which the [NestJS page](/generators/nestjs) measures in full.

## The response shape

Hono has no `.output()`. What a client infers is the handler's return type, so the value handed to
`c.json` is annotated:

```ts
export type SelectusersRow = z.output<typeof SelectusersSchema>;

.get('/', async (c) => {
  const rows: SelectusersRow[] = [];
  return c.json(rows);
})
```

Without that annotation an empty stub infers `never[]` and the whole client is typed from it.

The `POST` and `PATCH` stubs throw rather than returning their validated input. The input is the
insert shape, where a generated column is absent, and the declared response is the select shape,
where it is required, so returning the input is a compile error rather than a loose placeholder. A
body that only throws has type `never`, which honours any contract and says plainly that the work
is not done.

## Options

| Option                   | Default                                      | Meaning                                                                                                                |
| ------------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `path`                   | `outDir`                                     | where to write                                                                                                         |
| `validator`              | `'standard'`                                 | `'standard'` emits `sValidator` from `@hono/standard-validator`; `'zod'` emits `zValidator` from `@hono/zod-validator` |
| `validation.useShared`   | `false`                                      | import the schemas from a sibling validation generator instead of declaring them                                       |
| `validation.library`     | `'zod'`                                      | which library's expressions to emit: `zod`, `valibot` or `arktype`                                                     |
| `validation.importPath`  |                                              | where the shared schemas live, resolved against the output directory                                                   |
| `includeRelations`       | `false`                                      | add a lookup route per single-column foreign key                                                                       |
| `naming.routerSuffix`    | `''` for the file, `'Routes'` for the export |                                                                                                                        |
| `naming.procedureCase`   |                                              | casing for file names, identifiers and the mounted URL segment                                                         |
| `importExtension`        | `'js'`                                       | how relative specifiers spell their extension                                                                          |
| `format`, `outputHeader` |                                              | as every other generator                                                                                               |

`@hono/standard-validator` is the default because Zod, Valibot and ArkType all implement Standard
Schema v1, so one middleware covers every library `validation.library` can name. Established from
the registry on 2026-08-08: `@hono/standard-validator` 0.4.0 peers `@standard-schema/spec ^1.0.0`
and `hono >=4.11.2`; `@hono/zod-validator` 0.9.0 peers `zod ^3.25.0 || ^4.0.0` and `hono >=4.11.2`.
The zod one did not become Standard-Schema-based; both exist and they are different packages.

`databaseInjection` is not supported and the config warns if you set it. It is a contract between a
router and `@drzl/generator-service`, and these handlers are stubs that never call a service.

## A runnable config

```ts
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: 'src/db/schema.ts',
  outDir: 'src/routes',
  generators: [
    { kind: 'zod', path: 'src/validators/zod' },
    {
      kind: 'hono',
      path: 'src/routes',
      validator: 'standard',
      includeRelations: true,
      validation: { useShared: true, library: 'zod', importPath: 'src/validators/zod' },
    },
  ],
});
```

```bash
npx drzl generate
npx drzl watch --pipeline generate-hono
```

Mounting it, with no server binary involved:

```ts
import { app } from './src/routes/index.js';

const res = await app.request('/users/1');
```

`app.request()` runs the whole pipeline, middleware included, against a real `Request` and returns
a real `Response`. It is the same code path a deployed worker takes, which is what the generator's
own tests use.

## See also

- [tRPC Generator](/generators/trpc), which this one's design decisions are taken from
- [Adapters (Overview)](/adapters/overview)
