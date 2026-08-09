# Analyzer

Schema analyzer for Drizzle ORM projects. Produces a normalized `Analysis` used by generators.

See the [package README](https://github.com/use-drzl/drzl/blob/master/packages/analyzer/README.md) for API and output shape.

## `maxBytes`, the cap that is not a character count

A width on a column can mean two different things, and the analyzer carries them as two fields
rather than one, because applying the wrong one accepts rows the database refuses.

`maxLength` is a **character** limit. `varchar(10)` is ten characters in both Postgres and MySQL,
and that is what the validation generators enforce.

`maxBytes` is a **byte** budget, and only MySQL sets it. MySQL's `TEXT` and `BLOB` families carry
their limit in the type itself rather than in a declared length, and that limit is counted in
bytes. On utf8mb4 a `tinytext` holds 255 ascii characters or 63 emoji, because the 64th emoji is
the 256th byte. `maxLength` cannot express that, and applying the number as a character count is
what let a `tinytext` holding 64 emoji validate clean and then be refused by the server.

Eight column types set it, measured on drizzle-orm 1.0.0-rc.4:

| Column                         | `maxBytes` |
| ------------------------------ | ---------: |
| `tinytext()`, `tinyblob()`     |        255 |
| `text()`, `blob()`             |      65535 |
| `mediumtext()`, `mediumblob()` |   16777215 |
| `longtext()`, `longblob()`     | 4294967295 |

`varchar({ length: n })` sets `maxLength` and no `maxBytes`, because MySQL really does count that
one in characters. A Postgres `text` column sets neither, because it has no limit.

The two majors differ in what else the column reports. On drizzle-orm 0.45.2 a `text()` column
states no length at all, so `maxBytes` is the only cap there; on 1.0.0-rc.4 the same column also
reports a `maxLength` equal to it. The blob half of the table is not reachable on 0.45.2 at all:
`drizzle-orm/mysql-core` there exports no `blob`, `tinyblob`, `mediumblob` or `longblob`.

The Zod, Valibot, ArkType, TypeBox and Effect Schema generators encode `maxBytes` as a predicate
over `new TextEncoder().encode(value).length`. JSON Schema has no byte-counting keyword, so the
[JSON Schema generator](/generators/json-schema#a-byte-budget) emits the number as a `maxLength`,
which refuses nothing the column accepts, and states the byte budget in the schema's `description`.
