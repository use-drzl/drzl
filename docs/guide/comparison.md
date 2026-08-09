# Compared with the first-party validators

drizzle-orm ships its own validator builders. If they do what you need, use them: they add no
generated files to your repository, they need no build step, and they are maintained by the people
who maintain the ORM.

This page is the honest version of the comparison. Every row is measured, in both directions, by
the gate described in [How it is verified](/guide/verification), and the rows where DRZL comes off
worse are on this page too.

## What is being compared, and at which versions

Two comparisons run in CI, one per drizzle-orm major, because the two majors do not describe a
schema the same way and only one of them is what `npm install drizzle-orm` gives you today.

| drizzle-orm               | Compared against                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| 1.0.0-rc.4 (the `rc` tag) | `drizzle-orm/zod`, `drizzle-orm/valibot`, `drizzle-orm/arktype`, `drizzle-orm/typebox-legacy`  |
| 0.45.2 (the `latest` tag) | `drizzle-zod` 0.8.3, `drizzle-valibot` 0.4.2, `drizzle-arktype` 0.1.3, `drizzle-typebox` 0.3.3 |

`typebox-legacy` and not `typebox`: on 1.0.0-rc.4, `drizzle-orm/typebox` targets the newer `typebox`
package and throws `Class extends value undefined` when imported against the released
`@sinclair/typebox`, which is what this generator emits for. `typebox-legacy` is the same module
built for that package. The four 0.4x packages were chosen by installing them and running them
rather than from a compatibility table; all four import against 0.45.2 and none had to be skipped.

The comparison is behavioural, not textual. Both sides build select, insert and update schemas for
every column of the same tables on Postgres, MySQL and SQLite, the same pool of values is pushed
through both, and the verdicts are compared. Reading the emitted source could not do this: a schema
that parses and a schema that validates look identical as text.

Where the two disagree, the database decides which one is right, and the answer is recorded with
the measurement that settled it.

## Feature by feature

|                                   | DRZL                                                                   | first-party                                                      |
| --------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Form                              | TypeScript files you can read and commit                               | schemas built at runtime from the table object                   |
| Runtime dependency                | the emitted zod module imports `zod` and nothing else                  | `drizzle-orm` and the table object, at runtime                   |
| Libraries                         | Zod, Valibot, ArkType, TypeBox, Effect Schema, JSON Schema and OpenAPI | Zod, Valibot, ArkType, TypeBox; also Effect Schema on 1.0.0-rc.4 |
| `CHECK` constraints               | reproduced as ranges, membership, length and element counts            | not reproduced                                                   |
| `varchar(n)` length               | counted in characters, which is what Postgres and MySQL count          | counted in UTF-16 units                                          |
| MySQL `TEXT` and `BLOB` caps      | counted in bytes, which is what MySQL enforces                         | counted in UTF-16 units                                          |
| `numeric` / `decimal`             | the numeric format is enforced, and precision and scale are read       | any string is accepted                                           |
| `real` / float4 range             | bounded where the database stops accepting                             | bounded at +/-8388607                                            |
| `double precision` / float8 range | no finite bound, because float8 is the JavaScript number's own format  | bounded at +/-140737488355327                                    |
| `bytea` / `blob`                  | any `Uint8Array`                                                       | a `Buffer`                                                       |
| TypeBox `uuid`                    | a pattern, which needs no setup                                        | `format: 'uuid'`, which needs a populated `FormatRegistry`       |
| MySQL `year` on 0.45.2            | an unbounded integer                                                   | an integer within 1901..2155                                     |
| SQLite `integer` on 0.45.2        | the signed 64-bit range, in the Valibot, ArkType and TypeBox output    | the safe-integer range                                           |

## Where DRZL is stricter, and the database agrees

**`CHECK` constraints.** This is the row the project exists for. Against a real Postgres, over 53
probes on 13 constrained columns, the run behind this page printed:

```
    rows Postgres rejects and the validator accepts: DRZL 0, drizzle-orm 22
```

The same question asked of SQLite over 32 probes on 10 constrained columns, and of MySQL over 37
probes, both answer `0`. On the eight-column table on the [Benchmarks](/guide/benchmarks) page,
DRZL reproduces four of the four constraints the database enforces and `drizzle-orm/zod`
reproduces none. Every one of those is a row that passes validation and then fails at the database,
which is the worst place to find out.

**Byte caps on MySQL text and blob columns.** MySQL's `TEXT` and `BLOB` families carry their limit
in the type itself, and that limit is a byte budget. A 100 emoji string is 200 UTF-16 units and 400
UTF-8 bytes, so a `tinytext` whose budget is 255 bytes refuses it. The first-party modules count
units and accept it; a real MySQL 8.4 on a utf8mb4 client answers `Data too long`.

**`numeric` and `decimal`.** A `numeric` column is a string over the wire, and a bare string schema
accepts `'hello'` where the database does not. DRZL enforces the format and, where the declaration
states them, the precision and scale: `numeric(10,2)` answers `22003 numeric field overflow` for
2147483648, and the first-party modules accept it because neither drizzle major reads precision or
scale.

**Valibot tuples.** `v.tuple` ignores extra elements, so the first-party valibot schema for a
`point` accepts `[1, 2, 3]`. DRZL emits `v.strictTuple`.

## Where DRZL is looser, and the database still agrees

Most of the recorded divergences run this way, which is why "at least as strict as the first-party
module" is not the claim. From the run behind this page: 30 of 55 documented divergences on
1.0.0-rc.4, and 27 of 49 on 0.45.2, have DRZL accepting something the first-party module refuses.

