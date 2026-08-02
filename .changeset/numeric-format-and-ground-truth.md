---
'@drzl/generator-arktype': minor
'@drzl/generator-valibot': minor
'@drzl/generator-typebox': minor
'@drzl/validation-core': minor
'@drzl/generator-zod': minor
'@drzl/analyzer': minor
'@drzl/cli': minor
---

Check generated schemas against Postgres itself, and validate the numeric format.

Every check so far compared DRZL to `drizzle-orm`'s validators. Both can be wrong about the same
column and neither is the authority, so `verify:packed` now runs the emitted schemas against a
real Postgres through PGlite: 1287 probes, each an actual INSERT, with the database answering
directly.

DRZL agrees with Postgres on **920** of them to `drizzle-orm`'s **897**, and is never further from
the database on a column where `drizzle-orm` is closer.

### What it found

A `numeric`/`decimal` column is returned as a string, because a JS number cannot hold arbitrary
precision. That left the schema a bare `z.string()`, which accepts `'hello'` for a numeric column.
`drizzle-orm/zod` still does; Postgres rejects it. Numeric columns now carry the real grammar,
which is broader than it looks: a sign, a leading `.`, exponents, `NaN`/`Infinity`, surrounding
whitespace, and since Postgres 16 the underscore digit separators and `0x`/`0o`/`0b` literals, so
`1_000` and `0xDEAD_beef` are valid. Not applied on SQLite, whose NUMERIC affinity stores whatever
text it is given.

### What it stopped

`date`, `timestamp`, `time`, `interval`, `inet`, `cidr` and `macaddr` were all attempted and all
dropped, each caught turning away input Postgres accepts:

| Type      | What the pattern would have refused                              |
| --------- | ---------------------------------------------------------------- |
| `date`    | `today`, `January 8, 1999`, `20200101`, `01/02/2020`, `infinity` |
| `time`    | `allballs`, `12:00:00+02`                                        |
| `macaddr` | `2020-01-01`, which Postgres pads into `20:20:00:01:00:01`       |
| `inet`    | `10.1/16`, `::ffff:1.2.3.4`                                      |
| `cidr`    | parses as `inet`, then additionally demands zero host bits       |

Those keep a plain string. A check that refuses valid data is worse than no check, and without the
database to ask, all seven looked equally shippable.

### The gate

CI fails if a generated schema disagrees with Postgres where `drizzle-orm` agrees, which is what
an over-strict check looks like. Verified to bite by removing underscore support from the numeric
pattern: it fails and names `'1_000'`.

Incidentally settled an earlier judgement call: DRZL types `bytea` as `Uint8Array` where official
demands a `Buffer`, and Postgres accepts the `Uint8Array`. Official is the one refusing valid data
there.
