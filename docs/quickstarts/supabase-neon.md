# Supabase and Neon (Postgres)

By the end of this page you have a drizzle-kit project pointed at Supabase or Neon in which the
schema path is named once, in `drizzle.config.ts`; `drzl generate` reads it from there and emits
Zod validators with the column rules folded in, a typed service layer, and an oRPC router that
receives its database through middleware. One insert runs end to end through that stack,
validated before it touches a connection.

The two providers share a page because they run the same database. Per the
[Supabase docs](https://supabase.com/docs/guides/database/overview), "every Supabase project
gets a full Postgres database, not a Postgres abstraction"; the
[Neon docs](https://neon.com/docs/introduction) describe theirs as serverless Postgres, and
Neon's WebSocket driver is documented as a drop-in replacement for `pg`. What differs is how
you connect to them, which is where this page spends its provider-specific attention. Everything DRZL has measured against Postgres transfers unchanged:
the grids on the [Zod generator page](/generators/zod) and the wire-limit work on the
[seed page](/examples/seed) apply as written.

Measured 2026-08-08 with `@drzl/cli` 4.22.0, `drizzle-orm` 0.45.2, `drizzle-kit` 0.31.10, `zod`
4.4.3, `@orpc/server` 1.15.0, `postgres` 3.4.9, `@neondatabase/serverless` 1.1.0, TypeScript
7.0.2, Node 22. Runtime measurements ran against `@electric-sql/pglite` 0.5.4, a real Postgres
(reports `PostgreSQL 18.3`) compiled to WASM, standing in for the hosted Postgres both providers
run; connection-format and pooling claims are from provider docs and are labeled so. Every
snippet on this page typechecks under `strict` with `moduleResolution: nodenext`; the connection
modules were not executed against hosted endpoints, since that needs an account.

## Install

::: code-group

```bash [Supabase]
pnpm add drizzle-orm postgres
pnpm add -D @drzl/cli drizzle-kit
```

```bash [Neon]
pnpm add drizzle-orm @neondatabase/serverless
pnpm add -D @drzl/cli drizzle-kit
```

:::

Driver choice, with the reasoning:

- **Supabase: `postgres` (postgres.js).** It is the driver the
  [Drizzle Supabase guide](https://orm.drizzle.team/docs/connect-supabase) documents, and the
  one whose pooling caveat below is spelled out in both Supabase's and Drizzle's docs. `pg`
  works too; nothing DRZL emits cares which.
- **Neon: `@neondatabase/serverless`.** Neon's own driver. Per the
  [Neon serverless driver docs](https://neon.com/docs/serverless/serverless-driver), its HTTP
  interface is for single, non-interactive queries, and its WebSocket `Pool`/`Client` is "a
  fully compatible drop-in replacement for the `pg` driver" for sessions and interactive
  transactions. On a long-running server you can use plain `pg` or postgres.js against Neon
  instead; it is ordinary Postgres over TCP.

## Name the schema once

A drizzle-kit project already names its schema in `drizzle.config.ts`:

```ts
// drizzle.config.ts, exactly as drizzle-kit already has it
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

So `drzl.config.ts` does not name it again. `drizzleKit: true` insists on reading kit's config,
and a missing kit config becomes a loud error rather than a quieter one about `schema`
([the full rules](/guide/configuration#reading-the-schema-path-from-drizzle-kit)):

```ts
// drzl.config.ts: no schema key at all
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  drizzleKit: true,
  outDir: 'src/api',
  generators: [
    { kind: 'zod', path: 'src/validators/zod' },
    {
      kind: 'service',
      path: 'src/services',
      dataAccess: 'drizzle',
      schemaImportPath: 'src/db/schema',
    },
    {
      kind: 'orpc',
      template: '@drzl/template-orpc-service',
      validation: { useShared: true, library: 'zod', importPath: '../validators/zod/index.js' },
      databaseInjection: {
        enabled: true,
        databaseType: "import('drizzle-orm/postgres-js').PostgresJsDatabase",
      },
    },
  ],
});
```

The fallback is never silent. Measured on the run below, the first line of output is:

```
Schema from drizzle.config.ts (1 file)
```

`drzl generate` then wrote ten files against a two-table schema (`users`, `posts`): three Zod
modules, four service files, three router files. With Neon, swap the `databaseType` for
`"import('drizzle-orm/neon-http').NeonHttpDatabase"`; it is emitted verbatim, so no import
statement is needed either way.

## What the schema carries

For a `users` table declaring an email `varchar(255)`, a name `varchar(40)`, a nullable
`date('born_on')` and a `timestamp('created_at').defaultNow()`, the emitted insert schema
(excerpt, as generated):

```ts
export const InsertusersSchema = z.object({
  id: z.number().int().gte(-2147483648).lte(2147483647).optional(),
  email: z
    .string()
    .refine((v) => [...v].length <= 255, { message: 'at most 255 characters' }),
  name: z
    .string()
    .refine((v) => [...v].length <= 40, { message: 'at most 40 characters' }),
  bornOn: z.string().nullable().optional(),
  // createdAt: a Date, or a string or epoch number coerced to one on insert
});
```

Three of those lines are Postgres facts with measured grids behind them, linked rather than
repeated:

- The character caps count **code points**, not UTF-16 units, because that is what the database
  counts: [character limits count characters](/generators/zod#character-limits-count-characters).
- `bornOn` stays a plain string on purpose. Postgres accepts `today`, `January 8, 1999` and
  `20200101` for a `date`, so any regex DRZL could emit would refuse values the database takes:
  [why numeric is the only format checked](/generators/zod#why-numeric-is-the-only-format-checked).
  The measured insert below feeds it one of exactly those strings.
- `serial` stays optional on insert rather than omitted, because the database accepts an
  explicit id: [which columns appear on insert](/generators/zod#which-columns-appear-on-insert).

## Connect

**Supabase.** Per the
[Supabase connection docs](https://supabase.com/docs/guides/database/connecting-to-postgres):
the direct connection and Supavisor session mode listen on port 5432 and suit persistent
servers; Supavisor transaction mode listens on port 6543 and is the one for serverless and edge
functions, and "transaction mode does not support prepared statements". postgres.js sends
prepared statements unless told otherwise, so the
[Drizzle Supabase guide](https://orm.drizzle.team/docs/connect-supabase) disables them:

```ts
// src/db/client.ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

// Supavisor transaction mode (port 6543) does not support prepared statements,
// so postgres.js must be told not to send them.
const client = postgres(process.env.DATABASE_URL!, { prepare: false });
export const db = drizzle({ client });
```

On a long-running server using the direct connection or session mode, drop `prepare: false` and
keep prepared statements.

**Neon.** The HTTP driver is one line:

```ts
// src/db/client.ts
import { drizzle } from 'drizzle-orm/neon-http';

export const db = drizzle(process.env.DATABASE_URL!);
```

Per the [Neon pooling docs](https://neon.com/docs/connect/connection-pooling), a pooled
connection string carries `-pooler` in the hostname and runs through PgBouncer in transaction
mode (up to 10,000 client connections); use the direct, unpooled string for migrations and
`pg_dump`, which rely on session state. Keep both in your environment: pooled for the app,
direct for `drizzle-kit push`.

These two modules typecheck against the emitted tree; they are the one class of snippet on this
page that was **not executed**, since both need a hosted endpoint. Everything below ran.

## Mount the router

The generated router expects `context.db`; the `dbMiddleware` inside it refuses to run without
one. Wiring it to a fetch handler is the same shape the
[oRPC + Service template page](/templates/orpc-service) shows for Cloudflare D1:

```ts
// src/server.ts
import { RPCHandler } from '@orpc/server/fetch';
import { router } from './api/index.js';
import { db } from './db/client.js';

const handler = new RPCHandler(router);

export default {
  async fetch(request: Request): Promise<Response> {
    const { response } = await handler.handle(request, { prefix: '/api', context: { db } });
    return response ?? new Response('Not Found', { status: 404 });
  },
};
```

## The measured end to end

The whole stack ran headless against PGlite: `call` from `@orpc/server` invokes a procedure the
way the fetch handler would, middleware and both schemas included.

```ts
import { call } from '@orpc/server';
import { users as usersRouter } from './api/users.js';

const created = await call(
  usersRouter.create,
  { email: 'ada@example.com', name: 'Ada', bornOn: 'January 8, 1999' },
  { context: { db } }
);
```

What the run printed, quoted:

```
bad row: name: at most 40 characters
router.create: {"id":1,"email":"ada@example.com","name":"Ada","bornOn":"1999-01-08",...}
40-emoji name: schema accepts + database accepts
```

Three claims, each measured:

- A 41-character `name` was refused by the input schema before any connection was used.
- `bornOn: 'January 8, 1999'` sailed through the plain-string schema and **Postgres stored it**
  as `1999-01-08`: the permissive date parser from the
  [format-check grid](/generators/zod#why-numeric-is-the-only-format-checked), demonstrated in
  one row.
- A 40-emoji `name` passed the schema and the `varchar(40)` column both. An `n`-UTF-16-unit cap
  would have refused it at 40 code points; the database would not have.

For seeding and bulk inserts against either provider, the [seed page](/examples/seed) is
written for exactly this dialect, including the measured 65,535 bind-parameter wire ceiling and
the stricter PGlite ceiling its chunk arithmetic derives from.

## Provider notes

- **Pooling changes validation not at all.** Schemas run in your process; the pooler only sees
  the resulting SQL. The one interaction that exists is the prepared-statements rule above.
- **Auth tables.** If an auth library writes credential tables into the schema file DRZL reads,
  exclude them before generating CRUD over them. The
  [configuration page](/guide/configuration#auth-tables-in-particular) shows the exclusion and
  why DRZL refuses to guess it for you.
- **Migrations use the direct connection.** The Neon pooling docs say so outright, and the
  Supabase connection docs list migrations under the direct connection's use cases. `drzl`
  itself never connects to anything: it reads schema files.

## Without drizzle-kit

No drizzle-kit config to read? Name the schema in `drzl.config.ts` instead; everything else on
this page is unchanged:

```ts
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: 'src/db/schema.ts',
  outDir: 'src/api',
  generators: [
    { kind: 'zod', path: 'src/validators/zod' },
    {
      kind: 'service',
      path: 'src/services',
      dataAccess: 'drizzle',
      schemaImportPath: 'src/db/schema',
    },
    {
      kind: 'orpc',
      template: '@drzl/template-orpc-service',
      validation: { useShared: true, library: 'zod', importPath: '../validators/zod/index.js' },
      databaseInjection: {
        enabled: true,
        databaseType: "import('drizzle-orm/postgres-js').PostgresJsDatabase",
      },
    },
  ],
});
```

::: tip Need something else?
If this quickstart doesn't cover what you need, DM me on X (https://x.com/omardulaimidev) and we can scope it together.
:::
