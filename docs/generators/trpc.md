# tRPC Generator

Generates [tRPC v11](https://trpc.io) routers per table, backed by the validation schemas DRZL
already generates (Zod, Valibot, ArkType).

```bash
npm install -D @drzl/generator-trpc
```

It is an optional dependency of `@drzl/cli`, so a normal install may or may not have brought it
along. `drzl generate` tells you which package to install if it is missing.

## What it emits

Three kinds of file, into `path` (or `outDir` if you do not set one):

| File | What it is |
| --- | --- |
| `trpc.ts` | the shared base: one `initTRPC` instance, the `Context` type, `router`, `publicProcedure`, `createCallerFactory` |
| `<table>.ts` | one router per table |
| `index.ts` | `appRouter`, and the `AppRouter` type your client is parameterised by |

The base module has no counterpart in the oRPC output, and it is not optional. oRPC's `os` is a
free import, so any file can build a procedure on its own. tRPC's builder carries the context type,
the transformer and the error formatter with it: a router built from its own `initTRPC.create()`
has its own context type, cannot share middleware, and cannot be soundly merged. Every tRPC project
has exactly one of these, and a generated tree is not an exception.

Likewise `index.ts` is not a barrel. A nested tRPC router has to be built by `router()`, and
`export type AppRouter` is the entire client contract:

```ts
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from './api/index.js';

const trpc = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: '/trpc' })] });
await trpc.users.list.query();
await trpc.users.create.mutate({ email: 'ada@example.com' });
```

## Procedures

| Procedure | Kind | Input | Output |
| --- | --- | --- | --- |
| `list` | `query` | none | `Select[]` |
| `byId` | `query` | the primary key columns | `Select \| null` |
| `create` | `mutation` | the insert schema | `Select` |
| `update` | `mutation` | the primary key columns, plus `data` as the update schema | `Select` |
| `delete` | `mutation` | the primary key columns | `boolean` |
| `listBy<Column>` | `query` | one foreign key column | `Select[]` |

Reads are queries and writes are mutations, which is not a naming convention: a tRPC client caches
and batches queries over `GET`, and a mutation is never issued over `GET`, so declaring a write as a
query puts it somewhere a proxy or a browser may cache it.

`listBy<Column>` is emitted only under `includeRelations`, one per single-column foreign key, named
after the column rather than the table it points at. Two keys frequently reference the same table
(`authorId` and `editorId` both pointing at `users`), and naming by table would emit one procedure
twice.

### Output schemas

Every procedure declares `.output(...)`. tRPC typechecks a handler's return against its output
parser, so the contract is enforced at compile time as well as at run time. That is also why the
stub handlers for `create` and `update` throw rather than returning their input: the input is the
*insert* shape, where generated and defaulted columns are optional, and the output is the *select*
shape, where they are required. A body that only throws has type `never`, which honours any
contract and says plainly that the work is not done.

TypeBox is the one validator DRZL generates that cannot be used here. tRPC recognises a validator
through Standard Schema, and `@sinclair/typebox` does not implement it. `validation.library` accepts
`zod`, `valibot` and `arktype`.

## Primary keys

The key is read off your schema. A `varchar` primary key called `isbn` produces
`byId({ isbn: string })`, not `byId({ id: number })`.

| Your table | What you get |
| --- | --- |
| single-column key | `byId`, `update`, `delete` take that column, at its real type |
| composite key | the same three, taking every column of the key |
| **no primary key** | only `list` and `create` |

A table with no primary key cannot address a row, so the procedures that would have needed one are
absent rather than given an `id` the table does not have. `create` stays: inserting a row does not
require being able to find it again.

A **materialized view**, or anything else the analyzer marks read-only, gets `list` and `byId` only.
The database refuses every write to one, so a `create` procedure on it would describe an operation
that always fails, and no insert or update schema is emitted or imported for it.

## Context and the database

Without `databaseInjection`, the emitted `Context` is left open and nothing generated reads it:

```ts
export type Context = Record<string, unknown>;
```

With it, the base module gains a typed context and a guarded procedure builder, and every generated
procedure is built on that builder rather than on `publicProcedure`:

```ts
generators: [
  {
    kind: 'trpc',
    template: 'service',
    databaseInjection: {
      enabled: true,
      databaseType: 'Database',
      // Relative to the output directory, because your compiler resolves it from the emitted
      // file. A project-relative `src/db/client.js` is a package specifier to Node and to tsc.
      databaseTypeImport: { name: 'Database', from: '../db/client.js' },
    },
  },
],
```

```ts
// trpc.ts
export interface Context {
  db?: Database;
}

export const dbProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.db) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '...' });
  }
  return next({ ctx: { db: ctx.db } });
});
```

`db` is optional on `Context` and required by `dbProcedure`. That split lets your adapter build a
context without a handle, for a health check or a public route, while every generated procedure sees
one that is present. You supply it from `createContext`:

```ts
createHTTPServer({ router: appRouter, createContext: () => ({ db }) });
```

`databaseInjection` describes a contract between two generators, so it is declared once, on the
router, and the CLI pushes it onto the `service` generator. Note that `@drzl/generator-service`
honours it only while emitting real Drizzle queries: its stub bodies take no database parameter
whatever they are told, so pair it with `dataAccess: 'drizzle'`. `drzl generate` warns if you do not.

## Templates

`template` is a closed set, not a module path.

- `standard` (default) emits stubs: `list` returns `[]`, `byId` returns `null`, `delete` returns
  `true`, and `create` and `update` throw.
- `service` delegates to the classes `@drzl/generator-service` writes, and is the tRPC counterpart
  of pointing the oRPC generator at `@drzl/template-orpc-service`.

There is no custom-template hook API. `ORPCTemplateHooks` hands back oRPC source text
(`os.handler(...)`, `ORPCError`, `os.$context()`), none of which is valid tRPC, so neither built-in
template package can be reused and a custom one written against that interface would emit a file
that does not compile. An API shaped for tRPC is worth designing; borrowing one is not.

In `service` mode, `byId`, `update` and `delete` fall back to a throwing stub when the key cannot be
expressed as the single `number` that generator's methods take, which is any composite key and any
non-numeric one. The procedures are still emitted, still take the real key and still declare the
real output, so the client surface does not change shape from table to table; only the body says
that you have to wire it. The emitted file names the reason.

## Validation reuse

Identical to the [oRPC generator](/generators/orpc#validation-reuse). With
`validation.useShared`, the routers import `Insert<Table>Schema`, `Update<Table>Schema` and
`Select<Table>Schema` from `validation.importPath` instead of declaring their own, and the CLI
copies the `affix` from whichever sibling generator produces `validation.library`, so the names
cannot drift. Only the schemas a given router actually mentions are imported.

## Columns DRZL cannot type

A column the analyzer could not derive a type for gets the library's permissive type, and the
emitted file says which ones:

```ts
// No validated type for this column: payload.
// DRZL could not derive one from the schema, so the router accepts any value there.
```

The router still works; it just does not check that field. `drzl generate` also lists these columns
on stdout.

## Example

```ts
// drzl.config.ts
export default defineConfig({
  schema: 'src/db/schema.ts',
  outDir: 'src/api',
  generators: [
    { kind: 'zod', path: 'src/validators/zod' },
    { kind: 'service', path: 'src/services', dataAccess: 'drizzle', schemaImportPath: 'src/db/schema' },
    {
      kind: 'trpc',
      path: 'src/trpc',
      template: 'service',
      includeRelations: true,
      validation: { useShared: true, library: 'zod', importPath: 'src/validators/zod' },
      databaseInjection: {
        enabled: true,
        // Emitted verbatim, so an inline `import(...)` type needs no import statement. The
        // `databaseTypeImport` form above is the alternative; its `from` is resolved by your
        // compiler from the *emitted* file, not from the project root.
        databaseType: "import('drizzle-orm/node-postgres').NodePgDatabase",
      },
    },
  ],
});
```

```bash
drzl generate
```

::: warning Running oRPC and tRPC together
Both router generators default to `outDir` and both write an `index.ts` there, so a config with both
needs a `path` on at least one of them.
:::

## Options

```ts
interface GenerateOptions {
  outputDir: string;
  template?: 'standard' | 'service';
  includeRelations?: boolean;
  naming?: { routerSuffix?: string; procedureCase?: 'camel' | 'kebab' | 'snake' };
  format?: { enabled?: boolean; engine?: 'auto' | 'prettier' | 'biome'; configPath?: string };
  outputHeader?: { enabled?: boolean; text?: string };
  importExtension?: 'js' | 'ts' | 'none';
  validation?: {
    useShared?: boolean;
    library?: 'zod' | 'valibot' | 'arktype';
    importPath?: string;
    schemaSuffix?: string;
    affix?: AffixOptions;
  };
  databaseInjection?: {
    enabled?: boolean;
    databaseType?: string;
    databaseTypeImport?: { name: string; from: string };
  };
  servicesDir?: string;
}
```

The router file is named after the table; the exported router is named after the table plus
`naming.routerSuffix`, which defaults to `Router`. So `users` produces `users.ts` exporting
`usersRouter`, and setting `routerSuffix: 'Router'` produces `usersRouter.ts` exporting
`usersRouter`.

## Generated Output License

- You own the generated output. DRZL grants you a worldwide, royalty-free, irrevocable license to
  use, copy, modify, and distribute the generated files under your project's license.
- A short header is added by default. Configure via `outputHeader` in `drzl.config.ts`:
  - `outputHeader.enabled = false` to disable
  - `outputHeader.text = '...'` to customize

::: tip Need something else?
If this generator doesn't cover what you need, DM me on X (https://x.com/omardulaimidev) and we can
scope it together.
:::
