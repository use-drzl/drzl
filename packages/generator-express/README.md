# @drzl/generator-express

Generate [Express 5](https://expressjs.com) routers from a Drizzle schema: one route module per
table, validated by DRZL's schemas through a small emitted middleware over
[Standard Schema v1](https://standardschema.dev), plus a barrel mounting them all on one app.

## Why a generator, and why the middleware is emitted

A DRZL "template" is `ORPCTemplateHooks`, and both shipped ones hand back oRPC source text, so an
Express template written against that interface would emit a file that does not compile. This is a
generator in Express's own idiom instead, the same resolution `@drzl/generator-hono` reached.

Express has no first-party validator ecosystem the way Hono does. The third-party middlewares are
AJV-based and validate JSON Schema, a different pipeline from the zod, valibot and arktype schemas
every other DRZL router shares. All three of those libraries implement Standard Schema v1, so the
generator emits a dependency-free `validation.ts` whose `validate(slot, schema)` covers every
library `validation.library` can name: on failure it answers
`400 { error, slot, issues: [{ message, path }] }`, and on success it replaces `req.params` or
`req.body` with the parsed output and calls `next()`.

## Install

```bash
npm install -D @drzl/generator-express
npm install express
```

**Express 5 only.** The write stubs throw from async handlers, and Express 5 routes a rejected
handler promise to the error middleware and answers 500. Measured on express 4.22.2 under Node 22,
the same stub is an unhandled promise rejection that kills the process without responding, so the
emitted idiom is only honest on 5. `express@latest` has been the 5.x line since 2024.

## Configure

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

export const usersRoutes = Router();

usersRoutes.get('/', async (_req, res: Response<SelectusersRow[]>) => {
  const rows: SelectusersRow[] = [];
  res.json(rows);
});

usersRoutes.get(
  '/:id',
  validate('params', UsersParamsSchema),
  async (_req, res: Response<SelectusersRow | null>) => {
    // validate() has already replaced req.params with the parsed values.
    const row: SelectusersRow | null = null;
    res.json(row);
  }
);

usersRoutes.post(
  '/',
  json(),
  validate('body', InsertusersSchema),
  async (_req, _res: Response<SelectusersRow>) => {
    throw new Error('Not implemented: create users.');
  }
);
```

plus `validation.ts` (the middleware) and an `index.ts` mounting each router:

```ts
export const app = express();
app.use('/users', usersRoutes);
```

The handlers are stubs. Fill them in; the schemas, the routes and the types are the part that is
derived from your schema and regenerated.

## What a consumer gets, stated plainly

Typed handlers and exported row types. There is no Express counterpart of Hono's `hc<AppType>()`:
nothing infers a client from an Express app, so this generator does not pretend to emit one. The
response contract lives in the `Response<T>` annotation on every handler and in the exported
`Select<Table>Row` types, which is what the person filling in a stub works against. If you want an
inferred client, that is what `@drzl/generator-hono` and the RPC generators are for.

## Design

These follow `@drzl/generator-hono`, which took them from `@drzl/generator-trpc`.

- **A real primary key, or no addressing routes at all.** The key comes from the table's actual
  `primaryKey`, every column of it, at its real type. A table with no primary key keeps `GET /`
  and `POST /` and loses the `/:id` routes rather than gaining a fictional `id`. A composite key
  becomes `/:orgId/:userId`.
- **A read-only table** (a materialized view) gets no write routes, and no insert or update schema.
- **Write stubs throw** rather than returning their input. The input is the insert shape, where a
  generated column is absent; the declared response is the select shape, where it is required.
- **Path parameters are coerced strictly.** A path segment is always a string, and the idiomatic
  coercions are built on `Number()`, where `Number('')` is `0`. `GET /users/%20` addressing row
  `0` is not a coercion working loosely, it is the wrong row. The strict forms are shared with
  `@drzl/generator-hono`, which carries the measured grid.
- **`json()` rides on each write route**, not on the app, so a single router mounted into your own
  app still parses its own bodies.
- **Every module imports only what it uses**, and `validation.ts` is emitted only when some route
  validates something.

## License

Apache-2.0