**Float ranges.** The first-party modules bound a `real` at +/-8388607. Postgres stores 8388608, 9000000, 1e9
and 2147483648 in that column and returns every one unchanged, so that bound refuses rows the column
hands back, and a Select schema built from it refused its own rows. DRZL bounds it where the
database actually stops, found by bisecting over the raw bit pattern of a double. For `double
precision` there is no finite bound that is true: Postgres accepted every finite JavaScript number
into one, measured to `Number.MAX_VALUE` and returned identical, while the first-party bound of
+/-140737488355327 refuses 1.75e15, an ordinary microsecond epoch.

**Characters that are not UTF-16 units.** Three emoji insert into a `char(4)` and read back as four
code points, which are seven UTF-16 units, so a schema counting `.length` refuses a value the
column holds.

**Binary payloads.** A `Buffer` is a `Uint8Array`, so accepting the wider type turns nothing away.
It also needs no `@types/node`, survives a runtime where `Buffer` is undefined, and makes `bytea`
and `blob` validate the same way.

**Dates on write.** `coerceDates` defaults to coercing on insert and update, so all four generators
accept a parseable date string or an epoch number where the first-party modules do not. Set
`coerceDates: 'none'` to match them exactly.

## Where DRZL is worse

**Six columns on drizzle-orm 0.45.2 where the first-party validator is right and DRZL is not.**
Filed rather than fixed, and carried by name in the gate's own defect ledger, which fails the
run if any of them stops reproducing:

```
      mysql/m_year: DRZL emits an unbounded integer, official emits an integer within 1901..2155 [new]
      sqlite/s_int: DRZL emits an integer within the signed 64-bit range, official emits an integer within the safe-integer range [new]
      sqlite/s_blob_bigint: DRZL emits an unbounded bigint, official emits a bigint within the signed 64-bit range [new]
      sqlite/s_n_int: DRZL emits as sqlite/s_int, official emits as sqlite/s_int [as sqlite/s_int]
      sqlite/s_n_default: DRZL emits as sqlite/s_int, official emits as sqlite/s_int [as sqlite/s_int]
      sqlite/s_n_bigint: DRZL emits as sqlite/s_blob_bigint, official emits as sqlite/s_blob_bigint [as sqlite/s_blob_bigint]
```

The last three are the nullable twins of the first three, which is what says the defect is in the
analysis of the column rather than in one emitted shape. The two `s_int` entries are three of the
four libraries rather than all four: zod's own `.int()` refuses a number outside the safe-integer
range without being told to, so the zod output reaches the right answer despite the missing bound.
None of the six reproduces on 1.0.0-rc.4, and 0.45.2 is the major `npm install drizzle-orm` still
serves, so this is the version most readers are on.

**DRZL is slower on rows that pass.** On the table on the [Benchmarks](/guide/benchmarks) page,
DRZL's zod output parses a valid row 15% to 21% slower than `drizzle-orm/zod`'s across three
consecutive runs, and that is the real cost of enforcing four constraints the other schema does not
enforce. On rows that fail typing, which is what an API actually spends its validation time on, the
two are within a few percent, because the cost of a rejected parse is dominated by building the
error.

**The ArkType output has the weakest JSON column of the four.** ArkType's string DSL has no
recursive JSON value, so a `json` or `jsonb` column becomes a union of number, object, string,
boolean and null, which takes `NaN`, `Infinity`, a `Date` and a `Buffer`. The Zod, Valibot and
TypeBox generators build a real JSON value check and reject all four of those. This is a capability
difference in the library rather than a defect in the generator, and `drizzle-orm/arktype` widens
the same way, but if you pick ArkType you get the weaker check.

**Two generators are not in the comparison at all.** There is no first-party JSON Schema module to
compare the JSON Schema generator against. `drizzle-orm/effect-schema` does exist on 1.0.0-rc.4 and
the Effect Schema generator is not yet compared against it. Both are covered by their own package
tests, and the JSON Schema output additionally compiles under ajv in strict mode and is asked the
same `CHECK` questions as the four validator generators against a real Postgres.

**Generated files can go stale and a runtime builder cannot.** The first-party modules read the
table object as it is now, so they are never out of date. DRZL's output is committed code, and a
schema change that nobody regenerates for leaves a schema describing the old table.
`drzl generate --check` exists for exactly this and exits non-zero on drift, but it is a step you
have to add, and the first-party modules need no equivalent.

**One MySQL cap is unprobeable.** Telling a byte budget from a character count needs a string that
is over the cap in bytes and not over it in UTF-16 units, and UTF-8 spends at most three bytes per
unit. For `longtext` that needs more units than V8 will put in a string, so nothing measures that
cap. `mediumtext` is bracketed at the cap and one byte over but has no separating probe. The run
prints both facts by name rather than omitting them.

## How to check any of this

None of the above is a claim you have to take on trust. `pnpm verify:packed` prints every line
quoted here, and the ledgers that record each divergence live in
`scripts/verify/harness/parity.ts` and `scripts/verify/harness/parity-0-4x.ts` beside
the measurement that settled it. An entry that stops being true fails the run just as loudly as a
difference nobody declared. See [How it is verified](/guide/verification).

The rows above that name a drizzle-orm major are covered in full, with what each one emits, on
[drizzle-orm 0.4x and v1](/guide/drizzle-majors).
