# ts-rest

`@drzl/generator-ts-rest` emits [ts-rest](https://ts-rest.com) contracts from your Drizzle schema:
one contract per table plus a root router, declared against the schemas a validation generator
already writes.

## A contract is nothing but its schemas

ts-rest inverts the usual arrangement. There is no router to implement and no handler to stub: a
contract is a plain object of methods, paths and schemas, and both the server implementation and the
typed client are derived from it. That makes it the surface where DRZL's output is closest to being
the whole artefact, because the schemas *are* the contract.

It is also the surface where the constrained schemas matter most. A ts-rest contract is what a
consumer in another language reads through the generated OpenAPI document, so a `CHECK` the analyzer
parsed into a bound travels all the way out to a client that never sees your database.

## Requires the 3.53 release candidate

```bash
npm install -D @drzl/generator-ts-rest
npm install @ts-rest/core@^3.53.0-rc.1
```

That version floor is deliberate and it is not caution about a number. `@ts-rest/core`'s `latest`
tag is 3.52.1, and it cannot be used here for two separate measured reasons:

**It cannot be installed beside zod 4.** 3.52.1 declares `zod: ^3.22.3` as a peer dependency, and
DRZL's zod generator requires `zod >=4.0.0`. npm refuses the tree outright:

```
npm error ERESOLVE could not resolve
npm error Conflicting peer dependency: zod@3.25.76
```

**With valibot or arktype it validates nothing, quietly.** 3.52.1 decides whether a schema is a
schema by testing `typeof obj?.safeParse === 'function'`. valibot and arktype expose `~standard` but
have no `.safeParse` method, so they fail that test and fall through to a branch that returns the
input unchanged as a success. Measured: a body of `{ email: 12345, wat: true }` came back as valid,
unknown key intact, against a schema requiring `email` to be a string.

3.53.0-rc.1 accepts any Standard Schema, drops the zod peer dependency, and validates through
`~standard.validate`. Both halves are pinned as tests in this package, so the day a stable release
fixes them, the floor can move and the suite says so.

## Setup

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

`zod`, `valibot` and `arktype` all work. TypeBox and Effect Schema do not, and the reason is the one
the [oRPC generator](/generators/orpc) gives: neither exposes `~standard` on the schema object, so
the contract would type against `any` and validate nothing. Effect users have a native surface in
[`@drzl/generator-effect-http`](/generators/effect-http).

## What is emitted

Per table, a contract carrying five routes:

| Route    | Method and path     | Declares                        |
| -------- | ------------------- | ------------------------------- |
| `list`   | `GET /users`        | `query`, `200: Array`           |
| `byId`   | `GET /users/:id`    | `pathParams`, `200`, `404`      |
| `create` | `POST /users`       | `body`, `201`, `400`            |
| `update` | `PATCH /users/:id`  | `pathParams`, `body`, `200`     |
| `remove` | `DELETE /users/:id` | `pathParams`, `200`, `404`      |

A table with no primary key keeps `list` and `create`. A materialized view keeps `list` and `byId`,
because the database refuses every write to it.

Plus `index.ts`, which assembles them into the root contract:

```ts
export const contract = c.router({
  users: usersContract,
  posts: postsContract,
});
```

## Two details worth knowing

**A path parameter is a string.** A numeric key is declared as a checked string that converts, not
as a number: `z.number()` against `"1"` refuses every request, and `z.coerce.number()` accepts an
empty segment as `0`. Same grid the [Hono generator](/generators/hono) measured first.

**Optionality is not one spelling.** Paging parameters are optional in every library, but zod and
valibot wrap the value while ArkType marks the *key*: `type({ 'limit?': 'string.numeric.parse' })`.
Emitting the value-wrapped form for all three left ArkType's paging required, so every `list` call
had to pass a `limit` and an `offset`. Caught by the compile test, whose probe calls
`list({ query: {} })`.

## Using the contract

```ts
import { initClient } from '@ts-rest/core';
import { contract } from './contract';

const client = initClient(contract, { baseUrl: 'http://localhost:3000', baseHeaders: {} });

const found = await client.users.byId({ params: { id: '7' } });
if (found.status === 200) {
  // Narrowed to the select row, not a union with the error body.
  console.log(found.body.email);
}
```

That derivation is the test this package leans on: a contract whose schemas did not land has no
`users` key, so the client fails to compile.

## Options

| Option                  | Default      | What it does                                                   |
| ----------------------- | ------------ | -------------------------------------------------------------- |
| `path`                  | `outDir`     | Where the modules are written                                  |
| `contractName`          | `'contract'` | The identifier the assembled root contract carries              |
| `pathPrefix`            | none         | Prefixed to every path, through ts-rest's own router option     |
| `validation.library`    | `'zod'`      | `zod`, `valibot` or `arktype`                                  |
| `validation.importPath` | derived      | Where the schemas live, when it is not the sibling's `path`     |
| `naming.routerSuffix`   | none         | Appended to each module name and contract identifier            |
| `naming.procedureCase`  | none         | Casing for file names, identifiers and the URL segment          |

`pathPrefix` is passed to ts-rest's `c.router(..., { pathPrefix })` rather than written into each
path string, because ts-rest lifts the prefix into the contract's type: a client derived from the
result reports the full path. Writing it in by hand would produce the same requests and a different
type.
