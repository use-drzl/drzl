---
'@drzl/analyzer': minor
'@drzl/generator-zod': minor
'@drzl/generator-valibot': minor
'@drzl/generator-arktype': minor
'@drzl/generator-orpc': patch
---

Generated schemas now enforce what the column actually declares. They did not, so a 300
character value in a `varchar(255)` and a `smallint` of 40000 both passed validation and failed
at the database.

Every target below was measured from `drizzle-orm/zod` at 1.0.0-rc.4 by building the schema and
reading its checks, not guessed:

| column | before | now |
|---|---|---|
| `varchar(255)` | `z.string()` | `z.string().max(255)` |
| `uuid()` | `z.string()` | `z.uuid()` |
| `smallint()` | `z.number().int()` | `.int().gte(-32768).lte(32767)` |
| `integer()` | `z.number().int()` | `.int().gte(-2147483648).lte(2147483647)` |
| `bigint({mode:'number'})` | `z.bigint()` | `.int().gte(-9007199254740991).lte(9007199254740991)` |
| `bigint({mode:'bigint'})` | `z.bigint()` | `.gte(-9223372036854775808n).lte(9223372036854775807n)` |

The bigint row was not merely imprecise, it was wrong: `{ mode: 'number' }` yields a JS number, so
a schema demanding a bigint rejected every valid row.

Valibot and ArkType get the same constraints in their own idiom, `v.pipe(v.string(),
v.maxLength(255))` and `string <= 255`. Every ArkType form was executed against arktype itself,
accepting a valid value and rejecting an invalid one, because an expression it cannot parse
throws on import.

### Two dead switch cases in the analyzer

`case 'PgUuid'` and `case 'PgBigInt'` never matched anything. Drizzle spells them `PgUUID`,
`PgBigInt53` and `PgBigInt64`, so both fell through to a case-insensitive regex arm and came back
as plain `TEXT` and `bigint`. That is why uuid lost its format and why bigint ignored its mode.

### New on `Column`

`maxLength`, `min`, `max` and `format`. `dbType` is unchanged, since consumers switch on it.
Bounds are decimal strings because a 64 bit bound is not representable as a JS number:
`9223372036854775807` rounds the moment it becomes one, so a numeric field would emit a bound
that is quietly wrong.

`@drzl/generator-orpc` also drops its `zod` dependency. It never imported it; the only occurrence
was a template literal emitted into generated code, so it was forcing zod on Valibot and ArkType
users for nothing.
