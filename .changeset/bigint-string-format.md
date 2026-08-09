---
'@drzl/analyzer': patch
'@drzl/validation-core': patch
---

Bound a `bigint({ mode: 'string' })` column by the input syntax its own server parses, per dialect

The arm that typed this column a string (addendum BK) stated nothing else, so every generator
emitted a bare string. Graded against a real Postgres through PGlite with the parity gate's own
36-value probe pool, that schema disagreed with the server on **14** of them, and on every one
of the 14 `drizzle-orm`'s own validator agreed with the server: `''`, `'hello'`, a 300-character
run, three and five emoji, `'12.5'`, a uuid, `'not-a-uuid'`, `'happy'`, `'zzz'`, `'2020-01-01'`,
`'12:00:00'`, `'10.0.0.1'` and `'999.999.999.999'` all validated and then failed at the INSERT,
which is the outcome an insert schema exists to prevent.

The column now carries a `format`, which is the vehicle all six validation generators already
route through `COLUMN_FORMATS`, so nothing in any generator changed. There are **two** patterns,
because the two servers disagree in both directions, measured on PGlite and on a live MySQL
8.4.11: Postgres stores `'0x1f'` as 31 and `'1_000'` as 1000 and refuses `'12.5'`, while MySQL
refuses the first two as "Data truncated" and stores `'12.5'` as 13, rounded. A single pattern
would have to be their union, which readmits `'12.5'` on Postgres and leaves the defect standing,
or their intersection, which turns away rows each server really stores. So Postgres gets an
integer-literal grammar (sign, surrounding whitespace, underscore separators, decimal or
`0x`/`0o`/`0b`, leading zeros, and the `_` Postgres allows directly after a base prefix) and
MySQL gets a decimal-number grammar with an optional fraction and exponent. SingleStore takes
MySQL's, as every other MySQL-shaped answer in the analyzer does; SQL Server takes neither,
because no SQL Server was measured for its conversion rules, and Cockroach never reaches the arm
at all.

Verified against the servers rather than reasoned about. Postgres: 16160 probes, boundary sweeps
in all four bases and random shapes, **zero** values the server takes and the pattern refuses.
MySQL: 3319 probes against each of a signed and an unsigned column, **zero** again. The read path
is covered too, since the `bigint:string` codec casts to text and registers no normalize, so a row
written `'0x1f'` reads back `'31'`: every value either server hands back validates.

Neither pattern states the magnitude, and that is deliberate. On MySQL it is not expressible: the
range applies to the **rounded** value, so `'9223372036854775807.4'` is a row and
`'9223372036854775807.6'` is not, and `'92233720368547758070e-1'` is the int64 maximum. On
Postgres it is expressible, and the exact ladder was built and agreed with the server 16160/16160,
but leading zeros and separators make it a per-digit ladder of about 1200 characters, and the
ArkType generator states a format as a regex literal inside the type expression: the emitted
module then fails to compile with TS2589, measured on the real emitted output, where the 101
character pattern that ships compiles clean. Emitting a module that does not typecheck is a worse
failure than the bound it buys, and every value the pattern admits that Postgres refuses is
exactly an out-of-range magnitude, so the syntax half is complete on its own. The tests assert
that remainder in both directions, so stating it later reports itself.

The unsigned spelling shares the MySQL pattern, and that is what makes it agree with the database:
`drizzle-orm` at 1.0.0-rc.4 caps `bigint({ mode: 'string', unsigned: true })` at the signed int64
maximum and so refuses `'18446744073709551615'`, which MySQL 8.4.11 stores in a `bigint unsigned`
and hands straight back. DRZL accepts it.

Every other column shape is untouched, proved rather than asserted: master's dists and this
branch's were run side by side over the parity gate's three fixtures, and all 90 emitted files are
byte identical. With a mode-string bigint column added to the Postgres and MySQL fixtures, 78 of
90 stay identical and the 12 that differ are exactly the two `matrix` modules in each of the six
generators, each diverging first at the new column's own line.
