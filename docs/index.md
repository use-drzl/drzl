---
layout: home
title: DRZL
hero:
  # name: DRZL
  text: Developer tooling for Drizzle ORM
  tagline: Analyze schemas. Generate services, routers (adapter-based), and validation.
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
  - title: Generators
    details: Routers and servers (oRPC, tRPC, Hono, Express, Fastify, NestJS, GraphQL), typed services (with serverless-friendly database injection), and validation schemas (Zod, Valibot, ArkType, TypeBox, Effect, JSON Schema).
  - title: Templates
    details: Adapter templates for quick scaffolding or service wiring. Request custom templates as a paid service.
---

## What it costs, and what it buys

The table, the script that produces it and the machine it was measured on are on
[Benchmarks](/guide/benchmarks). What is worth knowing before you go there:

- **Four of the four constraints, against none.** Each one the first-party schema misses is a row
  that passes validation and then fails at the database, which is the worst place to find out.
- **Rejecting a bad row costs about the same either way**, within a few percent, and that is the
  path an API actually spends its validation time in.
- **Accepting a good row costs DRZL 15% to 21% more**, depending on the run. That is the price of
  the four extra checks, and it is the one row where DRZL is behind.

The throughput figures, the generated file size and the machine they were measured on stay on the
benchmarks page rather than being repeated here. Those are one machine's numbers, and a second copy
of a measurement is a copy that goes stale quietly: the byte count on that page named a size the
generator had stopped emitting, and it sat there for a week with every build, test and lint green.

The first bullet is not a measurement of a machine. It is a count of constraints in a fixed
fixture, and the same question is put to a real Postgres, a real SQLite and a real MySQL on every
commit, which is [how it is verified](/guide/verification).

## Funded Features

- _None yet. Be the first!_ Need a template, generator, or adapter that doesn’t exist yet? DM me on X (https://x.com/omardulaimidev) to fund it. All funded work ships back into DRZL under Apache‑2.0.
