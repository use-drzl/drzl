---
'@drzl/generator-arktype': minor
'@drzl/generator-typebox': minor
'@drzl/generator-valibot': minor
---

Enforce row-level CHECK constraints in the valibot, TypeBox and ArkType generators

`CHECK (start_date < end_date)` compares two columns, so it cannot be a field constraint. Only the
zod generator applied one; the other three parsed it and dropped it, so a row the database refuses
validated clean. Each generator now states it in its own idiom: `v.check` on a pipe for valibot,
`.narrow` for ArkType, and for TypeBox a registered kind intersected with the object, which both
`Value.Check` and `TypeCompiler` honour. Serialising a TypeBox schema to JSON Schema keeps the
constraint as a description, since JSON Schema cannot compare two fields.

Both sides are guarded for null first, matching SQL, where a comparison involving NULL leaves the
CHECK satisfied. A constraint naming a column a given mode does not carry is left out rather than
emitted against an undefined value.

Also fixes an ArkType crash this uncovered: a CHECK on a column with no declared width, which is
every numeric type but the integers, emitted `0 < number`. ArkType rejects a left bound with no
right bound, so the generated module threw the moment anything imported it. A lone bound is now
written as `number > 0`.
