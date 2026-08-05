# JSON Schema Generator

Generates plain [JSON Schema](https://json-schema.org) per table (insert/update/select) and an
index barrel.

```ts
{ kind: 'json-schema', path: 'src/validators/json-schema' }
```

The other four generators each target one validation library, so the output is only useful to a
TypeScript program that installs that library. JSON Schema is the format everything else already
reads: OpenAPI documents, API gateways, form builders, contract tests, and validators in other
languages.

**There is no runtime dependency, not even an optional one.** The output is data.

## Example output

```ts
export const SelectpeopleSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'people.select',
  title: 'select people',
  type: 'object',
  properties: {
    id: { type: 'integer', minimum: -2147483648, maximum: 2147483647 },
    age: { type: 'integer', minimum: 18, maximum: 2147483647 },
    score: { type: ['integer', 'null'], minimum: 0, maximum: 100 },
    tier: { const: 'gold' },
    tags: { type: 'array', items: { type: 'string' }, minItems: 2 },
    bio: { type: ['string', 'null'] },
  },
  required: ['id', 'age', 'score', 'tier', 'tags', 'bio'],
  additionalProperties: false,
} as const;

export type SelectpeopleOutput = typeof SelectpeopleSchema;
```

## Which dialect

```ts
{ kind: 'json-schema', target: 'openapi-3.0' }
```

| `target` | What it is |
| --- | --- |
| `draft-2020-12` (default) | The current draft, with a `$schema` declaration |
| `openapi-3.1` | The same draft, with no `$schema`, which is how a schema appears inside an OpenAPI 3.1 document |
| `openapi-3.0` | A different dialect, see below |

OpenAPI 3.0 is not an older superset of 2020-12. It spells things differently:

| | `draft-2020-12` | `openapi-3.0` |
| --- | --- | --- |
| nullable | `type: ['string', 'null']` | `type: 'string', nullable: true` |
| exclusive bound | `exclusiveMinimum: 0` | `minimum: 0, exclusiveMinimum: true` |
| positional array | `prefixItems: [...]` | no equivalent, falls back to a length |

This matters more than a formatting preference, because **an unknown keyword is not an error in
JSON Schema: it is ignored.** A 2020-12 `exclusiveMinimum: 0` dropped into a 3.0 document is read
as the boolean form with no bound at all, or ignored outright. Either way the document still
validates as OpenAPI, and the constraint that exists to reject `0` now accepts it. That is the
reason this is an option rather than a note.

## One document for OpenAPI

```ts
{ kind: 'json-schema', target: 'openapi-3.1', components: true }
```

Also emits `components.ts`, one object keyed by name and ready to spread into an OpenAPI
document's `components.schemas`:

```ts
export const components = {
  schemas: {
    usersInsert: { title: 'insert users', type: 'object', properties: { ... } },
    usersUpdate: { ... },
    usersSelect: { ... },
  },
} as const;
```

Two details this handles that are easy to get quietly wrong:

- **`$schema` is dropped.** Nested under `components.schemas` a schema inherits the document's
  dialect, and OpenAPI 3.1 reads a per-schema `$schema` as a dialect switch.
- **`$id` is dropped, not rewritten.** Setting it to `#/components/schemas/<name>` is the obvious
  first attempt and it is invalid: a draft 2020-12 `$id` may not contain a fragment, and ajv
  rejects the schema outright. The map key is the identity, and the `$ref` is written by whatever
  points at the schema.

Off by default, so nobody gets a file they did not ask for.

## What it cannot say

JSON Schema cannot compare one property against another. `if`/`then` and `dependentSchemas` can
branch on whether a property is present or on a fixed value, and neither of those is `lo < hi`.

So a row-level `CHECK (start_date < end_date)` is carried as the schema's `description` and
nothing pretends to enforce it:

```json
{
  "description": "Row constraints not expressible in JSON Schema: valid_range: start_date < end_date"
}
```

The four validation generators do enforce these. See
[the ArkType generator](/generators/arktype) or [the valibot generator](/generators/valibot).

### A byte budget

MySQL's TEXT family is capped by the type in **bytes**, not by a declared length in characters:
`tinytext` holds 255 bytes, `text` 65535, `mediumtext` 16777215, `longtext` 4294967295. No draft of
JSON Schema has a byte-length keyword, and an invented one is not a constraint: a strict validator
refuses to compile it and a lax one ignores it.

So the budget is emitted as `maxLength`, which counts characters, with the part it cannot carry
written beside it:

```json
{
  "type": "string",
  "maxLength": 255,
  "description": "At most 255 bytes of UTF-8, which JSON Schema has no keyword for. maxLength counts characters: it refuses nothing the column accepts, and a string of multi-byte characters can satisfy it and still be too long for the column."
}
```

UTF-8 spends at least one byte per character, so that cap **never refuses a value the column
accepts**, and it catches every overflow made of one-byte characters. What it cannot catch is a
string that fits the character count and not the budget. Asked of a real MySQL 8 on utf8mb4, on a
`tinytext` column:

| Value | Bytes | Characters | MySQL | This schema |
| --- | --- | --- | --- | --- |
| 255 ascii | 255 | 255 | accepts | accepts |
| 256 ascii | 256 | 256 | refuses | refuses |
| 63 emoji | 252 | 63 | accepts | accepts |
| 64 emoji | 256 | 64 | refuses | accepts |

The four validation generators encode the string and count the bytes, so they get the last row
right. `varchar(n)` is genuinely characters in the same database and is unaffected: it keeps
`maxLength` from its declared length.

## Values as they survive JSON

The schema describes the value **after** `JSON.stringify`, which is not always what the TypeScript
type says:

| Column | Schema |
| --- | --- |
| `bigint` | `{ type: 'string', pattern: '^-?\\d+$' }`, because `JSON.stringify` throws on a bigint |
| `bytea`, `blob` | `{ type: 'string', contentEncoding: 'base64' }` |
| `timestamp` | `{ type: 'string', format: 'date-time' }` |
| `json`, `jsonb` | `{}`, which is how the format spells "any JSON value" |
| `point` | `prefixItems` of two numbers, with `minItems` and `maxItems` |

`contentEncoding` is worth one warning. In draft 2020-12 and in OpenAPI 3.1 it is an **annotation**,
not an assertion: a conforming validator records that the string is meant to be base64 and does not
check that it is. So `{ type: 'string', contentEncoding: 'base64' }` accepts any string at all, and
a client sending `"hello!"` for a `bytea` field is turned away by the decoder rather than by the
contract.

## Verification

Every emitted schema in the test suite is compiled by [ajv](https://ajv.js.org) in **strict mode**,
which rejects unknown keywords rather than ignoring them, and then asserted on which values it
accepts. Nothing asserts on the shape of the emitted object, because a schema that looks right and
means nothing is the failure this format makes easy.

The same happens to the **published** artefact in `scripts/verify-packed.sh`, against the tarball a
consumer installs rather than the working tree:

- every emitted schema and every entry of the `components` document compiles under ajv in strict
  mode, and each one is asked to refuse something, so a schema that compiled to nothing is caught
- each column's schema is compared with a real Postgres, value by value, over a pool shared with the
  zod generator's ground-truth stage. The values are converted to their JSON form first, since a
  document cannot carry a `Date` or a `Uint8Array`, and the database is asked about that same
  converted value. The gate is that this generator must never disagree with Postgres where the zod
  output agrees
- the schemas are a fifth voice alongside zod, valibot, ArkType and TypeBox on every CHECK probe,
  and all five have to agree
- the row-level exemption above is asserted rather than waived: Postgres and the four validators
  reject a disordered row, this generator accepts it, and the constraint is still named in the
  `description`. If any of those three changes, the gate fails and this page has to change with it
