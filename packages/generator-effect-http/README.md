# @drzl/generator-effect-http

Generate [Effect Platform](https://effect.website) `HttpApi` groups from a Drizzle schema: one group
per table, declared against the Effect Schema modules `@drzl/generator-effect` already writes.

## The missing half

DRZL has emitted Effect Schema modules for a while and stopped there, so a project using them had
the types and had to hand-write every endpoint that carries one.
`HttpApiEndpoint.post('create', '/').setPayload(InsertusersSchema)` is a two-line wrapper around a
schema that already exists, repeated five times per table.

This is the only DRZL generator with no per-library choice: `HttpApi` declares its payloads as
Effect Schema and takes nothing else.

## Install

```bash
npm install -D @drzl/generator-effect-http
npm install @effect/platform effect
```

```ts
// drzl.config.ts
export default {
  schema: './src/db/schema.ts',
  generators: [
    { kind: 'effect', path: 'src/validators/effect' },
    { kind: 'effect-http', path: 'src/api' },
  ],
};
```

## Two details worth knowing

A path parameter is a string, so a numeric key is `Schema.NumberFromString` rather than
`Schema.Number`, which would refuse every request.

`delete` is a reserved word, so the endpoint is `HttpApiEndpoint.del('delete', ...)` bound to a local
called `remove`: a property name may be a reserved word and a variable name may not.

The barrel chains every group into one `HttpApi`, which is what lets `HttpApiClient.make` derive a
client that knows every endpoint. Written as separate statements it would compile and describe
nothing.

Full documentation: https://use-drzl.github.io/drzl/generators/effect-http

## Licence

Apache-2.0. Generated output is yours under your own project's licence.
