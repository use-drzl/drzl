# Effect Platform HttpApi

`@drzl/generator-effect-http` emits [Effect Platform](https://effect.website) `HttpApi` groups from
your Drizzle schema: one group per table, declared against the Effect Schema modules
[`@drzl/generator-effect`](/generators/effect) already writes.

## The missing half of a story DRZL half told

DRZL has emitted Effect Schema modules for a while and stopped there, so a project using them had
the types and had to hand-write every endpoint that carries one.
`HttpApiEndpoint.post('create', '/').setPayload(InsertusersSchema)` is a two-line wrapper around a
schema that already exists, repeated five times per table.

This is the only DRZL generator with no per-library choice, because `HttpApi` declares its payloads
as Effect Schema and takes nothing else. A config naming another library is refused rather than
silently emitting endpoints that will not compile.

## Setup

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

## What is emitted

Per table, a group carrying five endpoints:

| Endpoint | Method and path      | Declares                              |
| -------- | -------------------- | ------------------------------------- |
| `list`   | `GET /users`         | `setUrlParams`, `addSuccess(Array)`   |
| `byId`   | `GET /users/:id`     | `setPath`, `addSuccess(NullOr)`       |
| `create` | `POST /users`        | `setPayload`, `addSuccess`            |
| `update` | `PATCH /users/:id`   | `setPath`, `setPayload`, `addSuccess` |
| `delete` | `DELETE /users/:id`  | `setPath`, `addSuccess(Boolean)`      |

A table with no primary key keeps `list` and `create`. A materialized view keeps `list` and `byId`,
because the database refuses every write to it.

Plus `index.ts`, which chains every group into one `HttpApi`:

```ts
export const api = HttpApi.make('api').add(usersGroup).add(postsGroup);
```

Chained, and that is not a style choice. `HttpApi` accumulates its groups through the return value
of each `.add`, so a client derived from `typeof api` knows about every endpoint. Written as
separate statements it would compile, run identically, and describe an API with no groups on it.

## Two details worth knowing

**A path parameter is a string.** A numeric key is declared `Schema.NumberFromString` rather than
`Schema.Number`; the latter refuses every request, since `"1"` is not a number. Effect names the
conversion cleanly where zod and valibot need a regex and a transform spelled out, but the mistake
underneath is the same one the [Hono generator](/generators/hono) measured first.

**`delete` is a reserved word.** The endpoint is `HttpApiEndpoint.del('delete', ...)` bound to a
local called `remove`, because a property name may be a reserved word and a variable name may not:
`client.users.delete(...)` is ordinary and `const delete = ...` is a syntax error.

## Deriving a client

```ts
import { HttpApiClient } from '@effect/platform';
import { api } from './api';

const program = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(api, { baseUrl: 'http://localhost:3000' });
  return yield* client.users.list({ urlParams: { limit: '10' } });
});
```

That derivation is the test this package leans on: an API whose chain did not accumulate has no
`users` key, so the client fails to compile.

## Options

| Option                  | Default  | What it does                                          |
| ----------------------- | -------- | ------------------------------------------------------ |
| `path`                  | `outDir` | Where the modules are written                          |
| `apiName`               | `'api'`  | The identifier the assembled `HttpApi` carries          |
| `validation.importPath` | derived  | Where the Effect schemas live, when it is not the sibling's `path` |
| `naming.routerSuffix`   | none     | Appended to each module name and group identifier      |
| `naming.procedureCase`  | none     | Casing for file names, identifiers and the URL prefix  |
