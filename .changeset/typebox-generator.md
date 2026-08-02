---
'@drzl/generator-typebox': minor
'@drzl/validation-core': minor
'@drzl/cli': minor
---

New generator: `@drzl/generator-typebox`.

```ts
{ kind: 'typebox', path: 'src/validators/typebox' }
```

TypeBox is the second most used validator in the Drizzle ecosystem: `drizzle-typebox` at 41,537
weekly downloads beats `drizzle-valibot` (17,216) and `drizzle-arktype` (6,761) *combined* by
1.73x. DRZL shipped both of the smaller ones and not this one.

It has everything the other three generators have: column constraints, CHECK constraint
enforcement, `typedJson`, affixes, file suffixes and import extensions. Because TypeBox is JSON
Schema, constraints are keywords rather than chained calls, which makes the output the most
directly readable of the four and usable by anything that speaks JSON Schema:

```ts
export const SelectpeopleSchema = Type.Object({
  age: Type.Integer({ minimum: 18, maximum: 2147483647 }),   // CHECK (age >= 18)
  score: Type.Union([Type.Integer({ minimum: 0, maximum: 100 }), Type.Null()]),
  tier: Type.Literal("gold"),                                 // CHECK (tier = 'gold')
});
```

### Two places TypeBox fails silently, both handled

TypeBox accepts an option it does not understand for a given type and then ignores it, so a
schema can look right, compile, and validate nothing. Both of these were found by running the
emitted schemas rather than reading them:

- **`format` needs registration.** `Type.String({ format: 'uuid' })` returns `false` for a
  perfectly valid uuid in any project that has not populated `FormatRegistry`. A uuid column is
  emitted as a `pattern` instead, which needs no setup.
- **`const` is ignored on `String` and `Integer`.** `Type.String({ const: 'gold' })` validates
  `'silver'`, and `Type.Integer({ const: 5 })` validates `6`. An equality check is emitted as
  `Type.Literal` instead, which is the only form that enforces.

The test suite writes the emitted module to disk, imports it, and runs `Value.Check` against it,
because asserting on generated source text cannot tell the difference between a schema that
validates and one that merely parses.
