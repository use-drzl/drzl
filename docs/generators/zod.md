# Zod Generator

Generates Zod schemas per table (insert/update/select) and an index barrel.

See the [package README](https://github.com/use-drzl/drzl/blob/master/packages/generator-zod/README.md) for details.

## Example output

```ts
import { z } from 'zod';

export const InsertusersSchema = z.object({
  email: z.string(),
});

export const UpdateusersSchema = z.object({
  id: z.number().optional(),
  email: z.string().optional(),
});

export const SelectusersSchema = z.object({
  id: z.number(),
  email: z.string(),
});

export type InsertusersInput = z.input<typeof InsertusersSchema>;
export type UpdateusersInput = z.input<typeof UpdateusersSchema>;
export type SelectusersOutput = z.output<typeof SelectusersSchema>;
```

## What the column declares is what the schema enforces

Constraints carried on the column become constraints in the schema, rather than being flattened
to a bare type:

```ts
id:    z.uuid(),                                              // uuid()
name:  z.string().max(255),                                   // varchar(255)
small: z.number().int().gte(-32768).lte(32767),               // smallint()
big:   z.bigint().gte(-9223372036854775808n)                  // bigint({ mode: 'bigint' })
          .lte(9223372036854775807n),
```

Integer ranges follow the column width, and `bigint({ mode: 'number' })` is typed as a number
with the JavaScript safe-integer bound rather than as a bigint, because that is what the value
actually is.

`real` is bounded where Postgres stops accepting, `3.4028235677973366e38`, written out in full
decimal. Postgres takes every double up to and including that one and answers `out of range for
type real` to the next. That edge is above the largest float32 rather than at it: a `real` at full
magnitude comes back over the text protocol as `3.4028235e+38`, which is already past the float32,
so a schema bounded there would refuse the value the driver just handed you. `double precision`
carries no magnitude bound at all: Postgres stored `Number.MAX_VALUE` in one and handed it back
unchanged.

MySQL's `float` is bounded lower, at `3.4028234663852886e38`, because MySQL is stricter here than
Postgres: a real MySQL 8.4 refuses the very next double above the largest float32, in strict mode
and under the stock `sql_mode` alike. Its `double` and `real` carry no bound, like Postgres's
`double precision`.

### `NaN` and the infinities are values, not out-of-range numbers

Postgres stores `NaN`, `Infinity` and `-Infinity` in a `real` and in a `double precision`, and hands
all three back on SELECT. No range can admit them: `.gte()/.lte()` refuses an infinity whatever the
numbers are, and `NaN` compares false against both ends. `z.number()` refuses all three on its own,
with no bound at all.

So those columns emit a union, and the range keeps describing the finite values:

```ts
c_real:   z.union([z.number().gte(-3402...).lte(3402...), z.nan(),
                   z.literal(Infinity), z.literal(-Infinity)]),   // real()
c_double: z.union([z.number(), z.nan(),
                   z.literal(Infinity), z.literal(-Infinity)]),   // doublePrecision()
c_num:    z.union([z.number().gte(-9007199254740991)
                            .lte(9007199254740991), z.nan()]),    // numeric({ mode: 'number' })
```

A `numeric` in number mode takes `NaN` and keeps refusing both infinities. Postgres accepts an
infinity in an unconstrained `numeric` and answers `22003 numeric field overflow` for a
`numeric(10,2)`, and nothing in the analysis reads a column's precision or scale, so the two cannot
be told apart; admitting them would promise what the server refuses for the commoner declaration.

Integer columns are unchanged, because Postgres refuses all three there too, and so are MySQL and
SQLite. `drizzle-orm/zod` refuses all three on every one of these columns, so this is a deliberate
divergence with the measurement attached.

Those bounds are the database's rather than `drizzle-orm/zod`'s, which bounds the same two columns
at `-8388608 .. 8388607` and `-140737488355328 .. 140737488355327`. Both refuse values the column
hands back, `9000000` in a `real` and `1.75e15` in a `double precision`, so DRZL is deliberately
wider on every 4 and 8 byte float column. Each one is waived in the parity gate with the measured
divergence attached.

## Character limits count characters

A `varchar(n)` limit is n **characters**. Before zod 4.5, `.max()` counted `.length`, which is
UTF-16 code units, and the two agree only until the text leaves the basic plane. zod 4.5 counts
code points there too; the emitted predicate reads the same on every supported zod, which is why it
stays:

```ts
name: z.string().refine((v) => [...v].length <= 10, { message: 'at most 10 characters' }),
```

Measured against Postgres for a `varchar(10)` column:

| value               | database    | `.max(10)`  | this    |
| ------------------- | ----------- | ----------- | ------- |
| 10 plain characters | accepts     | accepts     | accepts |
| 8 emoji             | **accepts** | **refuses** | accepts |
| 10 emoji            | **accepts** | **refuses** | accepts |
| 11 emoji            | refuses     | refuses     | refuses |

`drizzle-orm/zod` emits `.max(n)`, so it turns away a bio, display name or message that the column
would have stored. The same applies to a `CHECK (length(x) <= n)`.

All four generators count code points. TypeBox and ArkType cannot say it in their declarative
forms, so neither uses `maxLength` or `string <= n`: TypeBox intersects a registered kind onto the
field, ArkType puts a Type carrying a narrow there. See
[TypeBox](/generators/typebox#character-limits-count-characters) and
[ArkType](/generators/arktype#character-limits-count-characters) for what each costs.

MySQL's TEXT family is a byte budget rather than a character count, which is a different
measurement on the same kind of column. `tinytext` takes 255 plain characters and 63 emoji,
verified against a real MySQL 8 on utf8mb4, and gets a check counting encoded bytes.

## Arrays

A column declared with `.array()` produces a schema for the array, with everything the element
declares kept inside it:

```ts
tags:   z.array(z.string().max(50)),                          // varchar(50).array()
scores: z.array(z.number().int().gte(-32768).lte(32767)),     // smallint().array()
moods:  z.array(z.enum(['happy', 'sad'] as const)),           // moodEnum().array()
```

Note that `.array(3)` is **not** an array. It sets a size rather than a dimension, and Drizzle
itself treats the result as a scalar, so DRZL does too.

## Structured columns

Some Postgres columns do not arrive as scalars at all, and a schema that says otherwise rejects
every row the database returns:

| Column                      | Runtime value              | Emitted                                      |
| --------------------------- | -------------------------- | -------------------------------------------- |
| `point()`                   | `[number, number]`         | `z.tuple([z.number(), z.number()])`          |
| `point({ mode: 'xy' })`     | `{ x, y }`                 | `z.object({ x: z.number(), y: z.number() })` |
| `line()`                    | `[number, number, number]` | `z.tuple([...])`                             |
| `line({ mode: 'abc' })`     | `{ a, b, c }`              | `z.object({ a, b, c })`                      |
| `geometry()`                | `[number, number]`         | `z.tuple([z.number(), z.number()])`          |
| `vector({ dimensions: 3 })` | `number[]`                 | `z.array(z.number()).length(3)`              |
| `bit({ dimensions: 3 })`    | `'010'`                    | `z.string().regex(/^[01]*$/).length(3)`      |
| `bytea()`                   | `Buffer`                   | `z.instanceof(Uint8Array)`                   |
| `json()`, `jsonb()`         | any JSON value             | `z.json()`                                   |

`bytea` is typed as `Uint8Array` rather than `Buffer`, which is deliberately wider than
`drizzle-orm/zod`. A Buffer is a Uint8Array, so nothing official accepts is turned away; the wider
check needs no `@types/node`, survives a runtime where `Buffer` is not defined, and makes a
Postgres `bytea` and a SQLite `blob` validate the same way.

It is not the only place the output is wider. This page used to say it was, which the project's own
parity gate had already contradicted: that gate waives each difference from the first-party module
with the exact values measured, and prints on every run how many of them are DRZL accepting
something official refuses. The float bounds described above are wider on six columns across the
three dialects, and every one of those is waived too.

The object modes are objects, not tuples, and every generator here says so. Asked of a real
Postgres through both drizzle majors: `point({ mode: 'xy' })` stores `{ x: 1.5, y: -2.25 }` as
`(1.5,-2.25)` and reads it back unchanged, while `[1, 2]` and `'1,2'` are both rendered
`(undefined,undefined)` by drizzle and refused with `invalid input syntax for type point`. The
emitted object is not strict, because the column is not: an unlisted key is ignored and the row
`{ x: 1, y: 2, z: 3 }` stores `(1,2)`.

A CHECK constraint naming an array or a structured column is skipped rather than folded in, since
the comparison is against a scalar literal and describes neither.

## Dialects other than Postgres

The same rules apply, with each dialect's own widths:

| Column                                  | Emitted                                                          |
| --------------------------------------- | ---------------------------------------------------------------- |
| MySQL `tinyint()`                       | `z.number().int().gte(-128).lte(127)`                            |
| MySQL `mediumint()`                     | `z.number().int().gte(-8388608).lte(8388607)`                    |
| MySQL `int({ unsigned: true })`         | `z.number().int().gte(0).lte(4294967295)`, and every other width takes its own unsigned range the same way |
| MySQL `bigint({ mode: 'bigint', unsigned: true })` | `z.bigint().gte(0n).lte(18446744073709551615n)`, the column's own ceiling, exactly |
| MySQL `year()`                          | `z.number().int().gte(1901).lte(2155)`                           |
| MySQL `serial()`                        | `z.number().int().gte(0).lte(9007199254740991)`: `bigint unsigned` read as a number, so the safe-integer ceiling |
| MySQL `text()`                          | a string capped at 65535 **bytes**, the width the type implies   |
| MySQL `binary(4)`                       | a string, capped at 4 characters on select and 4 bytes on insert |
| SQLite `blob({ mode: 'json' })`         | `z.json()`                                                       |
| SQLite `blob({ mode: 'bigint' })`       | `z.bigint()` with the 64 bit range                               |
| SQLite `integer({ mode: 'timestamp' })` | a date                                                           |

MySQL's text and blob caps are byte counts. Postgres `text` has no cap and does not get one.

A `binary(n)`/`varbinary(n)` is not a bit string, which is what an earlier release of this table
said and what `drizzle-orm/zod` still emits on drizzle v1. Asked of MySQL 8.4 through drizzle on
both majors: the column takes any bytes at all and hands them back as a string, so a `^[01]*$`
pattern rejected every row. The two caps differ because the decode is lossy: `<ff ff ff>` out of a
`varbinary(3)` is three characters that re-encode to nine bytes, so a byte cap on a select schema
would refuse a row the column returned, while a `varbinary(8)` refuses three emoji, which is three
characters and twelve bytes, so a character cap on an insert schema would promise a write the
server refuses.

## Which columns appear on insert

A column is omitted from the insert schema only when the database would **refuse** a value for
it, which is narrower than "the database can fill it in":

| Column                              | On insert |
| ----------------------------------- | --------- |
| `serial()`, MySQL `autoincrement()` | optional  |
| `generatedByDefaultAsIdentity()`    | optional  |
| `generatedAlwaysAsIdentity()`       | omitted   |
| `generatedAlwaysAs(...)`            | omitted   |
| `.default(...)`                     | optional  |

An `AUTO_INCREMENT` or `serial` column supplies a value when you omit one; it does not forbid you
from supplying your own, which is how backfills and sentinel rows get written. Only
`GENERATED ALWAYS` really rejects an explicit value.

## Date columns

`coerceDates` decides what a date column accepts, and defaults to `'input'`: strict on select,
coercing on insert and update, so a client may send an ISO string or an epoch number.

```ts
{ kind: 'zod', path: 'src/validators/zod', coerceDates: 'none' }
```

- `'input'` (default) coerces on write only. A `Date`, a date string and an epoch number are
  accepted; `null`, booleans, arrays and unparseable strings are not.
- `'all'` coerces on select as well.
- `'none'` accepts only a real `Date` anywhere, which is what `drizzle-orm/zod` does.

Coercion is deliberately limited to strings and numbers. `z.coerce.date()` would accept anything
`new Date()` does not choke on, and `new Date(null)` is the epoch while `new Date(true)` is one
millisecond past it, so a NOT NULL column would accept both.

The spelling is a union of the three input types rather than a `z.preprocess`, and the difference is
the type rather than the behaviour:

```ts
publishedAt: z.union([
  z.date(),
  z.number().transform((v) => new Date(v)).pipe(z.date()),
  z.string().regex(/.../).transform((v) => new Date(v)).pipe(z.date()),
]),
```

A `z.preprocess` accepts anything, so `z.input<typeof InsertusersSchema>` reported `unknown` for the
column and every consumer that reads the input type got nothing from it. The union says
`Date | number | string`, which is what valibot and ArkType already reported for the same column.
Behaviour is unchanged, measured over eighteen values including `'12.5'`, `'0101'`, `'010'`, `null`,
`true`, `[1, 2]` and a string that parses to an Invalid Date: identical verdicts on every one. The
`.pipe(z.date())` after each transform is what keeps the last of those identical.

## CHECK constraints

A `check()` in your schema becomes a refinement. **No official Drizzle validator module does
this**, in any library: a table declaring `check('age_adult', sql\`${t.age} >= 18\`)`produces a`drizzle-orm/zod`schema that accepts`{ age: 5 }`.

```ts
// check('age_adult', sql`${t.age} >= 18`)
age: z.number().int().gte(18).lte(2147483647),

// check('score_range', sql`${t.score} BETWEEN 0 AND 100`)
score: z.number().int().gte(0).lte(100).nullable(),
```

A numeric comparison **replaces** the end of the range it narrows rather than sitting beside it. A
CHECK can only narrow, never widen, since the declared range is the column's type, so
`.gte(-2147483648).lte(2147483647).refine((v) => v >= 18)` was a bound that can never fail plus a
closure saying what the bound should have said.

The error is the reason this matters more than the speed. `.gte(18)` produces zod's own `Too
small, expected number to be >=18`, with the bound machine-readable on the issue, rather than a
sentence this generator wrote that a client would have to parse.

A constraint that has no native form stays a refinement, and where one does the ordering is
deliberate: it sits inside `.nullable()`, so `null` skips it. A SQL CHECK passes when it evaluates
to TRUE **or NULL**, and enforcing it on a nullable column would make the schema stricter than the
database.

### `IN` lists become enums

```ts
// check('status_valid', sql`${t.status} IN ('active', 'archived')`)
status: z.enum(["active", "archived"] as const),
```

A set constraint is what an enum is, so it takes the enum's shape rather than becoming a
predicate, and the static type narrows with it.

### Conjunctions split

```ts
// check('n_bounds', sql`${t.n} > 0 AND ${t.n} < 10 AND ${t.n} <> 5`)
n: z.number().int().gt(0).lt(10)
  .refine((v) => v !== 5, { message: "n_bounds: n <> 5" }),
```

The two bounds fold into the range; the inequality has no native form and stays a refinement.

Every part of an `AND` has to hold on its own, which is exactly what a list of refinements means.
The split walks the expression rather than splitting on the text, so the `AND` inside a `BETWEEN`
and the one inside `'A AND B'` are both left alone. If any single part is not understood, the
whole constraint is skipped: enforcing half of a constraint is enforcing a different one.

### A disjunction of equalities becomes the same enum

```ts
// check('status_valid', sql`${t.status} = 'draft' OR ${t.status} = 'live'`)
status: z.enum(["draft", "live"] as const).nullable(),
```

`s = 'a' OR s = 'b'` and `s IN ('a','b')` are the same statement in SQL, NULL included, so they
emit the same schema. That is the only disjunction that is read.

A conjunction splits because every part is independently _necessary_: enforcing one enforces
something the database enforces too. A disjunction is the opposite. `CHECK (a OR b)` is satisfied
by a row that breaks `a`, so a schema enforcing `a` refuses rows the database takes. There is no
partial reading of an `OR`, so one is understood whole or refused whole, and a refusal is listed
by `drzl doctor` and marked `enforced: false` in the [constraint ledger](/generators/constraints).

Refused, with the reason naming the shape: branches over ranges (`n < 0 OR n > 100`), branches
naming different columns (`a = 'x' OR b = 'y'`, which is a rule about the row), branches mixing a
string and a number, and any branch the parser cannot read on its own.

### `IS NOT NULL` narrows the field

```ts
// check('email_set', sql`${t.email} IS NOT NULL`)   // on a nullable column
email: z.string(),
```

The one constraint that cannot be a refinement. A refinement sits inside `.nullable()` precisely
so `null` skips it, which is what makes every other CHECK match SQL; this one is the statement
that `null` is not allowed, so it is said by the field not being nullable. On insert the field
becomes **required**, because a row omitting a nullable column with no default writes `NULL`; a
column that defaults to a value stays optional.

On a column already declared `.notNull()` it changes nothing and is reported as enforced rather
than as declined.

`IS NULL` is read but enforced nowhere: narrowing a field to _only_ null would mean replacing the
column's type rather than wrapping it. It is listed by `drzl doctor`.

### A null guard in front of a predicate reduces to the predicate

```ts
// check('age_adult', sql`${t.age} IS NULL OR ${t.age} >= 18`)
age: z.number().int().gte(18).lte(2147483647).nullable(),
```

Byte for byte what `CHECK (age >= 18)` emits, because the two constrain exactly the same rows: a
CHECK already passes when it evaluates to NULL, and every operator here yields NULL when its
column is NULL. The guard is dropped only when the predicate _names_ the guarded column and holds
no null test of its own, which is what makes the reduction sound; `a IS NULL OR b > 0` is refused,
since with `a` null it accepts every `b`.

`s IS DISTINCT FROM 'x'` reads the same way. `NULL IS DISTINCT FROM 'x'` is TRUE and `NULL <> 'x'`
is NULL, and a CHECK passes on both, so it emits exactly what `s <> 'x'` emits.

### `length()` becomes a character count

```ts
// check('name_len', sql`length(${t.name}) >= 3 AND length(${t.name}) <= 8`)
name: z.string()
  .refine((v) => [...v].length >= 3, { message: 'name_len: length(name) >= 3' })
  .refine((v) => [...v].length <= 8, { message: 'name_len: length(name) <= 8' }),
```

`char_length` is the same function and is read too. Counted in code points, so it agrees with the
database on emoji.

`lower` is **not** read, since it would need a locale to be faithful.

### `octet_length()` becomes a byte count

```ts
// check('body_bytes', sql`octet_length(${t.body}) <= 5`)      // on a text column
body: z.string().refine((v) => new TextEncoder().encode(v).length <= 5, {
  message: 'body_bytes: octet_length(body) <= 5',
}),

// check('blob_bytes', sql`octet_length(${t.blob}) <= 5`)      // on a bytea column
blob: z.instanceof(Uint8Array).refine((v) => v.length <= 5, {
  message: 'blob_bytes: octet_length(blob) <= 5',
}),
```

A different measurement of the same value, and it needs a different expression on each column type.
Measured on PostgreSQL 17.5, on a `text` holding three emoji and a `bytea` holding six bytes:

| expression        | `text` | `bytea`        | JavaScript                                  |
| ----------------- | ------ | -------------- | ------------------------------------------- |
| `octet_length(x)` | 12     | 6              | `new TextEncoder().encode(v).length`        |
| `length(x)`       | 3      | 6              | `[...v].length`, or `v.length` on the array |
| `char_length(x)`  | 3      | does not exist | `[...v].length`                             |

So `length()` is the character count on a text column and the byte count on a `bytea` one, and both
are read accordingly. `v.length` on a _string_ is none of the three: it counts UTF-16 units, which is
6 for those same three emoji.

A count is refused on a MySQL `binary(n)`/`varbinary(n)`. The value arrives as a string produced by a
lossy decode, so neither its characters nor their re-encoding is the number the server took, and
`drzl doctor` reports it rather than dropping it.

### `cardinality()` becomes an element count

```ts
// check('tags_rule', sql`cardinality(${t.tags}) > 0`)
tags: z.array(z.string())
  .refine((v) => v.length > 0, { message: 'tags_rule: cardinality(tags) > 0' }),
```

The array analogue of `length()`, and free of the question that one carries: an element count is
the same number in SQL and in JavaScript. `array_length(col, 1)` reads the same way, since for a
one-dimensional array it is that count. Any other dimension is refused.

This is the one check an array column takes. The others are skipped there because a comparison
against a scalar literal says nothing usable about an array, whereas this one is _about_ it.

**Only unambiguous constraints are translated.** These are skipped rather than guessed at:

| Skipped                        | Why                                                                     |
| ------------------------------ | ----------------------------------------------------------------------- |
| `age >= 18 OR age <= 65`       | A disjunction over ranges is not a set of values, so it states no union |
| `a = 'x' OR b = 'y'`           | Its branches name different columns, so it is a rule about the row      |
| `NOT (age >= 18)`              | Negation changes the scope of everything inside it                      |
| `x + y < 100`                  | Arithmetic, which the schema cannot compute the way the database does   |
| `age >= 18 AND lower(n) = 'x'` | One part is not understood, so neither is enforced                      |
| `email ~ '^[a-z]+$'`           | Postgres `~` is POSIX ERE, not JavaScript's regex dialect               |
| `octet_length(bin) <= 5`       | On a `varbinary(n)`, whose bytes JavaScript cannot see                  |
| `flag IS TRUE`                 | A boolean literal, which the parser does not read yet                   |

**Arithmetic between columns is refused deliberately**, and it is the refusal most worth arguing
for. Postgres computes `numeric` exactly and JavaScript computes in binary floating point:
`CHECK (x + y <= 0.3)` on two `numeric(10,2)` columns **accepts** `(0.1, 0.2)`, and the same
expression in JavaScript is `0.30000000000000004` and rejects it. Both measured against Postgres.
On two `double precision` columns the database computes the same IEEE-754 sum JavaScript does and
**rejects** the same pair, and a `bigint` pair adds a third answer, since Postgres raises on
overflow where JavaScript's `BigInt` does not. So the correct translation of one expression
depends on a column type the expression does not carry, and any single reading would be wrong for
two of the three in the direction that refuses rows the database accepts. `drzl doctor` names the
operator and suggests moving the result into a generated column and constraining that.

Applied, and worth naming because they read like exceptions: `start_date < end_date` goes on the
object as a row-level check, `length()` and `char_length()` count code points, `octet_length()`
counts bytes, `cardinality()` bounds an array, `BETWEEN` folds into the range, `IN` and a
disjunction of equalities both become an enum, `IS NOT NULL` narrows the field, and `IS NULL OR p`
is exactly `p`. A conjunction is applied when **every** part is understood.

A schema that quietly enforces a _guess_ at your constraint is worse than one enforcing nothing,
because it rejects rows the database would have accepted.

## `typedJson`

`json` and `jsonb` columns are typed `any` by default. Set `typedJson` and they take the type you
declared with `.$type<T>()`:

```ts
{ kind: 'zod', path: 'src/validators/zod', typedJson: true }
```

```ts
import type { settings } from '../db/schema.js';

prefs: z.custom<(typeof settings.$inferSelect)["prefs"]>(),
```

`.$type<T>()` is a compile-time cast, so nothing about it survives to runtime and every
runtime-derived validator is blind to it. `drizzle-orm/zod` types a json column as its generic
`Json` whatever you wrote.

DRZL does not try to reconstruct the type either. It references
`typeof settings.$inferSelect['prefs']`, which _is_ the declared type, resolved by TypeScript at
the point of use. That is why generics, unions and imported interfaces all work, where an
approach that parses your source and rebuilds the type would fail on them.

Insert and select reference their own inference, since a defaulted json column is optional on
insert and its type differs there.

Off by default because it adds an `import type` of your schema module to the generated file.
That import is erased at build time, so it adds no runtime dependency and cannot create a runtime
cycle, but the coupling should be a choice.

## Row-level CHECK constraints

`CHECK (start_date < end_date)` is a statement about the row: neither column alone can say whether
it holds, so it cannot be a field refinement. It goes on the object instead:

```ts
export const SelectbookingsSchema = z
  .object({/* ... */})
  .refine((v) => v['startDate'] == null || v['endDate'] == null || v['startDate'] < v['endDate'], {
    message: 'date_order: startDate < endDate',
    path: ['startDate'],
  });
```

Both sides are guarded for null first, reproducing SQL, where a comparison involving NULL yields
NULL and a CHECK passes on NULL. Without that guard an update omitting one column would be
rejected by a comparison the database never applied.

The error is reported against the left column, so it has somewhere to land in a form. A constraint
naming a column the mode does not carry (a generated column on insert, say) is left out rather
than emitted against `undefined`.

## `applyDefaults`

Drizzle knows what a column defaults to. `drizzle-orm/zod` reproduces none of them, so a parsed
insert is missing the values the database would have written.

```ts
{ kind: 'zod', path: 'src/validators/zod', applyDefaults: true }
```

```ts
country: z.string().default("GB"),
count: z.number().int().default(0),
```

`InserttSchema.parse({ name: 'x' })` now returns `{ name: 'x', country: 'GB', count: 0 }`, which is
the row Postgres would have written for the same insert.

Only **literal** defaults are reproduced. `defaultNow()`, `defaultRandom()` and any `sql` default
are evaluated by the database, and `$defaultFn` is called by Drizzle at insert time; those columns
stay `.optional()`, because a schema guessing at them would produce a different value than the one
actually stored.

Insert only. A default applies when a row is created, not when it is updated, and on select the
value is already there.

Off by default, because it changes what parsing _returns_ rather than only what it accepts.

## `typedColumns`

`.$type<T>()` is a compile-time cast on **any** column, not just json. Drizzle's implementation is
literally `$type() { return this }`, so `text().$type<'admin' | 'member'>()` is an ordinary string
to anything reading the column at runtime, and both `drizzle-orm/zod` and DRZL emit a plain
`z.string()`. The narrowing is lost.

```ts
{ kind: 'zod', path: 'src/validators/zod', typedColumns: true }
```

```ts
role: z.string().max(50).pipe(z.custom<(typeof users.$inferSelect)['role']>()),
```

The runtime schema is untouched: the length check is still there, and the reference is appended
rather than substituted. Only the static type changes, from `string` to the union you declared, so
a typo in `if (user.role === 'admni')` becomes a compile error instead of dead code.

Nothing narrows it at _runtime_, because the cast leaves no trace there. If you want the value
checked against the union as well, declare it as an enum column, which DRZL emits as `z.enum`.

Implies `typedJson`, since both need the schema imported back. Off by default: it adds a `.pipe()`
to every field, which is noise unless you use `.$type<T>()`.

## `numeric` and `decimal` columns

A `numeric` column is returned as a string, because a JS number cannot hold arbitrary precision.
That used to leave the schema a bare `z.string()`, which accepts `'hello'` for a numeric column.
`drizzle-orm/zod` still does. Postgres does not:

```ts
amount: z.string().regex(/* the numeric grammar */),
```

The pattern accepts everything Postgres accepts, which is more than it first appears: a sign,
a leading `.`, exponents, `NaN` and `Infinity`, surrounding whitespace, and since Postgres 16 the
underscore digit separators and `0x`/`0o`/`0b` literals, so `1_000` and `0xDEAD_beef` are valid.

It is not applied on SQLite, whose NUMERIC affinity stores whatever text it is given.

## `bigint({ mode: 'string' })` columns

Drizzle v1 can hand a 64 bit column back as a string, and that string also goes to the server as
text, so the same reasoning applies: a bare `z.string()` accepts `'hello'` for a column the server
will refuse. Against a real Postgres it took 14 of the 36 values in DRZL's own probe pool that
Postgres rejects, `drizzle-orm/zod` agreeing with Postgres on every one.

The pattern here is **per dialect**, because the two servers disagree in both directions:

| Value     | Postgres                        | MySQL                      |
| --------- | ------------------------------- | -------------------------- |
| `'0x1f'`  | stores 31                       | refused, "Data truncated"  |
| `'1_000'` | stores 1000                     | refused, "Data truncated"  |
| `'12.5'`  | refused, invalid input syntax   | stores 13, rounded         |
| `'1e3'`   | refused                         | stores 1000                |

So Postgres gets an integer-literal grammar (sign, whitespace, underscore separators, decimal or
`0x`/`0o`/`0b`, leading zeros) and MySQL gets a decimal-number grammar, since MySQL parses the text
as a number and rounds it. SingleStore takes MySQL's, and SQL Server takes neither, because no SQL
Server was measured for it.

Neither pattern states the magnitude. On MySQL it cannot: the range applies to the **rounded**
value, so `'9223372036854775807.4'` is a row and `'9223372036854775807.6'` is not, and no regex
does that arithmetic. On Postgres it can, and the exact bound was built and verified, but leading
zeros and separators make it a per-digit ladder around 1200 characters long, which exhausts
ArkType's type-level budget and emits a module that does not compile. A schema that fails to
typecheck is a worse trade than the bound, so the syntax is stated and the magnitude is not.

### Why so few formats are checked

`date`, `timestamp`, `time`, `interval`, `inet`, `cidr` and `macaddr` were all attempted and all
dropped. Each candidate pattern was run against a real Postgres, and each turned away input the
database accepts:

| Type      | What Postgres takes and the pattern refused                      |
| --------- | ---------------------------------------------------------------- |
| `date`    | `today`, `January 8, 1999`, `20200101`, `01/02/2020`, `infinity` |
| `time`    | `allballs`, `12:00:00+02`                                        |
| `macaddr` | `2020-01-01`, which Postgres pads into `20:20:00:01:00:01`       |
| `inet`    | `10.1/16`, `::ffff:1.2.3.4`                                      |
| `cidr`    | parses as `inet`, then additionally demands zero host bits       |

A check that refuses valid data is worse than no check, so those columns keep a plain string. The
same harness runs in CI and fails the build if a check ever disagrees with Postgres where
`drizzle-orm` does not.

### The one thing a temporal column does say

A shape for the value is out of reach, per the table above, but the floor under it is not. A string
holding nothing but whitespace is not a date, a time or an interval, and `''` is exactly what an
untouched form control submits:

```ts
// date({ mode: 'string' }), timestamp({ mode: 'string' }), time(), interval()
at: z.string().regex(new RegExp('\\S')),
```

Unanchored, so it means "holds at least one non-whitespace character" and nothing else. Measured on
Postgres, every temporal type refuses `''` and `' '` and accepts a valid value with surrounding
whitespace, so this refuses exactly the set the server refuses. The date modes are unaffected: those
columns are a `Date`, not a string.

Which columns carry it is decided per engine and per type, because the servers disagree. Postgres
marks `date`, `time`, `timetz`, `timestamp`, `timestamptz` and `interval`; MySQL marks `date`,
`datetime` and `timestamp` but **not** `time`, which accepts `''` in `STRICT_TRANS_TABLES` and
stores `00:00:00` with no warning at all. SQLite marks nothing, since it stores whatever text it is
given.

## `customType` columns

A `customType` column has nothing checkable at runtime, and DRZL does not pretend otherwise:

```ts
balance: z.unknown(),
```

`getSQLType()` does report the declared SQL type, but that is the database side. `fromDriver` can
map it to anything, so a `numeric(12,2)` custom column may well hand back a `number` where a plain
`numeric` hands back a string. A schema built from the SQL type would reject the real value.

What can be recovered is the type, and `typedJson` does it the same way it does for json, by
referencing Drizzle's own inference rather than guessing:

```ts
{ kind: 'zod', path: 'src/validators/zod', typedJson: true }
```

```ts
balance: z.custom<(typeof accounts.$inferSelect)['balance']>(),
```

`drizzle-orm/zod` emits `z.any()` here, which loses the declared type and also loses the narrowing
that `unknown` forces at the call site.

## Views

Views get schemas too, including views declared with an explicit column list. There is nothing
special to configure: a view in your schema file produces schemas alongside the tables.

A **materialized view** gets a select schema and nothing else. `INSERT INTO mv ...` fails with
`cannot change materialized view`, so an insert or update schema for one describes an operation
the database will always refuse.

An ordinary view keeps all three on Postgres and MySQL. Both accept an `INSERT` into a simple
auto-updatable view, verified against a real server on each, and whether a given view qualifies
depends on its query rather than on anything the schema file states, so refusing them all would
take away something that works.

A **SQLite view** gets a select schema and nothing else, materialized or not. SQLite refuses
every write to a view: `insert`, `update` and `delete` all fail with
`cannot modify <name> because it is a view`.

::: warning A view's columns follow Drizzle, not the server
The nullability and the primary key of a view's columns are inherited from the base columns the
view selects, because that is what Drizzle records. No server agrees in full: Postgres reports
every view column nullable, MySQL widens the nullable ones a join makes optional, and neither
reports a primary key on a view. So a select schema for a view can reject a row the database
really returns, and the service and oRPC generators build by-id endpoints on views that have no
key to look up by.
:::

## Custom names

`Insert<Table>Schema` is the default, not the only option. The `affix` block renames the
exported schemas and the type aliases, and `tableCase: 'pascal'` upper-camels the Drizzle
export name so `users` becomes `Users` instead of being interpolated verbatim.

```ts
{
  kind: 'zod',
  path: 'src/validators/zod',
  affix: {
    tableCase: 'pascal',
    type: { prefix: { select: '' }, suffix: { select: '' } },
  },
}
```

```ts
export const InsertUsersSchema = z.object({/* ... */});
export type InsertUsersInput = z.input<typeof InsertUsersSchema>;
// Select's prefix and suffix are both empty, so the type is just the table name:
export type Users = z.output<typeof SelectUsersSchema>;
```

Prefixes and suffixes take a single string or a per-mode object keyed by `insert`, `update`
and `select`. See [Configuration](/guide/configuration#naming-generated-identifiers) for the
full option list, the collision and identifier checks, and how the oRPC generator inherits
these names when it imports shared schemas.

## Generated Output License

- You own the generated output. DRZL grants you a worldwide, royalty‑free, irrevocable license to use, copy, modify, and distribute the generated files under your project’s license.
- A short header is added by default. Configure via `outputHeader` in `drzl.config.ts`:
  - `outputHeader.enabled = false` to disable
  - `outputHeader.text = '...'` to customize

::: tip Need something else?
If this generator doesn't cover what you need, DM me on X (https://x.com/omardulaimidev) and we can scope it together.
:::

## `duplicateFinder`

Uniqueness is the one constraint a per-row validator structurally cannot check: whether a value is
unique is a fact about the table, not about the row. No first-party validator attempts it, and
neither does a schema here.

What needs no database is whether a **batch collides with itself**, and that is the half you can
fix before sending anything. It matters for a bulk insert, where a thousand rows fail whole on one
collision and the error names a constraint rather than a row.

```ts
{ kind: 'zod', path: 'src/validators/zod', duplicateFinder: true }
```

emits, for a table with a primary key or unique constraints:

```ts
export function findDuplicateusers(
  rows: readonly InsertusersInput[]
): Array<{ index: number; constraint: string; firstIndex: number }> { ... }
```

```ts
findDuplicateusers([
  { email: 'a@b.co', org: 'x', handle: 'h' },
  { email: 'a@b.co', org: 'y', handle: 'h' },
]);
// [{ index: 1, constraint: 'email', firstIndex: 0 }]
```

Three details it follows:

- **The primary key counts.** The database enforces it with a unique index and its own error says
  so: two rows sharing an explicit key fail with `duplicate key value violates unique constraint
  "users_pkey"` (23505, measured on Postgres 17). Seed fixtures carry explicit keys so that
  foreign keys can point at known rows, which makes this the collision bulk data actually has.
  Rows that leave a generated key to the database report nothing on it.
- **Null is not equal to null.** A constraint is skipped for any row where one of its columns is
  null or absent, because a unique index accepts any number of NULLs. Reporting those would send
  you chasing rows the database is perfectly happy with.
- **Composite keys compare by value.** The key is JSON, so `[1, '2']` never collides with
  `['1', 2]`, which a separator-joined key would.

A batch that passes can still collide with rows already stored. This checks the half that needs no
round trip. The [seeding recipe](/examples/seed) composes the finder with the emitted schemas into
a checked bulk-insert pipeline: validate, dedupe, order by foreign keys, chunk, commit.

Off by default: generated code ships in your bundle.

## `meta`: what the schema cannot say about itself

A validator says what a value must look like. It does not say where the value came from, and a
consumer holding only the schema cannot recover it: `z.string()` is a `text`, a `varchar(40)`, a
`citext` and a `char(3)` alike, nothing on it says whether the database fills the column in, and
nothing names the key.

`meta: true` attaches those facts with zod's own `.meta()`, on every field and on every table
schema.

```ts
export default {
  schema: './src/db/schema.ts',
  outDir: './src/api',
  generators: [{ kind: 'zod', path: './src/validators/zod', meta: true }],
};
```

emits:

```ts
export const SelectusersSchema = z
  .object({
    id: z.number().int().gte(-2147483648).lte(2147483647).meta({
      sqlType: 'serial',
      hasDefault: true,
    }),
    email: z
      .string()
      .refine((v) => [...v].length <= 254, { message: 'at most 254 characters' })
      .meta({ sqlType: 'varchar(254)', maxLength: 254 }),
    bio: z.string().nullable().meta({ sqlType: 'text' }),
    age: z
      .number()
      .int()
      .gte(18)
      .lte(2147483647)
      .nullable()
      .meta({ sqlType: 'integer', checks: ['adult: age >= 18'] }),
  })
  .meta({
    table: 'user_accounts',
    dialect: 'postgres',
    mode: 'select',
    primaryKey: ['id'],
    unique: [['email'], ['handle', 'role']],
    unenforcedChecks: ["email_shape: email LIKE '%@%'"],
  });
```

and reads back off the schema object:

```ts
SelectusersSchema.shape.bio.meta(); // { sqlType: 'text' }
SelectusersSchema.meta().primaryKey; // ['id']
```

Off by default. Every byte lands in your bundle, and on a narrow table this roughly doubles the
emitted size: measured on a ten-column table, about 48 bytes per field and 156 per schema.

### `registryIds`: making the document self-describing

```ts
{ kind: 'zod', path: './src/validators/zod', meta: { registryIds: true } }
```

Adds an `id` to each schema's metadata, which is what puts it in zod's registry under a name. Two
things follow, both measured on zod 4.4.3.

A schema that references another emits a reference rather than a second copy of it:

```jsonc
// with registryIds
{ "properties": { "author": { "$ref": "#/$defs/usersSelect" } }, "$defs": { "usersSelect": { … } } }

// without, which is the default
{ "properties": { "author": { "type": "object", "properties": { … } } } }
```

And the whole registry converts in one call, keyed by those names, which is the shape an OpenAPI
`components.schemas` block wants:

```ts
z.toJSONSchema(z.globalRegistry);
// { schemas: { usersInsert: { … }, usersUpdate: { … }, usersSelect: { … } } }
```

**The id is built from the qualified table name**, so `reporting.users` becomes
`reporting_usersSelect` while a table in the default schema keeps the short `usersSelect`. That is
not tidiness. Two schemas sharing an id do not report the collision: measured,
`z.toJSONSchema(registry)` keeps the last one and **silently drops the other**. Two tables, one
entry, no warning, and nothing a consumer can check. Any schema with two SQL schemas can produce
that collision, because `table.name` is the bare name.

Separate from `meta: true` because it is the only metadata key with a failure mode. Everything else
is inert data a consumer may ignore.

### Why it is attached last in the chain

This is the one design decision worth knowing about, because it looks wrong until you measure it.

`.meta()` returns a **clone** carrying the entry, so an operation that clones keeps it and an
operation that _wraps_ does not. Measured on zod 4.4.3:

| chained after `.meta({ x: 1 })`                                    | `.meta()` on the result |
| ------------------------------------------------------------------ | ----------------------- |
| `.refine()`, `.min()`, `.describe()`, `.brand()`                   | `{ x: 1 }`              |
| `.nullable()`, `.optional()`, `.default()`, `z.array()`, `.pipe()` | `undefined`             |

DRZL wraps every nullable column, every field of an update schema, every array column and every
optional-on-insert column. So attaching the metadata to the base type loses it for most of the
output: it survives only at `schema.def.innerType`, an internal you should not be walking.

Attaching after every wrapper is also the position `z.toJSONSchema` reads as the property's own
keywords rather than as one arm of its `anyOf`:

```jsonc
// attached last, which is what DRZL emits
"bio": { "anyOf": [{ "type": "string" }, { "type": "null" }], "sqlType": "text" }

// attached to the base type, which an OpenAPI reader would never find
"bio": { "anyOf": [{ "type": "string", "sqlType": "text" }, { "type": "null" }] }
```

### What each key is, and why it earns its bytes

A key is here only if it says something the schema does not already say. `nullable` is the
counter-example and is deliberately absent: `.nullable()` is right there in the chain and
`anyOf: [..., { "type": "null" }]` is right there in the JSON Schema.

On each field:

| key          | what it adds                                                                                                                                                                                                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sqlType`    | The type as the database declares it, from Drizzle's own `getSQLType()`. Nothing in the schema distinguishes a `text` from a `varchar(40)`.                                                                                                                                                                                      |
| `maxLength`  | The declared character limit. DRZL enforces it as a `.refine()`, and `z.toJSONSchema` **drops every refinement in silence**, so without this the JSON Schema says the column is an unbounded string. `maxLength` is also the JSON Schema keyword, so this puts the constraint back where a validator acts on it.                 |
| `maxBytes`   | The declared byte limit, which MySQL's TEXT and BLOB families carry instead of a character one.                                                                                                                                                                                                                                  |
| `hasDefault` | The database supplies a value when the write omits one. Not recoverable: a defaulted column and a nullable one are **both** `.optional()` on insert.                                                                                                                                                                             |
| `generated`  | The database computes the value and refuses to be given one.                                                                                                                                                                                                                                                                     |
| `checks`     | The CHECK constraints this field enforces, named as the failure messages name them. Not a restatement of the bound beside it: DRZL folds a CHECK into the column's own range, so `minimum: 18` is indistinguishable from a type bound, and this carries the provenance and the constraint name a database error will quote back. |

On each table schema:

| key                | what it adds                                                                                                                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `table`            | The SQL table name, which is not the Drizzle export name the schema is named after.                                                                                                                                                                                     |
| `dialect`          | The same declaration means different things across databases.                                                                                                                                                                                                           |
| `mode`             | `insert`, `update` or `select`. The export name says it; the schema object does not.                                                                                                                                                                                    |
| `primaryKey`       | The key columns, in order. A per-field flag cannot carry the order or the grouping.                                                                                                                                                                                     |
| `unique`           | The unique constraints. The one thing a per-row validator structurally cannot check, which is why [`duplicateFinder`](#duplicatefinder) exists.                                                                                                                         |
| `readOnly`         | The relation refuses writes, which today means a materialized view.                                                                                                                                                                                                     |
| `checks`           | Row-level CHECKs, enforced as object refinements and invisible for the same reason.                                                                                                                                                                                     |
| `unenforcedChecks` | CHECK constraints the database enforces and this schema does not, whether the parser declined the expression or the column's shape has no way to state it. Nothing else in the emitted module mentions these at all; `drzl doctor` is the only other place they appear. |

On an array column the metadata describes the column, and `maxLength` describes the element,
because that is where the emitted schema applies it.

### `description`

`{ meta: { description: true } }` additionally writes a `description`, which `z.toJSONSchema` maps
to the JSON Schema keyword of that name. That is what a Swagger or Redoc viewer renders to a human,
and it is the only key here that any OpenAPI tool understands without being taught.

```ts
{ kind: 'zod', path: 'src/validators/zod', meta: { description: true } }
```

```jsonc
"email":  { "type": "string", "description": "at most 254 characters" },
"age":    { "anyOf": [...], "description": "CHECK adult: age >= 18" }
```

It is separate from `meta: true` because it is prose that repeats what the machine-readable keys
beside it already say, and prose costs the most bytes of anything here.

It is built only from what the schema enforces and cannot show, plus the constraints it does not
enforce. It is never a restatement of the type, and it is never a user comment.

### Two things to know before pointing `z.toJSONSchema` at an emitted schema

**It throws on a column it cannot represent**, with or without this option. A `Date` column
answers `Date cannot be represented in JSON Schema` and a `bytea`, a `customType` or a
`typedColumns` narrowing answers `Custom types cannot be represented in JSON Schema`. Pass
`{ unrepresentable: 'any' }` to get a document instead of an exception:

```ts
z.toJSONSchema(SelectusersSchema, { unrepresentable: 'any' });
```

**OpenAPI 3.0 refuses the keys.** The Schema Object in 3.0 is closed, so a key it does not know is
an error rather than something a reader ignores. Measured against the official 3.0 schema through
`@seriousme/openapi-schema-validator`: a document carrying `sqlType` on a property and `table` on a
schema is invalid, the same document with `x-sqlType` and `x-table` is valid, and `maxLength`,
`description` and `readOnly` are real 3.0 keywords and pass either way. OpenAPI 3.1 and JSON Schema
2020-12 both ignore unknown keywords, so nothing here needs renaming for them. If you target 3.0,
rename the DRZL keys onto `x-` as you build the document, and leave the three real keywords alone.

### There are no column comments to carry, measured

The obvious thing to want here is the comment you wrote on the column. It does not exist.
`drizzle-orm` exposes no column comments at all, on either major:

```
comment-ish own keys on a built column     none
comment-ish methods on its prototype       none
pg.text('a', { comment: 'hello' })         TypeScript refuses the literal; at runtime the key is
                                           dropped and the string is not reachable from the built
                                           column by any path
```

Column options objects are not strict at runtime, so a `comment` key passed through a variable is
accepted and silently discarded. There is no source for DRZL to read, which is why every key above
is a fact the analyzer derived rather than text you wrote.

### zod only, for now

The other four validation generators do not take this option, and are not passed it. Each has a
metadata facility of its own, and _where the metadata has to attach_ is the entire difficulty here:
the answer for zod came out of measuring its clone-versus-wrap behaviour, and it does not transfer.
TypeBox is the obvious next one, because a TypeBox schema **is** a JSON Schema and there is no
placement question at all.

The `json-schema` generator does not read this either. It builds its documents from the same
analysis rather than from a zod schema, so there is nothing to read; it already states what JSON
Schema cannot express as a `description` of its own.

## `constraints`: the table's constraints as data

`constraints: true` also emits `constraints.ts`: every CHECK, unique constraint, primary key and
foreign key on each table as plain data, plus `constraintForIssue`, which turns a failed parse back
into the constraint that caused it.

Not `meta` written to a second file. `meta` describes a **field** and travels with the schema into
`z.toJSONSchema`; this describes the table's **constraints**, carries their names, states each
operand as data rather than inside a sentence, and is read without holding a schema at all. It also
carries the two constraints no per-row schema can hold in any form, uniqueness and foreign keys.

See [Constraint Data and Form Error Maps](/generators/constraints).

## Nested relation schemas

`nestedSchemas: true` also emits `NestedInsert<Table>` and `NestedSelect<Table>`, the table plus one
key per relation, so `{ ...user, posts: [...] }` can be validated whole. Nothing in the Drizzle
ecosystem describes that payload, and `db.insert` drops the relation key silently rather than
refusing it. See [Nested Relation Schemas](/generators/nested-relations).
