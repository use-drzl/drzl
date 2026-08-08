---
'@drzl/validation-core': patch
'@drzl/generator-zod': patch
'@drzl/generator-valibot': patch
'@drzl/generator-arktype': patch
'@drzl/generator-typebox': patch
'@drzl/generator-effect': patch
'@drzl/generator-json-schema': patch
---

Spell a CHECK's number literals in the column's wire type, so a set on a `bigint({ mode:
'bigint' })` column stops rejecting every row the driver returns

`CHECK (big IN (1, 2))` on a bigint-mode column emitted `z.union([z.literal(1), z.literal(2)])`,
and the driver returns `1n` there: strict equality between a bigint and a number is false in
JavaScript, so the select schema refused every row the database handed back, and the insert schema
refused every value the driver wants. The OR fold routes `big = 1 OR big = 2` into the same set,
and the single `big = 1` and `big <> 1` predicates compared with `===`/`!==` had the same wire
mismatch: the equality never held and the inequality always did, so one rejected everything and
the other enforced nothing. `bigint({ mode: 'number' })` was always correct, because the driver
really returns a number there; the fix keys on the analyzer's per-mode `tsType`, which is the
value's measured wire type, rather than on the SQL type name.

The spelling per library was measured against the installed versions rather than assumed:

- **zod, valibot**: `z.literal(1n)` and `v.literal(1n)` accept `1n`, reject `3n` and reject the
  number `1`, so the set stays the same union with the members suffixed. The `=`/`<>` refinements
  compare against `1n`.
- **ArkType**: the string DSL parses bigint literals. `type('1n | 2n')` enforces the set,
  `type('9223372036854775807n')` holds the 64 bit value exactly, and `type('(1n | 2n)[]')` keeps
  the array wrap. The single equality already went through `atBigintNarrow` and was correct.
- **TypeBox**: `Type.Literal(1n)` constructs and passes `Value.Check`, and
  `TypeCompiler.Compile` then throws "Preflight validation check failed to guard for the given
  schema", so the literal form would take every compiler-path consumer down. The set and the
  pinned equality go to the registered `DrzlRowCheck` kind intersected with `Type.BigInt()`, the
  same escape hatch the character caps use, which both checkers honour; the static type still
  narrows through `Type.Unsafe<1n | 2n>`, and the document still serialises.
- **effect**: `Schema.Literal(1n, 2n)` enforces the set; the `<>` filter compares against `1n`.
- **JSON Schema**: a bigint column is already a digits string in a JSON document, because
  `JSON.stringify` throws on a bigint, so the set becomes `{ enum: ['1', '2'] }` and a pinned
  equality `{ const: '1' }`, in the wire the serialised row can actually hold. This also unrounds
  the 64 bit case: `Number('9223372036854775807')` becomes 9223372036854775808 the moment it is a
  number, and the digit string stays exact.

A non-integer member has no bigint spelling at all: `1.5n` is a syntax error, and an emitted
module carrying it would throw at import. Such a member keeps its number spelling, which no stored
bigint ever equals, exactly as the database says: no bigint column value is 1.5, so `big IN (1.5,
2)` narrows to the 2. The shared decision lives in `wireNumberLiteral` in
`@drzl/validation-core`, so the six emitters cannot answer it differently.

The driver-side ground truth is the analyzer's own: `decimal-modes.spec.ts` pins `db.select()`
returning a real bigint in bigint mode on all three engines, and the `PgBigInt53`/`PgBigInt64`
arms pin the number mode returning a number, which is why those literals do not change.
