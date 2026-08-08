# Seeding and Bulk Inserts

A seed is a script you own. That is the whole convention: Prisma 7 runs whatever command you
name in `prisma.config.ts` and only when you invoke `npx prisma db seed` (the automatic run
after `migrate reset` is gone), and Drizzle's official [`drizzle-seed`](https://www.npmjs.com/package/drizzle-seed)
generates deterministic fake data at volume. Neither helps with the other half of seeding: the
rows you actually mean. Demo accounts, lookup tables, the fixture graph your tests point at.
Those rows carry explicit keys so foreign keys can reference known rows, they hit real CHECK and
UNIQUE constraints, and when one of five hundred is wrong the database names a constraint rather
than a row.

DRZL already emits everything that turns that script from insert-and-pray into a checked
pipeline: insert schemas with the CHECK constraints folded in, a per-table
[duplicate finder](/generators/zod#duplicatefinder), and the foreign-key graph as plain data in
[`constraints.ts`](/generators/zod#constraints-the-tables-constraints-as-data). This page
composes them into a seed script and measures every step.

Measured 2026-08-08 with `drizzle-orm` 0.45.2, `zod` 4.4.3, PostgreSQL 17.10 (the
`postgres:17-alpine` image) over `pg` 8.22.0, and `@electric-sql/pglite` 0.5.4, on Node 22. The
script below ran against the real server twice plus two sabotage runs; the outputs are quoted
where each claim is made.

## The config

```ts
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: 'src/db/schema.ts',
  outDir: 'src/validators',
  generators: [
    {
      kind: 'zod',
      path: 'src/validators/zod',
      duplicateFinder: true, // findDuplicate<table> beside the schemas
      constraints: true, // constraints.ts: keys and foreign keys as data
    },
  ],
});
```

`duplicateFinder` exists in all five validator generators; `constraints` in zod and valibot.

## What goes wrong without the pre-flight

A 500-row `users` batch with one bad row (age 15 against `CHECK (age >= 18)`), inserted raw:

```
new row for relation "users" violates check constraint "users_age_check"
code: 23514  detail: Failing row contains (372, u371@x.co, U371, 15).
```

The server names the constraint and the row's values, never the row's position in your batch.
Nothing was inserted (a single multi-row `INSERT` is atomic, measured: count stayed 0), but the
serial sequence still advanced: retrying the same batch after two failed attempts showed the
same row as id 1116, so every failed attempt burns ids and your seeded rows drift away from the
ids your fixtures expect.

The same batch through the emitted insert schema first:

```
index 371  age: Too small: expected number to be >=18
```

Named row, named column, before a connection is opened. The CHECK is already inside the emitted
schema (`age: z.number().int().gte(18)`), which is what makes this equivalence hold. Cost of the
pre-flight, measured on 10,000 rows: 8.6ms to validate, 3.9ms to scan for duplicates.

## Step 1: validate

```ts
const invalid: { table: string; index: number; issues: string[] }[] = [];
for (const [name, rows] of Object.entries(fixtures)) {
  rows.forEach((row, index) => {
    const r = plan[name].schema.safeParse(row);
    if (!r.success)
      invalid.push({
        table: name,
        index,
        issues: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
  });
}
if (invalid.length) throw new Error('invalid fixtures: ' + JSON.stringify(invalid, null, 2));
```

## Step 2: refuse batches that collide with themselves

Uniqueness is the one constraint a per-row schema structurally cannot check, so the finder is a
separate emitted function. What it reports, measured against the emitted module:

| batch | report |
| ----- | ------ |
| two rows, same `email`, everything else different | `{ index: 1, constraint: 'email', firstIndex: 0 }` |
| same values, different property order | reported identically; keys are read by column name |
| three identical rows | index 1 and index 2, each pointing at `firstIndex: 0` |
| two rows with the same explicit `id: 7`, different emails | `{ index: 1, constraint: 'users_pkey', firstIndex: 0 }` |
| two `skus` rows with the same `code` (a natural primary key) | `{ index: 1, constraint: 'skus_pkey', firstIndex: 0 }` |
| `(userId, org)` pair repeated with a different `role` | one report naming the composite constraint |
| rows that omit a serial `id`, or hold `null` in a key column | nothing, matching SQL: a unique index permits repeated NULLs, and an absent key is the database's to fill |

The primary key rows are the seed case: fixtures carry explicit ids so foreign keys can point at
known rows, and the database enforces the key with a unique index (its own error for the `skus`
collision reads `duplicate key value violates unique constraint "skus_pkey"`, code 23505). What
the finder cannot see is a collision with rows already stored; that half belongs to
`onConflictDoNothing` below.

```ts
const collisions: { table: string; index: number; constraint: string; firstIndex: number }[] = [];
for (const [name, rows] of Object.entries(fixtures)) {
  for (const d of plan[name].dupes(rows)) collisions.push({ table: name, ...d });
}
if (collisions.length)
  throw new Error('duplicate fixtures: ' + JSON.stringify(collisions, null, 2));
```

## Step 3: parents before children

Child first fails, measured:

```
insert or update on table "posts" violates foreign key constraint "posts_author_id_fkey"
code: 23503  detail: Key (author_id)=(1) is not present in table "users".
```

The emitted `constraints.ts` carries every foreign key as data, so the order does not have to be
maintained by hand as the schema grows:

```ts
import { constraintsByTable } from './src/validators/zod/constraints';

/** Insert order: every table after the tables its foreign keys point at. */
function insertOrder(byTable: typeof constraintsByTable): string[] {
  const bySqlName = new Map(Object.entries(byTable).map(([exp, t]) => [t.table, exp]));
  const deps = new Map<string, Set<string>>();
  for (const [exp, t] of Object.entries(byTable)) {
    const set = new Set<string>();
    for (const c of t.constraints) {
      if (c.kind !== 'foreignKey') continue;
      const parent = bySqlName.get(c.references.table);
      if (parent && parent !== exp) set.add(parent); // a self-reference orders nothing
    }
    deps.set(exp, set);
  }
  const order: string[] = [];
  while (deps.size) {
    const ready = [...deps.keys()].filter((k) => [...deps.get(k)!].every((d) => !deps.has(d)));
    if (!ready.length)
      throw new Error(`circular foreign keys between: ${[...deps.keys()].join(', ')}`);
    for (const k of ready.sort()) {
      order.push(k);
      deps.delete(k);
    }
  }
  return order;
}
```

Run against a schema with a `users -> posts -> comments` chain, a `memberships` join table and a
self-referencing `categories`, this returned
`["audit", "categories", "skus", "users", "wide", "memberships", "posts", "comments"]`: every
child after its parents, and the self-reference did not deadlock. A self-referencing table
orders its own rows, not tables: put parent categories before their children inside the fixture
array, or seed `parentId: null` and update after.

## Step 4: chunk under the wire limit

The Postgres extended-query protocol counts bind parameters in 16 bits, and each provided column
of each row is one parameter. Measured against PostgreSQL 17.10 over `pg`, on a 15-column table:

| rows | parameters | result |
| ---- | ---------- | ------ |
| 4369 | 65,535 | insert OK, 182ms |
| 4370 | 65,550 | `bind message has 14 parameter formats but 0 parameters` |
| 5000 | 75,000 | `bind message has 9464 parameter formats but 0 parameters` |

The ceiling is exactly 65,535. One row past it, nothing on the client objects: the 16-bit count
silently wraps (65,550 mod 65,536 = 14, and the server's error is quoting your wrapped count
back at you), the server rejects the malformed message, and nothing is inserted.

PGlite's ceiling is half that, and the failure is worse than an error. Measured with a fresh
instance per probe:

| rows | parameters | result |
| ---- | ---------- | ------ |
| 2184 | 32,760 | insert OK, session fine |
| 2185 | 32,775 | insert reports OK, then **every later query on that connection returns zero rows**, silently |

Past the signed 16-bit boundary (32,767) the PGlite session is wedged: `select 1` comes back
empty, no error is thrown. A seed that "succeeded" and then reads nothing back is this.

So the chunk size is derived, not guessed:

```ts
const width = new Set(rows.flatMap(Object.keys)).size; // provided columns only
const chunk = Math.floor(32767 / width); // 65535 if PGlite will never run this
```

Provided columns, not table width: a column you omit renders as `DEFAULT` in the statement and
carries no parameter (visible in the measured statement text:
`values (default, $1, $2, $3), ...` for an omitted serial id). The `Set` union across rows is
conservative when rows provide different keys. And guard the empty batch:
`values([])` throws `values() must be called with at least one value`.

## Step 5: one transaction, idempotent

Three facts, measured in order:

- Three chunks without a transaction, failure in the second: the 200 rows of chunk one stayed.
  A partial seed is worse than no seed, so the loop belongs inside `db.transaction` (same
  failure inside it: 0 rows persisted).
- `onConflictDoNothing()` makes re-runs idempotent: the second full run inserted 0 rows per
  table, no error.
- `onConflictDoNothing()` also swallows collisions **inside** one batch: two rows with the same
  primary key in one `values()` call succeeded and stored one row. That is exactly the fixture
  mistake step 2 catches, which is why the finder runs even though the insert would "succeed"
  without it. The upsert variant does not forgive it: the same batch under `onConflictDoUpdate`
  fails with `ON CONFLICT DO UPDATE command cannot affect row a second time` (code 21000), so
  dedupe before an upsert is mandatory, not hygiene.

## The whole script

```ts
// seed.ts, run with: npx tsx seed.ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as t from './src/db/schema';
import * as v from './src/validators/zod';
import { constraintsByTable } from './src/validators/zod/constraints';

const fixtures = {
  users: [
    { id: 1, email: 'ada@example.com', name: 'Ada', age: 36 },
    { id: 2, email: 'lin@example.com', name: 'Lin', age: 29 },
  ],
  posts: [
    { id: 1, authorId: 1, slug: 'hello', title: 'Hello' },
    { id: 2, authorId: 2, slug: 'world', title: 'World' },
  ],
};

const plan = {
  users: { table: t.users, schema: v.InsertusersSchema, dupes: v.findDuplicateusers },
  posts: { table: t.posts, schema: v.InsertpostsSchema, dupes: v.findDuplicateposts },
};

// insertOrder from step 3 here

async function seed(db: ReturnType<typeof drizzle>) {
  // 1. validate (step 1)  2. dedupe (step 2), both throwing before any connection is used

  const order = insertOrder(constraintsByTable).filter((n) => fixtures[n]?.length);
  const counts: Record<string, number> = {};
  await db.transaction(async (tx) => {
    for (const name of order) {
      const rows = fixtures[name];
      const width = new Set(rows.flatMap(Object.keys)).size;
      const chunk = Math.floor(32767 / width);
      let inserted = 0;
      for (let i = 0; i < rows.length; i += chunk) {
        const res = await tx
          .insert(plan[name].table)
          .values(rows.slice(i, i + chunk))
          .onConflictDoNothing();
        inserted += res.rowCount ?? 0;
      }
      counts[name] = inserted;
    }
  });
  return counts;
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
console.log(await seed(drizzle(pool)));
await pool.end();
```

Measured end to end against PostgreSQL 17.10, with the plan extended to all four fixture tables
and the step 1 and step 2 guards inlined:

```
first run:  {"skus":2,"users":2,"memberships":2,"posts":2}
second run: {"skus":0,"users":0,"memberships":0,"posts":0}
```

and both sabotage runs (a duplicated explicit id, an under-age row) aborted before any insert.
`res.rowCount` is the count actually inserted, so the second run reporting zeros is the
idempotence check for free.

::: tip Need something else?
If this example doesn't cover what you need, DM me on X (https://x.com/omardulaimidev) and we can scope it together.
:::
