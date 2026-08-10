<div align="center">

# @drzl/generator-json-schema

<div align="center">

[![CI](https://github.com/use-drzl/drzl/actions/workflows/ci.yml/badge.svg)](https://github.com/use-drzl/drzl/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40drzl%2Fgenerator-json-schema)](https://www.npmjs.com/package/@drzl/generator-json-schema)

</div>

JSON Schema and OpenAPI schemas from your Drizzle analysis (insert / update / select).

No runtime dependency. The output is data.

</div>

## 💚 Sponsor DRZL

<div align="center">

<strong>DRZL is crafted nights & weekends. Sponsorships keep the generators fast, tested, and free.</strong>

[![Sponsor DRZL](https://img.shields.io/badge/GitHub%20Sponsors-Support%20the%20project-ff69b4?logo=github)](https://github.com/sponsors/omar-dulaimi)

</div>

- Every dollar speeds up CI hardware and offsets long test runs on my aging laptop.
- Sponsors get roadmap input and priority responses in GitHub Issues.
- Prefer a quick overview? The current goals and thank-yous are at
  https://use-drzl.github.io/drzl/sponsor.

## Use

Add to `drzl.config.ts`:

```ts
generators: [{ kind: 'json-schema', path: 'src/validators/json-schema' }];
```

## Output

- `Insert<Table>Schema`, `Update<Table>Schema`, `Select<Table>Schema`, each a plain object
  declared `as const`
- Optional `index` barrel

## OpenAPI

```ts
generators: [{ kind: 'json-schema', target: 'openapi-3.1', components: true, document: true }];
```

`components: true` writes `components.ts`, ready to spread into a document's `components.schemas`.
`document: true` writes `openapi.ts` (and `openapi.json` with `document: { format: 'both' }`): the
whole document, with a collection and an item path per table, the verbs on each, the request and
response body per verb, and the status codes, including the one a schema causes when it refuses a
request.

The path parameter is the table's real primary key, every column of it, at its real type, so a uuid
key is `/sessions/{token}` and a composite key is `/org_members/{orgId}/{userId}`. A table with no
primary key keeps its collection paths and loses the by-id ones rather than gaining a fictional
`id`. `servers` is absent unless you supply one, which the specification reads as a single server
at `/`. See
[the OpenAPI document docs](https://use-drzl.github.io/drzl/generators/openapi) for the whole set.

## Dialect

```ts
generators: [{ kind: 'json-schema', target: 'openapi-3.0' }];
```

`draft-2020-12` (default), `openapi-3.1`, or `openapi-3.0`. The last is a different dialect rather
than an older version: nullable is `nullable: true` rather than a type array, an exclusive bound is
a boolean beside the bound rather than its own keyword, a pinned value is a one-value `enum` rather
than `const`, and base64 bytes are `format: 'byte'` rather than `contentEncoding`. Since an unknown
keyword is ignored rather than rejected in JSON Schema, emitting the wrong one produces a document
that validates and then accepts what the constraint exists to reject; inside an OpenAPI 3.0
document it is worse than that, because 3.0's Schema Object is closed and one unknown keyword makes
the whole document invalid.

See [the full generator docs](https://use-drzl.github.io/drzl/generators/json-schema) for what the
format cannot express and how each column type survives `JSON.stringify`.

## Custom names

`affix` renames the exported schemas and type aliases, and `tableCase: 'pascal'` upper-camels
the Drizzle export name (`users` -> `Users`) instead of interpolating it verbatim. Omit it and
the names above are unchanged.

```ts
generators: [
  {
    kind: 'json-schema',
    path: 'src/validators/json-schema',
    affix: {
      tableCase: 'pascal',
      schema: { suffix: 'Schema' },
      type: {
        prefix: { insert: 'Create', update: 'Edit', select: '' },
        suffix: { insert: 'Input', update: 'Input', select: '' },
      },
    },
  },
];
```

Emits `InsertUsersSchema` / `UpdateUsersSchema` / `SelectUsersSchema` plus `CreateUsersInput`,
`EditUsersInput` and a bare `Users`. Every prefix and suffix takes a string or a per-mode
object keyed by `insert`, `update`, `select`. The legacy `schemaSuffix` still works and is the
default for `affix.schema.suffix`.
