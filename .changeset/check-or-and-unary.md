---
'@drzl/validation-core': minor
'@drzl/generator-arktype': minor
'@drzl/generator-effect': minor
'@drzl/generator-json-schema': minor
'@drzl/generator-typebox': minor
'@drzl/generator-valibot': minor
'@drzl/generator-zod': minor
'@drzl/cli': minor
---

Read three more CHECK shapes: a disjunction that pins one column, `IS NOT NULL`, and the null
guard in front of a predicate

`parseCheck` refused every expression holding `OR` and every expression holding `NOT`, which took
`col IS NOT NULL` with it. Three of those refusals are now readings, one is unchanged, and one that
used to be a generic "not a comparison" now says what it found.

```ts
// check('status_valid', sql`${t.status} = 'draft' OR ${t.status} = 'live'`)
status: z.enum(['draft', 'live'] as const).nullable(),

// check('email_set', sql`${t.email} IS NOT NULL`)   // on a nullable column
email: z.string(),

// check('age_adult', sql`${t.age} IS NULL OR ${t.age} >= 18`)
age: z.number().int().gte(18).lte(2147483647).nullable(),

// check('tier_ok', sql`${t.tier} IS DISTINCT FROM 'banned'`)
tier: z.string().refine((v) => v !== 'banned', { message: "tier_ok: tier <> 'banned'" }).nullable(),
```

All five validator generators and the JSON Schema generator, plus `drzl doctor` and the constraint
ledger.

**Why a disjunction was refused, and what changed.** A conjunction splits because every part is
independently _necessary_. A disjunction is the opposite: `CHECK (a OR b)` is satisfied by a row
that breaks `a`, so a schema enforcing `a` refuses rows the database takes. Nothing about that
argument has weakened. What is read is the one shape where the _whole_ disjunction is a single
statement: every branch pinning the same column to a literal, by `=` or by `IN`. `s = 'a' OR
s = 'b'` and `s IN ('a','b')` are the same statement in SQL, NULL included, so they emit the same
schema. Everything else is refused **whole**, never in part, and named:

| Refused                     | Reason reported                                 |
| --------------------------- | ----------------------------------------------- |
| `n < 0 OR n > 100`          | a branch is a range rather than a set of values |
| `a = 'x' OR b = 'y'`        | the branches constrain different columns (a, b) |
| `s = 'a' OR s = 1`          | the branches mix a string and a number          |
| `s = 'a' OR lower(s) = 'b'` | part of an OR was not understood                |

**`IS NOT NULL` narrows the field rather than adding a predicate.** Every other CHECK is emitted
_inside_ the nullable wrapper, precisely so `null` skips it, which is what makes them match SQL.
This one is the statement that `null` is not allowed, so it is said by the field not being
nullable. Applied once, in the three column selectors every generator already calls, so no
generator learns a new kind of check and none of the six can disagree with the others. On insert
the field becomes required, because a row omitting a nullable column with no default writes NULL;
a column that defaults to a value stays optional. On a column already `.notNull()` it changes
nothing and stops being reported as declined.

**A null guard reduces away.** `col IS NULL OR P` states nothing beyond `P`, because a CHECK
already passes on NULL and every operator here yields NULL when its column is NULL. Sound only when
`P` names the guarded column and holds no null test of its own, so `a IS NULL OR b > 0` is still
refused: with `a` null it accepts every `b`. `IS DISTINCT FROM <literal>` reduces the same way and
emits byte for byte what the `<>` it means emits.

**Arithmetic over two columns stays refused, and now says so.** `x + y < 100` used to report "not a
single comparison this version understands". It now names the operator, and `drzl doctor` says what
to do instead. The reason is measured rather than argued: Postgres computes `numeric` exactly and
JavaScript computes in binary floating point.

| Column type        | `CHECK (x + y <= 0.3)` with `(0.1, 0.2)` | JavaScript `0.1 + 0.2 <= 0.3` |
| ------------------ | ---------------------------------------- | ----------------------------- |
| `numeric(10,2)`    | accept                                   | false, so it would reject     |
| `double precision` | reject                                   | false, so it would agree      |

One expression, two column types, two different correct answers, and the expression does not carry
the type. A `bigint` pair adds a third, since Postgres raises on overflow where `BigInt` does not.
Any single reading is wrong for two of the three in the direction that refuses rows the database
accepts, which is the failure this parser exists to avoid.

**Ground truth.** 64 probes through a real Postgres (PGlite), one table per constraint so a sibling
CHECK cannot fail the statement before the value under test is reached, each value put to both the
database and the emitted insert schema: **0 rows the schema refuses and Postgres accepts**, 58
agree, 6 wide. Every wide row is a constraint DRZL deliberately enforces nothing for, which is the
safe direction.

`IS NULL` on its own is read but enforced nowhere, since narrowing a field to only null would mean
replacing the column's type rather than wrapping it; `drzl doctor` lists it with that reason.
`NOT`, `NOT IN` and the boolean `IS TRUE` family remain refused.
