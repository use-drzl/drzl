---
'@drzl/generator-trpc': minor
'@drzl/cli': minor
---

A tRPC generator, `@drzl/generator-trpc`, and the CLI wiring for it.

`drzl generate` takes a `{ kind: 'trpc' }` generator, `drzl generate:trpc <schema>` runs it without
a config, and `drzl watch --pipeline generate-trpc` rebuilds only it. The package is an **optional**
dependency of `@drzl/cli`, like the json-schema generator: a package that has never been published
cannot publish through npm's trusted-publisher flow, so its first version goes out by hand, and
naming it as a hard dependency in the same release would break `npm i @drzl/cli` until it exists.

**Targets tRPC v11**, determined from the registry rather than from memory: `latest` is 11.x, majors
1 through 11 are published and there is no 12, and `next` points behind `latest`, so there is not
even a pre-release train to aim at. Every construct emitted was run against a real 11.18.0 install.

Three kinds of file per run. `trpc.ts` holds the single `initTRPC` instance the whole tree shares,
which has no counterpart in the oRPC output and is not optional: tRPC's builder carries the context
type with it, so a router built from its own `initTRPC.create()` cannot share middleware and cannot
be soundly merged. `<table>.ts` is one router per table. `index.ts` builds `appRouter` with
`router()` and exports `type AppRouter`, which is the entire client contract.

Per table: `list` and `byId` as queries, `create`, `update` and `delete` as mutations, each with an
`.output(...)` schema, plus one `listBy<Column>` query per single-column foreign key under
`includeRelations`. Reads are queries and writes are mutations because a tRPC client caches and
batches queries over `GET` and never puts a mutation there.

**The primary key is read off the schema.** A `varchar` key called `isbn` produces
`byId({ isbn: string })`. A composite key produces `byId({ orgId, userId })`. A table with **no**
primary key gets `list` and `create` only, rather than a fabricated `id`. A read-only relation gets
`list` and `byId` only, and no insert or update schema is imported for it. The emitted tree is
compiled by `tsc` under `strict` and `moduleResolution: nodenext` for every one of those shapes and
for all three validators, and stood up as a real HTTP server and driven with real requests, in this
package's own test suite.

TypeBox cannot be used with this generator, and that is measured rather than assumed: tRPC v11
recognises a validator through Standard Schema, and `@sinclair/typebox` 0.34 puts no `~standard` key
on what `Type.Object()` returns. `validation.library` accepts zod, valibot and arktype, all three of
which were run through a real router.

---

Three CLI wiring defects, all of the same species, found by generating output and reading it rather
than by reading the wiring:

- **`databaseInjection` was documented and unreachable.** It has been on the oRPC generator's
  documented options since it was added, and `GeneratorSchema` had no such key. That schema is not
  strict, so zod stripped it in silence and the option did nothing at all when set from a config
  file. It is in the schema now, and passed by both router branches.
- **`watch` never passed `servicesDir`.** `generate` computes it from the `service` generator's
  `path` and passes it; `watch`'s oRPC branch did not, so a rebuild emitted a service import
  pointing at the default directory whatever the config said. The first save after starting
  `drzl watch` silently replaced a correct import with a wrong one.
- **`databaseInjection` reached only one of the two generators that have to agree about it.** A
  router in injection mode emits `Service.getById(ctx.db, id)`, and only a service generated in the
  same mode has a `db` parameter to receive it. It is declared once on the router generator and
  pushed onto the `service` generator by `resolveConfig`, the same mechanism that already pulls
  `validation.affix` the other way. `@drzl/generator-service` honours the flag only while emitting
  real Drizzle queries, so pairing it with `dataAccess: 'stub'` now warns instead of emitting calls
  that cannot compile.

The tRPC branches of `generate` and `watch` build their options through one shared function, and
`packages/cli/test/trpc-branch-parity.spec.ts` runs both commands over a config that sets every
option and compares the bytes, because reading the two branches is what missed all three above.
