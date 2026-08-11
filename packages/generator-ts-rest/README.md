# @drzl/generator-ts-rest

Generate [ts-rest](https://ts-rest.com) contracts from a Drizzle schema: one contract per table plus
a root router, declared against the schemas a validation generator already writes.

## A contract is nothing but its schemas

ts-rest has no router to implement and no handler to stub. A contract is a plain object of methods,
paths and schemas, and both the server implementation and the typed client are derived from it, so
this is the surface where DRZL's output is closest to being the whole artefact.

## Install

```bash
npm install -D @drzl/generator-ts-rest
npm install @ts-rest/core@^3.53.0-rc.1
```

```ts
// drzl.config.ts
export default {
  schema: './src/db/schema.ts',
  generators: [
    { kind: 'zod', path: 'src/validators/zod' },
    { kind: 'ts-rest', path: 'src/contract' },
  ],
};
```

## Why the release candidate

`@ts-rest/core`'s `latest` tag is 3.52.1, and it cannot be used here for two measured reasons.

It declares `zod: ^3.22.3` as a peer dependency, and DRZL's zod generator requires `zod >=4.0.0`, so
npm refuses to put them in the same tree at all: `ERESOLVE ... Conflicting peer dependency`.

With valibot or arktype it is worse, because it is quiet. 3.52.1 decides whether a schema is a schema
by testing `typeof obj?.safeParse === 'function'`, and anything failing that test falls through to a
branch returning the input unchanged as a success. valibot and arktype expose `~standard` and have no
`.safeParse` method, so a contract built from either validates nothing. Measured: a body of
`{ email: 12345, wat: true }` came back valid against a schema requiring a string.

3.53.0-rc.1 accepts any Standard Schema, drops the zod peer, and validates through
`~standard.validate`. Both halves are pinned as tests here, so a stable release that fixes them makes
this suite say so.

`zod`, `valibot` and `arktype` all work. TypeBox and Effect Schema do not: neither exposes
`~standard` on the schema object, so the contract would type against `any`. Effect users have
`@drzl/generator-effect-http`.

## Two details worth knowing

A path parameter is a string, so a numeric key is a checked string that converts rather than a
number: `z.number()` refuses every request and `z.coerce.number()` takes an empty segment as `0`.

Optionality is not one spelling. zod and valibot wrap the value; ArkType marks the key,
`type({ 'limit?': 'string.numeric.parse' })`. Emitting the value-wrapped form for all three left
ArkType's paging required on every list route.

Full documentation: https://drzl.dev/generators/ts-rest

## Licence

Apache-2.0. Generated output is yours under your own project's licence.
