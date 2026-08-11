# Elysia

`@drzl/generator-elysia` emits [Elysia](https://elysiajs.com) routes from your Drizzle schema: one
mounted module per table plus an assembled app, validated by the schemas a validation generator
already writes.

## The one generator that takes TypeBox

Every other DRZL router types its validators as a Standard Schema, and TypeBox implements no such
thing, so `validation.library` on those kinds is limited to zod, valibot and arktype. Elysia's slot
is `AnySchema = TSchema | StandardSchemaV1Like`, because Elysia's own `t` *is* TypeBox. So this is
the one generator that accepts all four.

It still defaults to zod, and that is worth explaining. `@sinclair/typebox` ships separate `.d.ts`
and `.d.mts` declarations and brands its schema types with `unique symbol`s, so the two copies are
not assignable to each other. Elysia's own declarations are CommonJS. Under
`moduleResolution: node16` or `nodenext` an ESM consumer resolves TypeBox to the `.d.mts` copy while
Elysia's slot refers to the `.d.ts` one, and a `TObject` stops matching `TSchema`:

```
error TS2322: Type 'TObject<{ email: TString; }>' is not assignable to type 'AnySchema | undefined'.
  Property ''~standard'' is missing in type 'TObject<{ email: TString; }>'
```

Reproduced upstream with a single installed copy of `@sinclair/typebox@0.34.52`, so it is not a
duplicate-install problem and nothing DRZL emits can fix it. It compiles cleanly under `bundler`,
which is what Bun projects use, so set `validation.library` to `typebox` if that is your setup. zod,
valibot and arktype compile under all three resolutions, which is why one of them is the default.

## Setup

```bash
npm install -D @drzl/generator-elysia
npm install elysia
```

```ts
// drzl.config.ts
export default {
  schema: './src/db/schema.ts',
  generators: [
    { kind: 'zod', path: 'src/validators/zod' },
    { kind: 'elysia', path: 'src/routes' },
  ],
};
```

Swap `zod` for `valibot`, `arktype` or `typebox` and set `validation.library` to match; all four are
supported, and all four are compiled and driven against a real Elysia in this package's tests.

## What is emitted

Per table, one Elysia instance mounted under its own prefix:

| Route    | Method and path      | Validates              |
| -------- | -------------------- | ---------------------- |
| list     | `GET /users`         | `query`                |
| byId     | `GET /users/:id`     | `params`               |
| create   | `POST /users`        | `body`                 |
| update   | `PATCH /users/:id`   | `params`, `body`       |
| delete   | `DELETE /users/:id`  | `params`               |

A table with no primary key keeps list and create. A materialized view keeps list and byId, because
the database refuses every write to it.

Plus `index.ts`, which mounts them all:

```ts
export const app = new Elysia().use(usersRoutes).use(postsRoutes);
export type App = typeof app;
```

A real mounted app, unlike the [h3 generator](/generators/h3)'s barrel, and the difference is that
Elysia has one way to compose. `.use()` carries each module's routes onto the assembled type, which
is what `App` gives Eden Treaty to derive a client from.

## Three details worth knowing

**`t.Numeric()` comes from `elysia`, not from `@sinclair/typebox`.** `Type.Numeric` is `undefined`
there; it is one of fifteen types Elysia adds on top. So a TypeBox params module imports `t` from
`'elysia'` even though the table schemas beside it come from `@sinclair/typebox`. A path segment is
always a string, and `t.Numeric()` is Elysia's own spelling for one that should be a number.

**ArkType keeps unknown keys; the other three strip them.** Posting
`{ email: 'a@b.c', wat: true }` to a route whose body declares only `email` gives the handler
`{ email: 'a@b.c' }` under zod, valibot and TypeBox, and `{ email: 'a@b.c', wat: true }` under
ArkType. Elysia accepts the request either way. The difference is in what reaches your code.

**Test with a multi-label hostname.** `app.handle(new Request('http://x/users'))` returns
`404 NOT_FOUND` for an app whose routes are registered and working. Elysia scans the URL string for
the path rather than going through `new URL()`, and a one-label host throws off the offset, so
everything 404s in a way that reads exactly like a router that never built. Use
`http://localhost/users`.

## Serving it

```ts
import { app } from './routes';

// Under Bun:
app.listen(3000);

// Anywhere else, including a test: `handle` takes a Request and returns a Response.
const res = await app.handle(new Request('http://localhost/users'));
```

That second form is what this package's own tests use, which is why they run on plain Node with no
adapter and no server.

## Options

| Option                  | Default     | What it does                                              |
| ----------------------- | ----------- | ---------------------------------------------------------- |
| `path`                  | `outDir`    | Where the modules are written                             |
| `appName`               | `'app'`     | The identifier the assembled app is exported as            |
| `prefix`                | none        | Prefixed to every mount point, through Elysia's own option |
| `validation.library`    | `'zod'`     | `zod`, `valibot`, `arktype` or `typebox`                   |
| `validation.importPath` | derived     | Where the schemas live, when it is not the sibling's `path` |
| `naming.routerSuffix`   | none        | Appended to each module name and identifier                |
| `naming.procedureCase`  | none        | Casing for file names, identifiers and the URL segment     |

`prefix` goes on the assembled app rather than into each module's own prefix, because Elysia lifts
it into the app's type: the full path is what Eden Treaty reports.
