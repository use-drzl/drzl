---
'@drzl/generator-arktype': minor
'@drzl/generator-typebox': minor
---

Apply `length()` CHECK constraints in the ArkType and TypeBox generators

`CHECK (length(name) >= 3)` was parsed, applied by zod and valibot, and dropped in silence by the
other two: ArkType emitted a bare `string` and TypeBox a bare `Type.String()`. A constraint the
database enforces and the validator does not is precisely the gap these generators exist to close.

Neither uses its native length keyword, and that is deliberate. ArkType's `string >= 3` and
TypeBox's `minLength` both count UTF-16 code units, while SQL's `length()` counts characters, so
three thumbs-up characters are six units to both. On a minimum that only under-enforces; on a
maximum it refuses rows the database accepts, which is the `varchar(n)` bug the zod generator
already avoids by counting code points.

So each goes where an exact count can be expressed: a `.narrow()` on the object for ArkType, and a
branch of the same registered-kind intersection the row checks use for TypeBox. Null and absent
both pass, matching SQL.

The cost for TypeBox is that this constraint does not survive serialisation to JSON Schema, where
a bare `minLength` would. Emitting the wrong count in a form that serialises is not a better
trade.
