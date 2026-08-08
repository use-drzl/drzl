# @drzl/generator-hono

Generate [Hono](https://hono.dev) routes from a Drizzle schema: one route module per table,
validated by DRZL's schemas through Hono's own validator middleware, with an `AppType` a
`hc<AppType>()` client infers from.

## Why not an adapter, and why not a template

Hono already hosts DRZL's other routers, and neither integration needs anything from this
repository. `@hono/trpc-server` mounts a `@drzl/generator-trpc` router as middleware, and oRPC's
`RPCHandler` from `@orpc/server/fetch` mounts a `@drzl/generator-orpc` router on any fetch handler.
Both are a few lines and both are documented upstream.

What nothing emitted was Hono's _own_ surface: real HTTP routes carrying a validator. That is what
this generates.

It is not a template either. A DRZL "template" is `ORPCTemplateHooks`, and both shipped ones
(`@drzl/template-standard`, `@drzl/template-orpc-service`) hand back oRPC source text, so a Hono
template written against that interface would emit a file that does not compile.

## Install

```bash
npm install -D @drzl/generator-hono
npm install hono @hono/standard-validator
```

`@hono/standard-validator` is the default middleware and takes any Standard Schema, so it works
with the zod, valibot and arktype schemas DRZL emits. Set `validator: 'zod'` to emit
`@hono/zod-validator` instead.

## Configure

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
      validation: { useShared: true, library: 'zod', importPath: 'src/validators/zod' },
    },
  ],
});
```

Then `npx drzl generate`.

## What it emits

For `users(id serial primary key, email text not null, bio text)`:

```ts
export const UsersParamsSchema = z.object({
  id: z
    .string()
    .regex(/^-?\d+(\.\d+)?$/)
    .transform(Number),
});

export type SelectusersRow = z.output<typeof SelectusersSchema>;

export const usersRoutes = new Hono()
  .get('/', async (c) => {
    const rows: SelectusersRow[] = [];
    return c.json(rows);
  })
  .get('/:id', sValidator('param', UsersParamsSchema), async (c) => {
    // The validated path parameters are at c.req.valid('param').
    const row: SelectusersRow | null = null;
    return c.json(row);
  })
  .post('/', sValidator('json', InsertusersSchema), async (_c) => {
    throw new Error('Not implemented: create users.');
  });
```

plus an `index.ts` mounting each table and exporting `AppType`:

```ts
export const app = new Hono().route('/users', usersRoutes);
export type AppType = typeof app;
```

The handlers are stubs. Fill them in; the schemas, the routes and the types are the part that is
derived from your schema and regenerated.

## Design

These follow `@drzl/generator-trpc`, not the older oRPC generator.

- **A real primary key, or no addressing routes at all.** The key comes from the table's actual
  `primaryKey`, every column of it, at its real type. A table with no primary key keeps `GET /` and
  `POST /` and loses `GET /:id`, `PATCH /:id` and `DELETE /:id` rather than gaining a fictional
  `id`. A composite key becomes `/:orgId/:userId`.
- **A read-only table** (a materialized view) gets no write routes, and no insert or update schema.
- **The response shape is stated**, because Hono has no `.output()`: what a client infers is the
  handler's return type, so the value handed to `c.json` is annotated with the select shape.
- **Write stubs throw** rather than returning their input. The input is the insert shape, where a
  generated column is absent; the declared response is the select shape, where it is required.
- **Path parameters are coerced strictly.** A path segment is always a string, so a `number` key
  needs parsing, and the idiomatic coercions are built on `Number()`, where `Number('')` is `0`.
  `GET /users/%20` addressing row `0` is not a coercion working loosely, it is the wrong row.
- **Every module imports only what it uses**, so a route module that validates nothing does not
  import a validator package, and loads in a project that never installed one.

## License

Apache-2.0
