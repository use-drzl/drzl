# PlanetScale (MySQL)

By the end of this page you have a drizzle-kit project pointed at PlanetScale in which the
schema path is named once, in `drizzle.config.ts`; `drzl generate` reads it from there and emits
Valibot validators carrying MySQL's byte-counted text caps, a per-table duplicate finder, the
foreign-key graph as plain data, and a typed tRPC router over those schemas. One insert runs end
to end, validated before it touches a connection, against a real MySQL 8.

PlanetScale is Vitess over MySQL, and the two facts that reshape a quickstart are MySQL's, not
Vitess's: text columns budget **bytes** while `varchar(n)` counts **characters**, and foreign
key constraints are off by default on PlanetScale, so referential integrity may be yours to
keep. DRZL has measured tooling for both; this page wires it up. PlanetScale also offers
Postgres now ([GA announcement](https://planetscale.com/blog/planetscale-for-postgres-is-generally-available));
for that product use the [Supabase and Neon page](/quickstarts/supabase-neon), which is
dialect-portable.

Measured 2026-08-08 with `@drzl/cli` 4.22.0, `drizzle-orm` 0.45.2, `drizzle-kit` 0.31.10,
`valibot` 1.4.2, `@trpc/server` 11.18.0, `mysql2` 3.23.2, `@planetscale/database` 1.20.1,
TypeScript 7.0.2, Node 22. Runtime measurements ran against MySQL 8.4.11 (Docker, `utf8mb4`
client charset set explicitly) standing in for PlanetScale's MySQL; per the
[PlanetScale docs](https://planetscale.com/blog/mysql-charsets-collations), new databases are
MySQL 8 with `utf8mb4` and `utf8mb4_0900_ai_ci` as defaults, so the stand-in matches the
defaults it stands in for. Vitess-specific behavior (the foreign-key toggle, sharding limits) is
sourced from PlanetScale's docs and labeled so. Every snippet typechecks under `strict` with
`moduleResolution: nodenext`; the `@planetscale/database` connection module was not executed,
since that needs a PlanetScale endpoint.

## Install

```bash
pnpm add drizzle-orm @planetscale/database
pnpm add -D @drzl/cli drizzle-kit
```

Driver choice, with the reasoning:

- **`@planetscale/database`** is what the
  [Drizzle PlanetScale guide](https://orm.drizzle.team/docs/connect-planetscale) documents:
  queries travel over HTTP, which is what serverless and edge runtimes without raw TCP need,
  and `drizzle-orm/planetscale-serverless` is the matching driver import.
- **`mysql2`** remains supported for TCP access, per the same guide. It is also what this
  page's measurements ran over, since it speaks to any MySQL. If you use it, set
  `charset: 'utf8mb4'` explicitly; otherwise a byte-cap measurement can measure your client's
  transcoding rather than the server's column.

```ts
// src/db/client.ts
import { drizzle } from 'drizzle-orm/planetscale-serverless';

export const db = drizzle({
  connection: {
    host: process.env.DATABASE_HOST!,
    username: process.env.DATABASE_USERNAME!,
    password: process.env.DATABASE_PASSWORD!,
  },
});
```

## Name the schema once

```ts
// drizzle.config.ts, exactly as drizzle-kit already has it
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'mysql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

```ts
// drzl.config.ts: no schema key at all
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  drizzleKit: true,
  outDir: 'src/api',
  generators: [
    { kind: 'valibot', path: 'src/validators/valibot', duplicateFinder: true, constraints: true },
    {
      kind: 'trpc',
      validation: { useShared: true, library: 'valibot', importPath: '../validators/valibot/index.js' },
    },
  ],
});
```

`drzl generate` announces the fallback (`Schema from drizzle.config.ts (1 file)`, measured) and
reads kit's `dialect` as a cross-check against what the analyzer measures from the columns;
[the full rules](/guide/configuration#reading-the-schema-path-from-drizzle-kit). The same kit
config drove `drizzle-kit push` against the measurement database, so one file fed both tools.

## Byte caps, folded in

Against a `users` table declaring `varchar('name', { length: 40 })` and a nullable
`tinytext('bio')`, the emitted insert schema carries two different kinds of cap (excerpt, as
generated):

```ts
name: v.pipe(
  v.string(),
  v.check((val) => [...val].length <= 40, 'at most 40 characters'),
),
bio: v.optional(
  v.nullable(
    v.pipe(
      v.string(),
      v.check(
        (val) => new TextEncoder().encode(val).length <= 255,
        'at most 255 bytes',
      ),
    ),
  ),
),
```

`varchar(n)` counts characters (code points, not UTF-16 units); the TEXT family budgets bytes
in the column's charset. Both facts are measured in the
[dialect grid](/generators/zod#dialects-other-than-postgres) and the
[character-limit grid](/generators/valibot#character-limits-count-characters); this page reran
the pair that shows the difference. 100 thumbs-up emoji is 100 characters and 400 bytes:

```
schema verdict: at most 255 bytes
mysql verdict: ER_DATA_TOO_LONG Data too long for column 'bio' at row 1
```

The schema and MySQL 8.4.11 refuse the same value, one of them before a connection was opened.
The same run stored a 40-emoji `name` in `varchar(40)` with both sides agreeing it fits.

## Foreign keys are a setting here

Per the
[PlanetScale docs](https://planetscale.com/docs/vitess/foreign-key-constraints), foreign key
constraints are supported but must be enabled per database ("Allow foreign key constraints"
under Settings), and "currently, the foreign key constraints are only supported in unsharded
environments". The same page documents cases where deploy-request reverts can leave orphaned
rows. Historically the recommendation was to run without them
([operating without foreign key constraints](https://planetscale.com/docs/vitess/operating-without-foreign-key-constraints)).

So a PlanetScale schema's `references()` may be documentation rather than enforcement, and the
generated artifacts are built for that:

- **The constraint ledger.** `constraints: true` emits every key and foreign key as plain data.
  Measured, the `posts` entry names `FOREIGN KEY (authorId) REFERENCES users (id)` with its
  columns and target as fields, which is what the
  [seed page's insert-order derivation](/examples/seed#step-3-parents-before-children) consumes:
  parents before children without hand-maintaining a list.
- **The duplicate finder.** Uniqueness inside a batch is the constraint a per-row schema cannot
  check. Measured against the emitted module, two rows with the same explicit `id: 7` report
  `{"index":1,"constraint":"users_pkey","firstIndex":0}` before the server ever sees them.
- **For contrast, the stand-in enforces.** With constraints on (the local MySQL, or PlanetScale
  with the toggle enabled), inserting a post whose `authorId` matches no user fails with
  `ER_NO_REFERENCED_ROW_2` (errno 1452, measured). With the toggle off, that same insert
  succeeds and the orphan is yours. The ledger and finder are how the seed script refuses it
  first either way.

## The measured end to end

```ts
// seed.ts, run with: npx tsx seed.ts
import * as v from 'valibot';
import { users } from './src/db/schema.js';
import { InsertusersSchema, findDuplicateusers } from './src/validators/valibot/index.js';
import { db } from './src/db/client.js';

const rows = [
  { email: 'ada@example.com', name: 'Ada', bio: 'hello' },
  { email: 'lin@example.com', name: 'Lin', bio: null },
];

for (const row of rows) v.parse(InsertusersSchema, row); // throws with column + message
const dupes = findDuplicateusers(rows);
if (dupes.length) throw new Error(JSON.stringify(dupes));

await db.insert(users).values(rows);
const ids = await db.insert(users).values({ email: 'x@example.com', name: 'X' }).$returningId();
```

This ran as written against the stand-in (over the `mysql2` client rather than the PlanetScale
one, which is the labeled gap). Two MySQL-isms worth pinning: there is no `RETURNING` in this
dialect, so drizzle's `$returningId()` is how you get generated ids back (measured:
`[{"id":3}]`), and the [service generator](/generators/service)'s `dataAccess: 'drizzle'` mode
emits `.returning()` calls, so it is not in this page's config; the tRPC procedures are typed
stubs you fill against your own data layer.

## Mount the router

The generated `src/api/index.ts` exports `appRouter`, its `AppRouter` type for clients, and
`createCallerFactory` for in-process calls:

```ts
import { appRouter, createCallerFactory } from './api/index.js';

const caller = createCallerFactory(appRouter)({});
const users = await caller.users.list(); // [] until you fill the stub
```

Input schemas are already wired. Measured: calling `caller.users.create` with the 400-byte bio
from above fails at the procedure boundary with `BAD_REQUEST` and the same `at most 255 bytes`
message, because the router imports the shared Valibot schemas rather than restating them
([how sharing works](/guide/configuration#sharing-names-with-a-router-generator)).

## Provider notes

- **Sharding.** The foreign-key support above is unsharded-only, per the PlanetScale docs
  quoted there. Nothing DRZL emits assumes a shard layout either way.
- **`utf8mb4` is the default and the assumption the caps encode.** The emitted byte checks
  count UTF-8 bytes (`TextEncoder`, visible in the excerpt above), which is the byte count
  `utf8mb4` stores, and `utf8mb4` is what new PlanetScale databases speak (sourced above). A
  column you declare in a legacy single-byte charset would store fewer bytes than the check
  counts for non-ASCII text.
- **Not executed here:** the `@planetscale/database` HTTP driver against a real endpoint, and
  the settings toggle itself. Both are sourced from PlanetScale's and Drizzle's docs above and
  labeled where they appear.

## Without drizzle-kit

```ts
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: 'src/db/schema.ts',
  outDir: 'src/api',
  generators: [
    { kind: 'valibot', path: 'src/validators/valibot', duplicateFinder: true, constraints: true },
    {
      kind: 'trpc',
      validation: { useShared: true, library: 'valibot', importPath: '../validators/valibot/index.js' },
    },
  ],
});
```

::: tip Need something else?
If this quickstart doesn't cover what you need, DM me on X (https://x.com/omardulaimidev) and we can scope it together.
:::
