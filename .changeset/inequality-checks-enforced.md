---
'@drzl/generator-arktype': patch
'@drzl/generator-typebox': patch
'@drzl/generator-json-schema': patch
---

`CHECK (col <> 'banned')` is now enforced by every generator that reads it

One parsed CHECK, six emitters, three of which silently enforced nothing. The shared parser has
always read `<>`, and zod, valibot and effect have always emitted a predicate for it, while ArkType
and TypeBox emitted a bare `string` and the JSON Schema generator emitted no keyword at all. A
column carrying `CHECK (tier <> 'banned')` therefore had a schema that accepted the single value
the database refuses, on three of the six.

The form each library can actually state, measured rather than assumed:

- **ArkType** takes a narrow on the field. Its DSL has no negation, and the two spellings that look
  like they would work do not: on 2.2.3, `string & !'banned'` is a parse error and
  `Exclude<string, 'banned'>` parses and then accepts `'banned'`.
- **TypeBox** states it declaratively, as `Type.Intersect([base, Type.Not(Type.Literal("banned"))])`.
  The intersect is load bearing rather than decorative: on 0.34.52 `Type.Not` alone accepts a value
  of any other type, so without the base the column would stop being a string. Both the interpreted
  and the compiled path enforce the pair.
- **JSON Schema** emits `not` beside the type: `{ "type": "string", "not": { "const": "banned" } }`,
  spelled `"not": { "enum": [...] }` on the OpenAPI 3.0 target, which has no `const`. On a numeric
  string wire it becomes `"not": { "type": "string", "pattern": ... }`, because the driver spells
  one stored value many ways and excluding a single spelling would enforce almost nothing.

Null is unaffected everywhere, which is what SQL does: `NULL <> 'banned'` is NULL and a CHECK passes
on NULL. That inner `"type": "string"` on the pattern form is what keeps it so. Without it the `not`
is false for null, because `pattern` is vacuously true of a value that is not a string, and the
exclusion would quietly have made a nullable column non-nullable.

The gate could not have caught any of this, because its CHECK fixture had `=`, `IN`, ranges,
`length`, `cardinality` and a row comparison, and no `<>`. It has one now, on a text and an integer
column, so the five-generator agreement and the Postgres ground truth both cover the form: 59 probes
across 15 constrained columns, up from 53 across 13. The third dropper was found by that fixture
rather than by reading, within a minute of it existing.

Not changed: the constraint ledger stays scoped to the zod and valibot spellings, since what it
reports is where a constraint's message lands rather than whether a schema enforces it.
