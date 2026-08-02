---
'@drzl/generator-arktype': minor
'@drzl/generator-valibot': minor
'@drzl/generator-typebox': minor
'@drzl/generator-orpc': minor
'@drzl/validation-core': minor
'@drzl/generator-zod': minor
'@drzl/analyzer': minor
'@drzl/cli': minor
---

MySQL and SQLite parity, insert and update parity, and generated columns.

The parity gate added last release covered Postgres select schemas. Extending it to three dialects
and all three modes turned up **54 findings**, including two regressions from that same release.
All are fixed and the gate now runs the full cross product.

### Insert schemas invited writes the database rejects

The analyzer derived "generated" from `col.autoIncrement || col.isGenerated`, and
**`col.isGenerated` is undefined on every Drizzle column of every dialect**, so the second half
never fired at all. A `generatedAlwaysAs(...)` column and a `generatedAlwaysAsIdentity()` column
both appeared in insert schemas, and an insert built from one is rejected by Postgres outright.

The first half then over-fired in the other direction: a MySQL `autoIncrement` column was dropped
from insert schemas entirely, when `AUTO_INCREMENT` supplies a value if you omit one rather than
forbidding you from supplying your own. The same construct therefore behaved differently per
dialect, since a Postgres `serial` was already merely optional.

| Column | Before | Now |
| --- | --- | --- |
| `generatedAlwaysAs(...)` | present on insert | omitted |
| `generatedAlwaysAsIdentity()` | present on insert | omitted |
| `generatedByDefaultAsIdentity()` | present | optional |
| MySQL `autoincrement()` | omitted | optional |

### Two regressions from the previous release

Both were introduced by the v1 `dataType` mapper and are fixed here.

- **MySQL `tinyint` and `mediumint` lost their bounds.** The mapper had no `int8` or `int24` case,
  so they fell to its bare-number arm, whose safe-integer bounds then *overrode* the correct ones:
  a tinyint went from `+/-127` to `+/-9007199254740991` and stopped being an integer at all.
- **MySQL `binary`/`varbinary` were treated as Postgres `bit`.** Both report `dataType: "string
  binary"` and only the codec separates them, so every MySQL binary column rejected `''` and
  anything that was not a run of 0s and 1s at exactly the declared width.

### SQLite was skipped by the v1 path entirely

SQLite columns carry a `dataType` but no `codec`, and the mapper gated on the codec. So the whole
dialect stayed on class-name matching: `text({ mode: 'json' })` and the json blob modes emitted
`z.any()`, `blob({ mode: 'buffer' })` emitted `z.unknown()` (which accepts `null` on a NOT NULL
column), and `blob({ mode: 'bigint' })` lost its 64 bit range.

### MySQL widths that nothing else states

`tinyint`, `mediumint`, `year` and the unsigned `serial` now carry their real ranges, and the text
and blob families carry the cap the type itself implies, which is on no property of the column:

| Column | Now |
| --- | --- |
| `tinyint()` | `-128 .. 127` |
| `mediumint()` | `-8388608 .. 8388607` |
| `year()` | `1901 .. 2155` |
| `serial()` | `0 ..`, since it is unsigned |
| `text()` | `max(65535)`, `tinytext` 255, `longtext` 4294967295 |

Gated on the dialect, because the codec names collide: Postgres `text` reports the codec `text`
too and has no cap at all.

### Date columns accepted null

`coerceDates` defaults to coercing on write, and that was `z.coerce.date()`, which is `new Date(v)`
on anything. `new Date(null)` is the epoch and `new Date(true)` is one millisecond past it, so a
NOT NULL timestamp column accepted `null`, `true` and `[1, 2]`, each silently becoming a real date.
Coercion is now limited to strings and numbers, which is what the option was for.

### TypeBox cannot back an oRPC router, and now says so

oRPC types `.input()`/`.output()` as a [Standard Schema](https://standardschema.dev). Neither
`@sinclair/typebox` nor the newer `typebox` package implements it, while zod, valibot and arktype
all do, so `validation.library` on an `orpc` generator does not accept `typebox` and the docs
explain why. The standalone typebox generator is unaffected.

While confirming that, the oRPC generator's library handling moved from chains of ternaries to a
per-library table. The chains ended in `... : valibot`, so any library they did not recognise
would have silently emitted valibot code rather than failing.

### The gate

`verify:packed` now measures three dialects times three modes times each library, 15 combinations
over 82 columns, and cross-checks DRZL's four generators against each other. Deliberate
divergences are listed with their reasons and everything else fails the build.
