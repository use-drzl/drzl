# Cloudflare D1 (SQLite)

By the end of this page you have a drizzle-kit project pointed at Cloudflare D1 in which the
schema path is named once, in `drizzle.config.ts`; `drzl generate` reads it from there and emits
ArkType validators plus a Hono app whose routes validate against them, mounted in a Worker over
the D1 binding, with the create handler filled in. Along the way it measures the two D1 facts
that reshape inserts: interactive transactions do not exist here, and bound parameters cap at
100 per query.

Measured 2026-08-08 with `@drzl/cli` 4.22.0, `drizzle-orm` 0.45.2, `drizzle-kit` 0.31.10,
`arktype` 2.2.3, `hono` 4.13.1, `@hono/standard-validator` 0.4.0, TypeScript 7.0.2, Node 22.
Two local stand-ins, each labeled where used: **SQLite semantics** ran on `better-sqlite3`
13.0.3 (SQLite 3.53.4), and **D1 API behavior** ran on `miniflare` 5.20260801.1-alpha, which
per the [Cloudflare docs](https://developers.cloudflare.com/workers/development-testing/)
executes Workers "using the same runtime used in production, workerd" and simulates bound
resources locally; it is what `wrangler dev` runs. Production D1 is a hosted service this page
never reached; its limits are quoted from
[D1's limits page](https://developers.cloudflare.com/d1/platform/limits/) and cross-checked
against what the simulator enforces. Every snippet typechecks under `strict` with
`moduleResolution: nodenext`; Worker-side files typecheck against `@cloudflare/workers-types`.

## Install

```bash
pnpm add drizzle-orm hono @hono/standard-validator arktype
pnpm add -D @drzl/cli drizzle-kit wrangler @cloudflare/workers-types
```

Driver choice, with the reasoning: there is no driver package to choose. D1 arrives as a
binding on your Worker's `env`, per the
[Drizzle D1 guide](https://orm.drizzle.team/docs/connect-cloudflare-d1), and
`drizzle-orm/d1` wraps that binding directly: `drizzle(env.DB)`. The binding is declared in
wrangler config:

```jsonc
// wrangler.jsonc
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "quickstart-db",
      "database_id": "<your-database-id>",
      "migrations_dir": "drizzle"
    }
  ]
}
```

## Name the schema once

drizzle-kit talks to D1 over Cloudflare's HTTP API, per the
[drizzle-kit D1 guide](https://orm.drizzle.team/docs/guides/d1-http-with-drizzle-kit):

```ts
// drizzle.config.ts, exactly as drizzle-kit already has it
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  driver: 'd1-http',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    databaseId: process.env.CLOUDFLARE_DATABASE_ID!,
    token: process.env.CLOUDFLARE_D1_TOKEN!,
  },
});
```

DRZL reads exactly two things from that file, `schema` and `dialect`; the credentials are
drizzle-kit's alone ([the full rules](/guide/configuration#reading-the-schema-path-from-drizzle-kit)).
So `drzl.config.ts` names no schema:

```ts
// drzl.config.ts: no schema key at all
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  drizzleKit: true,
  outDir: 'src/routes',
  generators: [
    { kind: 'arktype', path: 'src/validators/arktype' },
    {
      kind: 'hono',
      validator: 'standard',
      validation: { useShared: true, library: 'arktype', importPath: '../validators/arktype/index.js' },
    },
  ],
});
```

Measured, the run announces `Schema from drizzle.config.ts (1 file)` and writes six files:
three ArkType modules, three route files.

## What the schema carries

Against a `users` table declaring `integer('id').primaryKey({ autoIncrement: true })`,
`blob('settings', { mode: 'json' })` and `integer('created_at', { mode: 'timestamp' })`, the
emitted insert schema (excerpt, as generated):

```ts
export const InsertusersSchema = type({
  id: "-9223372036854775808 <= number.integer <= 9223372036854775807?",
  email: "string",
  name: "string",
  settings: "(number | object | string | boolean | null | null)?",
  // createdAt: Date | epoch number | parseable date string | null, narrowed
});
```

The id range is SQLite's fact: per the [SQLite docs](https://www.sqlite.org/autoinc.html), an
`INTEGER PRIMARY KEY` column is an alias for the rowid, "which is always a 64-bit signed
integer", so the bounds are int8, not int4. `settings` is the JSON union, because `blob({ mode: 'json' })` round-trips any
JSON value; `blob({ mode: 'bigint' })` and the timestamp mode are in the
[dialect grid](/generators/zod#dialects-other-than-postgres). One ArkType-specific behavior to
know from the [React Hook Form page](/examples/react-hook-form#dates): ArkType validates date
inputs without converting them, so the filled handler below makes the `Date` itself.

Measured on better-sqlite3 (SQLite semantics, not D1-specific): a validated row with
`settings: { theme: 'dark' }` and a `Date` came back from a drizzle round-trip intact, stored
as `typeof(settings) = 'blob'` and `created_at = 1786190400` (epoch seconds); a bad row with
`published: 'yes'` was refused by the emitted schema with `published must be boolean (was
"yes")`; and SQLite's NUMERIC affinity stored the string `'abc'` unchanged with
`typeof = 'text'`, which is why
[no numeric format check is emitted on this dialect](/generators/zod#numeric-and-decimal-columns).

## Mount it in a Worker

The generated `src/routes/index.ts` exports a composed `app`. The Worker hands it requests, and
handlers build their db from the binding per request:

```ts
// src/worker.ts
import { app } from './routes/index.js';

export interface Env {
  DB: D1Database;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
```

Generated handlers are typed stubs; generated output is granted under your project's license,
so filling them in place is the intended workflow. The create route, filled:

```ts
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { sValidator } from '@hono/standard-validator';
import { users } from '../db/schema.js';
import { InsertusersSchema } from '../validators/arktype/index.js';

export const usersRoutes = new Hono<{ Bindings: { DB: D1Database } }>().post(
  '/',
  sValidator('json', InsertusersSchema),
  async (c) => {
    const db = drizzle(c.env.DB);
    const input = c.req.valid('json');
    const [created] = await db
      .insert(users)
      .values({
        ...input,
        // ArkType validates date inputs without converting them, so the wire
        // string becomes a Date here, not in the schema.
        createdAt: input.createdAt == null ? null : new Date(input.createdAt),
      })
      .returning();
    return c.json(created, 201);
  }
);
```

Both files typecheck against `@cloudflare/workers-types`; deploying them needs an account, so
the deployed path is the one thing here that is compile-verified only. `app.request()` testing
without a server works as on the [Hono generator page](/generators/hono). SQLite has
`RETURNING`, so `.returning()` works on this dialect (it ran in the batch measurement below).

## Transactions do not exist here; batches do

`drizzle-orm` 0.45.2's D1 driver implements `db.transaction()` by issuing a raw `begin` (read
from the installed package's `d1/session.js`). Measured against miniflare's D1, that call
fails:

```
transaction: Failed query: begin
cause: D1_ERROR: To execute a transaction, please use the state.storage.transaction() ...
```

The runtime refuses `BEGIN` outright. What D1 has instead is `batch`, which its
[docs](https://developers.cloudflare.com/d1/worker-api/d1-database/) describe plainly:
"batched statements are SQL transactions". Measured, both halves:

```
batch of 2: ok
sabotage batch: D1_ERROR: UNIQUE constraint failed: users.email
rows from the failed batch: {"n":0}
```

A two-insert `db.batch([...])` committed; a batch whose second insert collided on a unique
column failed **and left zero rows behind**, first statement included. So the
[seed page](/examples/seed)'s "one transaction, idempotent" step translates to D1 as one
`db.batch` per seed, with the same validate-and-dedupe pre-flight in front of it.

## The 100-parameter ceiling

Per [D1's limits page](https://developers.cloudflare.com/d1/platform/limits/): 100 bound
parameters per query, 100 KB per SQL statement, 2 MB per row, 10 GB per database (500 MB on the
free plan). The parameter cap is the one a seed script hits first: each provided column of each
row in a multi-row insert is one parameter, exactly as on the
[seed page](/examples/seed#step-4-chunk-under-the-wire-limit), with a budget 655 times smaller.

The local simulator enforces it at the same boundary, measured twice: on a raw prepared
statement, and on the drizzle insert path with two provided columns per row:

```
100 bound parameters: ok
101 bound parameters: D1_ERROR: too many SQL variables at offset 307: SQLITE_ERROR
50 rows x 2 cols (100 params): ok
51 rows x 2 cols (102 params): D1_ERROR: too many SQL variables
```

So the chunk arithmetic is the seed page's with D1's constant, and the chunks then ride one
atomic batch:

```ts
const width = new Set(rows.flatMap(Object.keys)).size; // provided columns only
const chunk = Math.floor(100 / width);

const inserts = Array.from({ length: Math.ceil(rows.length / chunk) }, (_, i) =>
  db.insert(users).values(rows.slice(i * chunk, (i + 1) * chunk))
);
if (inserts.length) await db.batch([inserts[0]!, ...inserts.slice(1)]);
```

Measured as written against the simulator: 250 two-column rows made `chunk = 50`, five inserts
rode one batch, and the table held all 250 rows after it.

## Provider notes

- **D1 is SQLite's engine with a guarded SQL surface.** Per the
  [supported-statements page](https://developers.cloudflare.com/d1/sql-api/sql-statements/), D1
  runs SQLite's query engine and ships the FTS5, JSON and math-function extensions. The guard
  is measurable: even `select sqlite_version()` is refused ("not authorized to use function:
  sqlite_version", measured on the simulator), so this page cannot name a D1 SQLite version,
  and its SQLite-semantics numbers are labeled with the stand-in's version instead.
- **Not executed here:** production D1 (every limit above is sourced, with the simulator's
  enforcement measured where shown), the `d1-http` drizzle-kit credentials path, and the
  deployed Worker. Local development against the same simulator is
  `wrangler dev`, sourced above.

## Without drizzle-kit

```ts
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: 'src/db/schema.ts',
  outDir: 'src/routes',
  generators: [
    { kind: 'arktype', path: 'src/validators/arktype' },
    {
      kind: 'hono',
      validator: 'standard',
      validation: { useShared: true, library: 'arktype', importPath: '../validators/arktype/index.js' },
    },
  ],
});
```

::: tip Need something else?
If this quickstart doesn't cover what you need, DM me on X (https://x.com/omardulaimidev) and we can scope it together.
:::
