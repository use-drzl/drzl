---
'@drzl/analyzer': patch
---

A `numeric(p, s)` column is bounded by the width it declares rather than by what a JS number can
carry, its `mode: 'bigint'` spelling stops being described as a 64 bit integer, and Gel's two float
columns stop refusing every value they store.

**The declaration always carried the numbers and nothing read either of them.** `precision` and
`scale` sit on the column object on both drizzle majors, so a `numeric(10,2)` and an unconstrained
`numeric` were the same column to the analysis, and the number mode was bounded at
+/-9007199254740991 for both. That is 2^53 on a column that stops at 10^8.

Measured against PostgreSQL 18.3 through PGlite and MySQL 8.4.11 in Docker, both on the
bound-parameter path a validator guards, and the two agree value for value:

| column    | value                   | Postgres                      | MySQL                         |
| --------- | ----------------------- | ----------------------------- | ----------------------------- |
| `(10,2)`  | `99999999.99`           | accepts                       | accepts                       |
| `(10,2)`  | `99999999.994`          | accepts, stores `99999999.99` | accepts, stores `99999999.99` |
| `(10,2)`  | `99999999.995`          | refuses                       | refuses                       |
| `(10,2)`  | `100000000`             | refuses                       | refuses                       |
| `(10,2)`  | `2147483648`            | refuses                       | refuses                       |
| `(10,2)`  | `9007199254740991`      | refuses                       | refuses                       |
| `(20,0)`  | `99999999999999999999`  | accepts                       | accepts                       |
| `(20,0)`  | `100000000000000000000` | refuses                       | refuses                       |
| `numeric` | `1e40`                  | accepts                       | n/a                           |

Postgres answers `22003 numeric field overflow` on every refusal and MySQL
`ER_WARN_DATA_OUT_OF_RANGE`. So both databases enforce the declared width, and `drizzle-zod` reads
neither number: **DRZL now disagrees with both official validators on this column, deliberately, and
the database is why.** The bound is the largest value the column can hold, `(10^p - 1)` shifted
right by `s` places.

One divergence is left in on purpose and is measured rather than assumed. Both servers round to the
scale before checking the integer digits, so both accept `99999999.994` and store `99999999.99`. The
accepted set is open at the top and no inclusive bound describes it; the one chosen is exactly the
set of values the column can hold and hand back, so a select schema accepts every row the column
returns and the band an insert schema turns away is the band the server would have rounded away.

**`mode: 'bigint'` was described as an int64 column.** Drizzle v1 stamps `dataType: 'bigint int64'`
on all four dialects' bigint-mode classes, so a `numeric(20,0)` was bounded at
+/-9223372036854775807 and labelled `BIGINT`. That column accepts `18446744073709551615` and twenty
nines on both servers, so the emitted schema refused values the column stores and returns on every
read. It is a `NUMERIC` column bounded by its own precision now, and on drizzle 0.4x, where it
carried no bound at all, by the same one.

**A bare `decimal` on MySQL and SingleStore is `decimal(10,0)`.** Measured:
`create table dd (v decimal)` reports `decimal(10,0)` in `information_schema`, and the column accepts
`9999999999` while refusing `10000000000` and `9007199254740991`. It takes that width rather than the
safe-integer fallback. Postgres's bare `numeric` really is unconstrained and keeps the fallback.
SQLite takes no bound at all: `NUMERIC` there is an affinity rather than a type, and measured through
`node:sqlite` a `numeric` column stores `1e300` and `1e32` as REALs and hands each back, so even the
safe-integer bound would refuse rows it returns.

**The infinity question reopened and moved.** `numeric` in `{ mode: 'number' }` stated
`allowsInfinity: false` for every declaration, and the recorded reason was that nothing read
precision, so an unconstrained `numeric` and a `numeric(10,2)` could not be told apart. They can now:
measured through PGlite, an unconstrained `numeric` stores and returns `Infinity` and `-Infinity`
while a `numeric(10,2)` answers `22003` for either, and both take `NaN`. Each declaration says what
its own server does. A column carrying a precision is unchanged.

**Gel's `real` and `doublePrecision` were typed `number` and described no further.** Both came back
labelled `NUMERIC` with no range, no `integer` flag and nothing about the non-finite doubles.
Measured on a live Gel 7.1 through the `gel` client, casting a literal so the server parses it, and
again through a stored property on a real object type:

- `std::float32` and `std::float64` both store `nan`, `inf` and `-inf` and hand all three back
  unchanged. Every read of such a row used to fail validation.
- `std::float32` accepts `3.4028235677973366e38`, stores it as `3.4028234663852886e38`, and refuses
  `3.402823567797337e38` and `1e300` with "is out of range for type std::float32". That edge is
  Postgres's exactly, to the double, so `real` takes the constant this package already carries for a
  Postgres `real`.
- `std::float64` took `1e300` and `Number.MAX_VALUE` faithfully, so it carries no finite bound, and
  the two are labelled `REAL` and `DOUBLE` rather than both `NUMERIC`.

**Both analyzer paths move together.** The v1 codec path and the drizzle 0.4x class-name path
compute the bound with the same function off the same column, so a schema cannot change when a user
upgrades drizzle. That agreement is asserted per dialect through the real analyzer.

No generator changed. The facts are stated on the `Column` and the existing `min`/`max`/`integer`/
`allowsNaN`/`allowsInfinity` rendering carries them, in all five.
