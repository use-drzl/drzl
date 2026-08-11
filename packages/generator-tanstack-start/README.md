# @drzl/generator-tanstack-start

Generate [TanStack Start](https://tanstack.com/start) server functions from a Drizzle schema: one
module per table, reads on `GET` and writes on `POST`, every payload validated by the schemas DRZL
already emits.

## The surface that needs no adapting

Measured on 2026-08-11 against `@tanstack/react-start` 1.168.42.
`createServerFn().validator(schema)` takes any Standard Schema and is properly variance-aware in
both directions: the handler receives the schema's **output**, so a date column's `string -> Date`
transform does real work at the boundary, and the caller supplies its **input**, so a date crosses
the wire as an ISO string and passing a `Date` from the caller is a compile error. zod, valibot and
arktype all behave identically. No adapter, no cast.

## What the generator decides

The method. `createServerFn` defaults to `GET`, which is right for a read and wrong for every write:
a mutation behind a cacheable verb is one an intermediary is entitled to replay.

## Install

```bash
npm install -D @drzl/generator-tanstack-start
```

```ts
// drzl.config.ts
export default {
  schema: './src/db/schema.ts',
  generators: [
    { kind: 'zod', path: 'src/validators/zod' },
    { kind: 'tanstack-start', path: 'src/server/fns' },
  ],
};
```

This generator emits no schemas of its own, so the CLI turns on `validation.useShared` and derives
the import path from the sibling generator's `path`.

## One constraint worth knowing about

Start type-checks both ends of a server function for serialisability: the validator's input and the
handler's return value. A type of `unknown` fails either way. That is reachable from a real schema:
a `customType` column with no `$type<T>()` is one the analyzer cannot type, so it arrives as
`unknown` and Start refuses the whole function. Give the column a type in your Drizzle schema.
`Date` is fine, and so is everything else DRZL emits.

Full documentation: https://drzl.dev/generators/tanstack-start

## Licence

Apache-2.0. Generated output is yours under your own project's licence.
