# @drzl/generator-openapi-fetch

A typed [openapi-fetch](https://openapi-ts.dev/openapi-fetch/) client, generated from your Drizzle
schema.

Part of [DRZL](https://github.com/use-drzl/drzl). Full documentation:
[Generators → openapi-fetch](https://use-drzl.github.io/drzl/generators/openapi-fetch).

## Install

```bash
npm install -D @drzl/generator-openapi-fetch
npm install openapi-fetch
```

## Use

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

```ts
import { createApiClient } from './api/client/client.js';

const client = createApiClient({ baseUrl: 'https://api.example.com' });

const { data, error } = await client.GET('/users/{id}', { params: { path: { id: 1 } } });
if (error) console.error(error.message);
else console.log(data.email);
```

## What it does

Emits one `client.ts`: a `paths` interface in the shape `createClient` takes, plus a factory bound
to it.

The `paths` type is derived from the same OpenAPI document `@drzl/generator-json-schema` emits, by
calling that builder and walking its output rather than deriving the routes a second time. A path
that exists in one exists in the other by construction.

The path parameter is the table's real primary key, so an integer key is typed `number` and a text
key `string`, and a table with no primary key gets no single-row path at all. The request and
response bodies are the insert, update and select types a validation generator already exports, so
a nullable column is nullable and a defaulted column is optional on insert and required on select.

The non-2xx responses the document declares are carried too, which is what makes `error` readable
without a cast.

## Requires a validation generator

A client is nothing but its types, so the config has to name one. The import path is derived from
that entry's own `path`. The generator refuses rather than emitting a client typed against
`unknown`.

## License

Apache-2.0
