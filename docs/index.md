---
layout: home
title: DRZL
hero:
  # name: DRZL
  text: Developer tooling for Drizzle ORM
  tagline: Analyze schemas. Generate validation, services, and routers for seven stacks.
  image:
    light: /brand/logo.png
    dark: /brand/logo-dark.png
    alt: DRZL logo
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: CLI
      link: /cli
    - theme: alt
      text: Benchmarks
      link: /guide/benchmarks
features:
  - title: Four of four constraints, against none
    details: The benchmark table has eight columns, four of them carrying a CHECK the database enforces. The generated schema reproduces all four. drizzle-orm/zod reproduces none of them.
    link: /guide/benchmarks
    linkText: The run, and the machine it ran on
  - title: Schema Analyzer
    details: Normalize Drizzle schemas into a portable Analysis for generators.
    link: /packages/analyzer
    linkText: What an Analysis holds
  - title: Typed services
    details: Typed static methods per table, with serverless-friendly database injection, under whichever router you generate beside them.
    link: /generators/service
    linkText: The service generator
  - title: Templates
    details: Adapter templates for quick scaffolding or service wiring. Request custom templates as a paid service.
    link: /templates/custom
    linkText: Custom templates
---

## What it generates

Point it at the Drizzle schema you already have and run `npx drzl generate`. This table in
`src/schema.ts`, with three `CHECK` constraints on it:

```ts [src/schema.ts]
import { pgTable, text, integer, varchar, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const users = pgTable(
  'users',
  {
    id: integer().primaryKey(),
    email: varchar({ length: 255 }).notNull(),
    name: text().notNull(),
    age: integer().notNull(),
    tier: text().notNull(),
  },
  (t) => [
    check('age_c', sql`${t.age} >= 18`),
    check('tier_c', sql`${t.tier} IN ('free', 'pro', 'team')`),
    check('name_c', sql`length(${t.name}) >= 2`),
  ]
);
```

produces `src/gen/zod/users.zod.ts` beside it, unedited and shown down to the insert schema:

```ts [src/gen/zod/users.zod.ts]
import { z } from 'zod';

export const InsertusersSchema = z.object({
  id: z.number().int().gte(-2147483648).lte(2147483647),
  email: z.string().refine((v) => [...v].length <= 255, { message: 'at most 255 characters' }),
  name: z.string().refine((v) => [...v].length >= 2, { message: 'name_c: length(name) >= 2' }),
  age: z.number().int().gte(18).lte(2147483647),
  tier: z.enum(['free', 'pro', 'team'] as const),
});
```

Three `CHECK` constraints went in and three came out. `age >= 18` folded into the bound zod already
had, so it costs nothing extra to check and fails with zod's own message, with the number
machine-readable on the issue rather than inside a string a generator wrote. `tier IN (...)` became
an enum. `length(name) >= 2` stayed a refinement, because SQL counts characters and JavaScript's
`.length` counts UTF-16 units. The update and select schemas, and the types for all three, are in
the same file.

On the same table `drizzle-orm/zod` emits `z.string()` for `tier` and for `name`, and the plain
int32 range for `age`. It accepts all three of the rows Postgres will refuse.

## What it costs

**Four of the four constraints, against none**, on the eight-column table the benchmark uses. Each
one the first-party schema misses is a row
that passes validation and then fails at the database, which is the worst place to find out.
Rejecting a bad row costs about the same either way, within a few percent, and that is the path an
API actually spends its validation time in. Accepting a good row costs DRZL 15% to 21% more,
depending on the run, and that is the price of the four extra checks.

The throughput figures, the generated file size and [the machine they were measured
on](/guide/benchmarks) stay on one page rather than being repeated here: a second copy of a
measurement is a copy that goes stale quietly. The constraint count is not a measurement of a
machine, and the same question is put to a real Postgres, a real SQLite and a real MySQL on every
commit, which is [how it is verified](/guide/verification).

## Funded Features

- _None yet. Be the first!_ Need a template, generator, or adapter that doesn’t exist yet? DM me on X (https://x.com/omardulaimidev) to fund it. All funded work ships back into DRZL under Apache‑2.0.
