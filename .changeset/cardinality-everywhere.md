---
'@drzl/generator-arktype': minor
'@drzl/generator-typebox': minor
---

Apply `cardinality()` CHECK constraints in the ArkType and TypeBox generators

`CHECK (cardinality(tags) >= 2)` was parsed and then dropped by both, so an array the database
refuses validated clean. zod and valibot already applied it.

Each states it natively rather than as a predicate. ArkType bounds an array's length with the same
operators it bounds a number with, so it folds into the type: `string[] >= 2`. TypeBox uses
`minItems` and `maxItems`, which means the constraint survives serialisation to JSON Schema. JSON
Schema has no exclusive form of either keyword, but a length is an integer, so `> 2` becomes
`minItems: 3` and nothing is approximated.

The bound binds to the outermost array, so it counts what `cardinality()` counts, and it sits
inside the union with null on a nullable column, so null still passes.
