# TanStack Start server functions

`@drzl/generator-tanstack-start` emits `createServerFn()` definitions from your Drizzle schema: one
module per table, reads on `GET` and writes on `POST`, every payload validated by the schemas DRZL
already generates.

## The surface that needs no adapting

Measured on 2026-08-11 against `@tanstack/react-start` 1.168.42, and it is the cleanest fit of any
target DRZL generates for. `createServerFn().validator(schema)` takes any Standard Schema, and it is
properly variance-aware in **both** directions:

- The **handler** receives the schema's *output*, so a date column's `string -> Date` transform does
  real work at the boundary.
- The **caller** supplies the schema's *input*, so a date crosses the wire as an ISO string and
  passing a `Date` from the caller is a compile error.

zod, valibot and arktype were each compiled through it, transform included, and all three behave
identically. No adapter, no cast, no per-library escape.

That contrast is worth stating because the sibling case does not behave that way.
[TanStack Form](/examples/tanstack-form)'s validator constraint is *invariant*, since the Standard
Schema input type sits in a property, so a wider input is rejected exactly as a narrower one is and
no schema shape removes the cast documented there. Server functions have no such problem.

## What the generator decides that a hand-writer gets wrong

The method. `createServerFn` defaults to `GET`, which is right for a read and wrong for every write:
a mutation behind a cacheable verb is one an intermediary is entitled to replay. So reads are `GET`
and writes are `POST`, decided per operation rather than per file.

## Setup

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

That is the whole config. This generator emits no schemas of its own, so `validation.useShared` is
not a choice and the CLI turns it on; the import path is derived from the sibling generator's own
`path`. A config naming it with no validation generator beside it is reported.

## What is emitted

Per table:

| Function      | Method | Validator                        |
| ------------- | ------ | -------------------------------- |
| `listUsers`   | GET    | bounded `limit` and `offset`     |
| `getUsers`    | GET    | the primary key                  |
| `createUsers` | POST   | the insert schema                |
| `updateUsers` | POST   | `{ where, data }`                |
| `deleteUsers` | POST   | the primary key                  |

A table with no primary key keeps `list` and `create`. A materialized view keeps `list` and `get`,
because the database refuses every write to it.

`update` takes `{ where, data }` rather than a flat object, because the key would otherwise appear on
both sides with no way to tell the row being addressed from the value being set.

The key schema and the list bounds are this generator's own inventions: no validation generator
emits either, because only a caller addressing a row needs them. The page size is bounded rather
than open, since a `GET` payload rides in the URL and is a value anybody can set.

## One constraint worth knowing about

Start type-checks **both** ends of a server function for serialisability: the validator's input and
the handler's return value. A type of `unknown` fails either way, with
`Type 'unknown' is not assignable to type SerializationError<"Type may not be serializable">`.

That is reachable from a real schema. A `customType` column with no `$type<T>()` is one the analyzer
cannot type, so it reaches the schema as `unknown` and Start refuses the whole function. The fix is
to give the column a type in your Drizzle schema; nothing DRZL can do at generation time will make
an untyped column serialisable.

`Date` is fine, and so is every other type DRZL emits.

## Options

| Option                  | Default  | What it does                                            |
| ----------------------- | -------- | -------------------------------------------------------- |
| `path`                  | `outDir` | Where the modules are written                            |
| `validation.library`    | `zod`    | Which sibling generator's schemas the functions validate with |
| `validation.importPath` | derived  | Where those schemas live, when it is not the sibling's `path` |
| `naming.routerSuffix`   | none     | Appended to each module name and function name           |
| `naming.procedureCase`  | none     | Casing for file names and identifiers                    |
