# openapi-fetch

`@drzl/generator-openapi-fetch` emits a typed [openapi-fetch](https://openapi-ts.dev/openapi-fetch/)
client from your Drizzle schema: one `client.ts` carrying the `paths` type and a factory, derived
from the same OpenAPI document DRZL already writes.

## It reads the document rather than re-deriving it

The [JSON Schema generator](/generators/json-schema) with `document: true` emits the whole OpenAPI
document, paths and operations and all. This generator calls the same builder and walks its output,
so a route that exists in one exists in the other by construction.

That is deliberate. A client and a document that each derive the path set from the tables agree
right up until one of them changes, and nothing reports the day they stop. DRZL made this mistake
once already, with a drift report and the SQL that closes it, and fixed it the same way: one side
reads the other.

## Setup

```bash
npm install -D @drzl/generator-openapi-fetch
npm install openapi-fetch
```

```ts
// drzl.config.ts
export default {
  schema: './src/db/schema.ts',
  outDir: './src/api',
  generators: [
    { kind: 'zod', path: './src/validators/zod' },
    { kind: 'openapi-fetch', path: './src/api/client' },
  ],
} as const;
```

The client needs the row types, so a validation generator has to be in the config. Its
`importPath` is derived from that entry's own `path`, so a config naming both and nothing else is
complete. The generator refuses rather than emitting a client typed against `unknown`:

```
@drzl/generator-openapi-fetch: a client is nothing but its types, so it needs
validation.useShared and validation.importPath pointing at a validation generator's
output directory.
```

## What it emits

```ts
import createClient, { type ClientOptions } from "openapi-fetch";
import type { InsertusersInput, SelectusersOutput, UpdateusersInput } from "../../validators/zod/index.js";

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}

export interface paths {
  "/users": {
    get: {
      responses: {
        200: { content: { "application/json": SelectusersOutput[] } };
      };
    };
    post: {
      requestBody: {
        content: { "application/json": InsertusersInput };
      };
      responses: {
        201: { content: { "application/json": SelectusersOutput } };
        400: { content: { "application/json": ApiError } };
        409: { content: { "application/json": ApiError } };
      };
    };
  };
  "/users/{id}": {
    get: {
      parameters: {
        path: {
          "id": number;
        };
      };
      responses: {
        200: { content: { "application/json": SelectusersOutput } };
        400: { content: { "application/json": ApiError } };
        404: { content: { "application/json": ApiError } };
      };
    };
    // patch and delete follow
  };
}

export function createApiClient(options: ClientOptions) {
  return createClient<paths>(options);
}

export type ApiClient = ReturnType<typeof createApiClient>;
```

Calling it:

```ts
import { createApiClient } from './api/client/client.js';

const client = createApiClient({ baseUrl: 'https://api.example.com' });

const { data, error } = await client.GET('/users/{id}', { params: { path: { id: 1 } } });
if (error) console.error(error.message); //   typed, because the 404 and 400 are declared
else console.log(data.email); //              typed from the select schema
```

A factory rather than a ready-made client, because a `baseUrl` is a fact about a deployment and not
about a Drizzle schema. Baking one in would put an environment into generated code.

## The path parameter is the real primary key

```ts
"id": number   // integer primary key
"slug": string // text primary key
```

The document puts the column's own schema on the parameter rather than a string, and this reads it.
A table with no primary key gets its collection path and no `/{id}` path at all, because nothing
addresses one of its rows. `@drzl/generator-orpc` answers this differently, by emitting
`z.object({ id: z.number() })` for every table; the objection to that is sharper here than there,
because an OpenAPI client is read by code generators in other languages with nothing to check it
against.

## Why not `openapi-typescript`

`openapi-typescript` turns an OpenAPI document into a `paths` type already, and running it over
DRZL's document works. It emits far more than `createClient` needs. Measured against
`openapi-fetch` 0.17.0, three shapes type identically, each checked with canaries for an undeclared
path, an undeclared verb, a wrong path-parameter type and a missing required parameter:

| Shape | Lines for a 5-path document |
| ----- | --------------------------- |
| `openapi-typescript`'s output | 426 |
| the same without the `operations` table and `?: never` padding | fewer |
| the same again without `headers` | fewest, and what this emits |

So the emitted type is the third. Nothing about the typing is weaker for it, and the result is
short enough to read.

If you would rather use `openapi-typescript`, nothing here stops you: emit the document with
`{ kind: 'json-schema', document: { format: 'json' } }` and point the tool at `openapi.json`.

## Keep `document` in step

Both this generator and the `json-schema` generator read a `document` option, and they are separate
generators that never see each other's config. Give both the same value:

```ts
generators: [
  { kind: 'zod', path: './src/validators/zod' },
  { kind: 'json-schema', path: './src/api/openapi', document: { validationStatus: 422 } },
  { kind: 'openapi-fetch', path: './src/api/client', document: { validationStatus: 422 } },
]
```

`validationStatus` is the one that bites: it lands in the emitted document *and* in the client's
response keys, so a mismatch produces a client that declares a status the document does not.

## What openapi-fetch does not catch

**An excess body field compiles.** Measured 2026-08-12:

```ts
await client.POST('/users', { body: { email: 'a@b.c', nope: 1 } }); //   accepted
await client.POST('/users', { body: { email: 7 } }); //                  refused
```

TypeScript's excess-property check applies to an object literal assigned to a typed target, and it
is lost through openapi-fetch's generic `init` parameter. `openapi-typescript`'s own output behaves
identically, so this is not something the emitted shape causes or can fix. The generator's suite
asserts the limitation, so a release that closes it fails a test and this page gets corrected rather
than quietly going stale.

**An undeclared path reports an odd message.** `client.GET('/nope')` is refused as
`TS2554: Expected 2 arguments, but got 1` rather than as anything naming the path, because overload
resolution falls through to a signature requiring an init argument. The call is refused, which is
what matters.

## Options

| Option | Default | What it does |
| ------ | ------- | ------------ |
| `path` | `outDir` | Where `client.ts` is written |
| `clientName` | `createApiClient` | The exported factory's name |
| `document` | `{}` | Forwarded to the document builder; keep it equal to the `json-schema` entry's |
| `validation.library` | `zod` | Which validation generator's types to import |
| `validation.importPath` | derived | Where those types are, if the sibling entry's `path` is not it |
| `format` | inherited | Formatter settings |
| `outputHeader` | inherited | The generated-file banner |
| `importExtension` | `js` | How the emitted relative import spells its extension |

See also: [JSON Schema](/generators/json-schema) · [ts-rest](/generators/ts-rest) ·
[Configuration](/guide/configuration)
