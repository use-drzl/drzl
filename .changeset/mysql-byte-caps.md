---
'@drzl/analyzer': minor
'@drzl/generator-zod': patch
'@drzl/generator-valibot': patch
'@drzl/generator-typebox': patch
'@drzl/generator-arktype': patch
---

Count MySQL TEXT caps in bytes, and stop rejecting valid `varchar(n)` values in TypeBox and ArkType

Two different measurements were both being got wrong, in opposite directions. Measured against a
real MySQL 8 on utf8mb4 and a real Postgres, not reasoned about:

- `varchar(10)` counts **characters** in both databases: ten thumbs-up characters are a valid row.
  TypeBox emitted `maxLength: 10` and ArkType `string <= 10`, both of which count UTF-16 code
  units, so both **refused a row the database accepts**. That is the direction that breaks working
  code. zod and valibot already counted code points.
- MySQL's TEXT family counts **bytes**: `tinytext` takes 255 ascii characters and 63 thumbs-up
  ones (252 bytes), refusing 64 (256 bytes). The cap was carried as a character count, so a
  tinytext holding 64 emoji validated clean and MySQL refused the row. It is now a separate
  `maxBytes`, applied by encoding the string.

On drizzle-orm 0.4x the TEXT caps were absent entirely: every member of the family shares the
`MySqlText` class there, so only the SQL type tells a `tinytext` from a `longtext`.

Both caps now sit on the field rather than the object, so the differential parity harness, which
compares column by column, can still see them.
