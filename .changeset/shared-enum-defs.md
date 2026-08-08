---
'@drzl/generator-json-schema': minor
---

Write a shared enum once and reference it, instead of inlining it at every use

A `mood` enum on six columns was six copies of the same list in each of the three schemas, and
eighteen in a document. It is now one definition with references pointing at it.

```jsonc
// openapi.json, always. The definition is a component.
{
  "components": { "schemas": { "mood": { "enum": ["sad", "ok", "happy"] } } },
  "properties": { "m1": { "$ref": "#/components/schemas/mood" } }
}

// people.schema.ts, on `sharedEnums: true`. A standalone JSON Schema document.
{
  "$defs": { "mood": { "enum": ["sad", "ok", "happy"] } },
  "properties": { "m1": { "$ref": "#/$defs/mood" }, "m2": { "$ref": "#/$defs/mood" } }
}
```

**`sharedEnums` is off by default, and the reason is a consumer pattern rather than a doubt about
the keyword.** A per-table schema is used two ways: whole, and one property at a time. Reaching into
`properties[col]` is the JSON Schema equivalent of reading zod's `.shape`, it is how a form builder
gets one field's rules, and it is how `scripts/verify-packed.sh` checks these schemas against a real
Postgres. A `$ref` cannot survive that: pulled out of the schema that holds its `$defs` it is a
dangling reference and ajv refuses to compile it at all, `can't resolve reference #/$defs/mood from
id #`. Whole, it compiles and validates exactly as before. The OpenAPI document shares regardless,
because a document is only ever read whole.

**Where the definition goes depends on the document, and the two are not interchangeable.** Measured
against `@seriousme/openapi-schema-validator`, which carries the real 3.0 and 3.1 meta-schemas:

| placement                                 | OpenAPI 3.0             | OpenAPI 3.1                |
| ----------------------------------------- | ----------------------- | -------------------------- |
| `components.schemas` + `#/components/...` | valid                   | valid                      |
| `$defs` in a schema + `#/$defs/...`       | INVALID, closed object  | INVALID, `$ref` unresolved |
| `anyOf: [{$ref}, {type: 'null'}]`         | INVALID, no `null` type | valid                      |

3.0's Schema Object is closed, so `$defs` beside `properties` fails the whole document. 3.1 allows
the keyword and still fails, because a `$ref` inside a document resolves against the document root
where `#/$defs/mood` names nothing. So `$defs` appears only in the standalone per-table modules on
the `draft-2020-12` target, and only under `sharedEnums`; the OpenAPI document shares through
`components.schemas`.

**`components.ts` shares nothing, and that is the one place this stops.** It is a fragment the
caller spreads into a document, and a `$ref` is a promise about where the thing holding it is
mounted: `#/components/schemas/mood` resolves once the fragment sits at exactly that path and
nowhere else. Every entry there stays self-contained, so a caller can hand one schema to a validator
on its own; ask ajv to compile a cross-referencing entry alone and it answers `can't resolve
reference #/components/schemas/mood from id #`. `components.ts` is byte-for-byte what it was.

**Nullable columns.** 2020-12 and 3.1 spell a nullable reference as `anyOf: [{ $ref }, { type:
'null' }]`, which validates. 3.0 has neither half of that: `type: 'null'` is not one of its six
types, and it defines every sibling of `$ref` to be ignored, so `{ $ref, nullable: true }` is a
schema that silently refuses null. A nullable enum column in a 3.0 document therefore keeps the
inline enum it has always had, and the shared definition still serves every other use.

**Only shared enums, and only declared ones.** Two or more columns is the threshold. A single use
gains nothing from the indirection, and a `CHECK (status IN ('a','b'))` stays inline because it is a
constraint on one column rather than a named type: two columns whose `IN` lists happen to agree are
two constraints, and giving them a shared name would invent both the concept and the name. The
definition's key comes from the analysis's own enum list, since a column carries values and no name.
An enum whose name collides with a table's schema name, or which sanitises to nothing, stays inline
rather than being disambiguated into a name that moves when a table is added.

**Size.** A saving on every enum but the very shortest, because
`{"$ref":"#/components/schemas/mood"}` is 36 bytes and `{"enum":["sad","ok","happy"]}` is 29.
Measured on an OpenAPI 3.1 document, one table, n columns carrying the enum:

| enum             | 1 col | 2 cols | 3 cols | 6 cols |
| ---------------- | ----- | ------ | ------ | ------ |
| 3 short values   | 0     | +58    | +70    | +106   |
| 5 values         | 0     | -97    | -178   | -421   |
| 12 country codes | 0     | -147   | -258   | -591   |
| 20 long values   | 0     | -1697  | -2738  | -5861  |

The threshold stays at two columns rather than becoming "wherever it saves bytes". The point of the
definition is that the document names a type, so a client generator emits one enum class where six
inline lists are six anonymous unions it cannot tell are the same thing; a rule keyed on encoded
length would flip the output when somebody adds a value.

A schema with nothing shared is byte-for-byte what it was.
