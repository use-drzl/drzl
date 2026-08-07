---
'@drzl/analyzer': patch
---

An MSSQL `tinyint` is bounded where SQL Server bounds it, a Cockroach `bit(n)` stops being
indistinguishable from a `varbit(n)`, and both dialects' bit columns stop being labelled `BINARY`.

**`tinyint` on MSSQL accepted -1, 3.7, 256 and 9007199254740991.** Drizzle stamps
`dataType: 'number uint8'` on `MsSqlTinyInt`, and the semantic range table named `int8`, `int16`,
`int24`, `int32`, `int53`, `uint53` and `int64` and no `uint8`. The column fell through to the bare
number arm, which labels it `NUMERIC`, states `integer: false` and applies the safe-integer bounds.
MSSQL exists only on drizzle v1, so unlike MySQL's `tinyint` there was no class-name table behind it
to supply the right answer.

Measured on SQL Server 2022 (`mcr.microsoft.com/mssql/server:2022-latest`), one `tinyint` column,
each value sent as its own INSERT:

| value              | server                                  |
| ------------------ | --------------------------------------- |
| `-1`               | refused, Msg 220 arithmetic overflow    |
| `0`                | accepted                                |
| `255`              | accepted                                |
| `256`              | refused, Msg 220                        |
| `9007199254740991` | refused, Msg 8115                       |
| `3.7`              | accepted, and the row reads back as `3` |

So the column holds whole numbers from 0 to 255 and hands back nothing else: the five rows written
above read back as 0, 1, 3, 255, 255. It is `TINYINT`, `integer: true`, `0` to `255` now.
`drizzle-orm/zod` at 1.0.0-rc.4 bounds the same column identically and refuses `-1`, `3.7` and `256`,
so official agrees with the server. Unsigned is the whole difference from `int8` beside it: SQL
Server's `tinyint` holds 0 to 255 where MySQL's holds -128 to 127, and drizzle names the two
accordingly. Swept over every column builder all six v1 cores export, MSSQL's `tinyint` is the only
one stating `uint8`.

**A Cockroach `bit(3)` accepted `''` and `'1'`.** The `exact` flag on a bit-string shape was computed
as `codec === 'bit'`, which is Postgres's spelling, and Cockroach columns carry no codec at all, so
both `bit` and `varbit` came back `exact: false` and a fixed-width column was described as a maximum.
Measured on CockroachDB v24.3.5 (`cockroachdb/cockroach:v24.3.5`):

| column      | value         | server                                                      |
| ----------- | ------------- | ----------------------------------------------------------- |
| `bit(3)`    | `''`          | refused, "bit string length 0 does not match type BIT(3)"   |
| `bit(3)`    | `'1'`         | refused, length 1 does not match                            |
| `bit(3)`    | `'10'`        | refused, length 2 does not match                            |
| `bit(3)`    | `'101'`       | accepted, and SELECT hands back the string `'101'`          |
| `bit(3)`    | `'1011'`      | refused, length 4 does not match                            |
| `varbit(8)` | `''`          | accepted                                                    |
| `varbit(8)` | `'1'`         | accepted                                                    |
| `varbit(8)` | `'10101010'`  | accepted, and SELECT hands back `'10101010'`                |
| `varbit(8)` | `'101010101'` | refused, "bit string length 9 too large for type VARBIT(8)" |

`drizzle-orm/zod` at 1.0.0-rc.4 answers the same for both columns. `CockroachBit` is exact now and
`CockroachVarbit` is not, discriminated on the class rather than on a codec neither of them has.

**Both are labelled `BIT` rather than `BINARY`.** That label is the one this package gives a MySQL
`binary(n)`, a run of arbitrary bytes handed over as a string, and a Cockroach bit column is a string
of `0` and `1` like the Postgres `bit(n)` it shares an arm with. A `datetime` column in
`{ mode: 'string' }` moved for the same reason: the semantic had no arm, so it reached the bare
string arm and came back `TEXT`, while the class-name path already answered `TIMESTAMP` for the same
0.4x column. Both relabels change no emitted output, verified rather than argued: the same analysis
emitted through all five generators with the old label and the new one is byte-identical in every
one.

**The fixtures that hid this are built by drizzle now.** `gel-types.spec.ts` built its table out of
`class GelInteger {}` and a bare `drizzle:Columns` object and never called `gelTable`, so it could
only ever show that the analyzer agreed with a class list someone had typed out. It builds a real
`gelTable` now, and it asserts that its fixture names every column builder `gel-core` exports, which
is the check a hand-written list cannot make. `mssql` and `cockroach` had no analyzer fixture at all;
they have one, built by `mssqlTable` and `cockroachTable` over every builder each core exports, which
is what found both defects above. One of them was a fixture bug in its own right: the cockroach bit
fixture passed `{ dimensions: 3 }`, which is Postgres's argument shape, and cockroach ignores it, so
the column reaching the analyzer was a default `bit` of width 1 and the declared 3 never existed.

No generator changed. The facts are stated on the `Column` and the existing `min`/`max`/`integer` and
bit-string rendering carries them, in all five.
