---
'@drzl/generator-json-schema': patch
---

A MySQL TEXT column now carries its cap in the emitted JSON Schema, and says what the format cannot
express.

The analyzer reports a MySQL `tinytext`, `text`, `mediumtext` or `longtext` column with `maxBytes`,
the budget the column type itself imposes. The four validation generators encode the string and
count the bytes. This one ignored the field, so on drizzle-orm 0.4x, where such a column carries no
declared length either, the emitted schema was `{ "type": "string" }` and a document validated
against it could still be refused by the database.

Asked of a real MySQL 8 on utf8mb4 in `STRICT_TRANS_TABLES`, on a `TINYTEXT` column whose budget is
255 bytes, with the emitted module compiled by ajv:

```
                       MySQL     before    after
255 ascii, 255 bytes   accepts   accepts   accepts
256 ascii, 256 bytes   REFUSES   accepts   REFUSES
 63 emoji, 252 bytes   accepts   accepts   accepts
 64 emoji, 256 bytes   REFUSES   accepts   accepts
```

**What changes for you.** A string column with a byte budget gains `maxLength` holding that number,
and a `description` naming the budget. If you were sending values over the cap, the database was
already refusing the write. `varchar(n)` columns are untouched: that limit really is characters, and
it already had one.

**What it still cannot do.** JSON Schema has no byte-length keyword in any draft, and inventing one
produces a document that either fails to compile in a strict validator or is silently ignored by a
lax one. `maxLength` counts characters, and UTF-8 spends at least one byte per character, so the cap
refuses nothing the column accepts and catches every overflow made of one-byte characters. It cannot
catch a multi-byte string that fits the count and not the budget, which is the last row of the table
above, so that is what the `description` says.

Binary columns are unaffected, because they travel as base64 and a character cap taken from a byte
budget would refuse a legal value.
