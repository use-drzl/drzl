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

| `target`                  | What it is                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `draft-2020-12` (default) | The current draft, with a `$schema` declaration                                                 |
| `openapi-3.1`             | The same draft, with no `$schema`, which is how a schema appears inside an OpenAPI 3.1 document |
| `openapi-3.0`             | A different dialect, see below                                                                  |

OpenAPI 3.0 is not an older superset of 2020-12. It spells things differently:

|                  | `draft-2020-12`            | `openapi-3.0`                         |
| ---------------- | -------------------------- | ------------------------------------- |
| nullable         | `type: ['string', 'null']` | `type: 'string', nullable: true`      |
| exclusive bound  | `exclusiveMinimum: 0`      | `minimum: 0, exclusiveMinimum: true`  |
| positional array | `prefixItems: [...]`       | no equivalent, falls back to a length |

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

::: tip The whole document
`components: true` gives you the schemas. `document: true` gives you the document around them:
paths, verbs, request and response bodies per table, and the status codes. See
[the OpenAPI document page](/generators/openapi).
:::

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

A column-level inequality is a different matter, and this format can state it. `CHECK
(tier <> 'banned')` emits `not` beside the type:

```json
{ "type": "string", "not": { "const": "banned" } }
```

On the OpenAPI 3.0 target the same statement is spelled `"not": { "enum": ["banned"] }`, since that
dialect has no `const`. On a numeric string wire it becomes `"not": { "type": "string", "pattern":
... }`, because the driver spells one stored value many ways and excluding a single spelling would
enforce almost nothing. The inner `"type": "string"` there is load bearing: `pattern` says nothing
about a value that is not a string, so a bare `not` around it is false for `null` and would quietly
make a nullable column non-nullable.

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

| Value     | Bytes | Characters | MySQL   | This schema |
| --------- | ----- | ---------- | ------- | ----------- |
| 255 ascii | 255   | 255        | accepts | accepts     |
| 256 ascii | 256   | 256        | refuses | refuses     |
| 63 emoji  | 252   | 63         | accepts | accepts     |
| 64 emoji  | 256   | 64         | refuses | accepts     |

The four validation generators encode the string and count the bytes, so they get the last row
right. `varchar(n)` is genuinely characters in the same database and is unaffected: it keeps
`maxLength` from its declared length.

A `CHECK (octet_length(col) <= n)` is the same budget written as a constraint and goes the same way.
The smaller of the two, where a column carries both, is the one the document states.

On a **binary** column the value travels as base64, so the only length the format can bound is the
encoded string's. Base64 of n bytes is `4 * ceil(n / 3)` characters when padded and fewer when not,
measured over n = 0 to 20, so that number refuses nothing the column accepts:

```json
{
  "type": "string",
  "contentEncoding": "base64",
  "maxLength": 340,
  "description": "At most 255 bytes, which JSON Schema has no keyword for. The value travels as base64, and maxLength counts the characters of that encoding: ..."
}
```

Loose by design: 6 bytes encode to the same 8 characters as 5, so a 5 byte cap still admits 6. A
byte _floor_ reaches no keyword at all, in either case.

## Shared enums

An enum on six columns is six copies of the same list in each of three schemas. The OpenAPI document
writes it once and references it, and the per-table modules do too when you ask:

```ts
{ kind: 'json-schema', document: true, sharedEnums: true }
```

```jsonc
// users.schema.ts, a standalone JSON Schema document, with sharedEnums: true
{
  "$defs": { "mood": { "enum": ["sad", "ok", "happy"] } },
  "properties": { "m1": { "$ref": "#/$defs/mood" }, "m2": { "$ref": "#/$defs/mood" } },
}
```

**`sharedEnums` is off by default, and the reason is a consumer pattern.** A per-table schema is
used two ways: whole, and one property at a time. Reaching into `properties[col]` is the JSON Schema
equivalent of reading zod's `.shape`, it is how a form builder gets one field's rules, and it is how
the packed gate checks these schemas against a real Postgres. A `$ref` cannot survive that: pulled
out of the schema that holds its `$defs` it is a dangling reference, and ajv refuses to compile it
at all with `can't resolve reference #/$defs/mood from id #`. Whole, it compiles and validates
exactly as before. So the trade is stated rather than made for you.

The **OpenAPI document** shares regardless, because a document is only ever read whole and every
OpenAPI tool resolves `$ref` against it.

**Where the definition goes depends on the document.** Measured against
`@seriousme/openapi-schema-validator`, which carries the real 3.0 and 3.1 meta-schemas:

| Placement                                 | OpenAPI 3.0             | OpenAPI 3.1                |
| ----------------------------------------- | ----------------------- | -------------------------- |
| `components.schemas` + `#/components/...` | valid                   | valid                      |
| `$defs` in a schema + `#/$defs/...`       | invalid, closed object  | invalid, `$ref` unresolved |
| `anyOf: [{$ref}, {type: 'null'}]`         | invalid, no `null` type | valid                      |

3.0's Schema Object is closed, so `$defs` beside `properties` fails the whole document. 3.1 allows
the keyword and still fails, because a `$ref` inside a document resolves against the document root
where `#/$defs/mood` names nothing. So `$defs` appears only in the per-table modules on the
`draft-2020-12` target, and only under `sharedEnums`; the OpenAPI document shares through
`components.schemas`.

**`components.ts` shares nothing, deliberately.** It is a fragment the caller spreads into a
document, and a `$ref` is a promise about where the thing holding it is mounted:
`#/components/schemas/mood` resolves once the fragment sits at exactly that path and nowhere else.
Every entry there stays self-contained, so one schema can be handed to a validator on its own. Ask
ajv to compile a cross-referencing entry alone and it answers `can't resolve reference
#/components/schemas/mood from id #`. `document: true` produces a whole document, which knows where
it is, and that one does share.

A **nullable** enum column is `anyOf: [{ $ref }, { type: 'null' }]` on 2020-12 and 3.1. In a 3.0
document it keeps its inline enum: `type: 'null'` is not one of that version's six types, and 3.0
defines every sibling of `$ref` to be ignored, so `{ $ref, nullable: true }` is a schema that
silently refuses null.

**Two or more columns** is the threshold, and only a declared enum is shared. A single use gains
nothing from the indirection, and a `CHECK (status IN ('a','b'))` stays inline because it is a
constraint on one column rather than a named type. The key comes from the analysis's own enum list,
since a column carries values and no name; an enum whose name collides with a table's schema name
stays inline rather than being renamed.

A schema with nothing shared is byte-for-byte what it was.

## Values as they survive JSON

The schema describes the value **after** `JSON.stringify`, which is not always what the TypeScript
type says:

| Column                       | Schema                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `bigint`                     | `{ type: 'string', pattern: '^-?\\d+$' }`, because `JSON.stringify` throws on a bigint                                                       |
| `bigint({ mode: 'string' })` | `{ type: 'string', pattern }` for the input syntax that dialect's server parses, which is not the same pattern as the row above              |
| `bytea`, `blob`              | `{ type: 'string', contentEncoding: 'base64' }`                                                                                              |
| `timestamp`                  | `{ type: 'string', format: 'date-time' }`                                                                                                    |
| `json`, `jsonb`              | `{}`, which is how the format spells "any JSON value"                                                                                        |
| `point`                      | `prefixItems` of two numbers, with `minItems` and `maxItems`                                                                                 |
| `point({ mode: 'xy' })`      | `{ type: 'object', properties: { x, y }, required: ['x', 'y'] }`, with no `additionalProperties`, because the column ignores an unlisted key |

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
