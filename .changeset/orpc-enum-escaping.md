---
'@drzl/generator-orpc': patch
---

Escape enum values and column names in generated oRPC routers.

Enum values and column names were interpolated into the emitted code with hand-written quotes, so an
enum value containing an apostrophe, or a column name that is not a bare identifier, produced
unparseable output. Prettier then threw while formatting it and the whole generate run aborted rather
than failing on just that column.

Both are now encoded with `JSON.stringify`, matching what the standalone zod, valibot and arktype
generators already did.
