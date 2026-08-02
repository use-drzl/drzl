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
- Prefer a quick overview? Check `docs/sponsor.md` for the current goals and thank-yous.

## Use

Add to `drzl.config.ts`:

```ts
generators: [{ kind: 'json-schema', path: 'src/validators/json-schema' }];
```

## Output

- `Insert<Table>Schema`, `Update<Table>Schema`, `Select<Table>Schema`, each a plain object
  declared `as const`
- Optional `index` barrel

## Dialect

```ts
generators: [{ kind: 'json-schema', target: 'openapi-3.0' }];
```

`draft-2020-12` (default), `openapi-3.1`, or `openapi-3.0`. The last is a different dialect rather
than an older version: nullable is `nullable: true` rather than a type array, and an exclusive
bound is a boolean beside the bound rather than its own keyword. Since an unknown keyword is
ignored rather than rejected in JSON Schema, emitting the wrong one produces a document that
validates and then accepts what the constraint exists to reject.

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
