---
layout: home
title: DRZL
titleTemplate: Code generation for Drizzle ORM
description: DRZL reads your Drizzle schema and generates the validation schemas, API routers and typed services that go with it. Twenty-seven generators, one install.
---

## Constraints, and what they cost

DRZL also reads the `CHECK` constraints declared on your table, which most generators skip, so a row
that passes the generated schema is a row the database will accept. On the eight-column table the
benchmark uses that is **four of the four constraints, against none**. Each one the first-party
schema misses is a row that passes validation and then fails at the database, which is the worst
place to find out.
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
