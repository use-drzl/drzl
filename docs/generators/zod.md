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

Those bounds are the database's rather than `drizzle-orm/zod`'s, which bounds the same two columns
at `-8388608 .. 8388607` and `-140737488355328 .. 140737488355327`. Both refuse values the column
hands back, `9000000` in a `real` and `1.75e15` in a `double precision`, so DRZL is deliberately
wider on every 4 and 8 byte float column. Each one is waived in the parity gate with the measured
divergence attached.

## Character limits count characters

A `varchar(n)` limit is n **characters**. Every JavaScript validator counts `.length`, which is
UTF-16 code units, and the two agree only until the text leaves the basic plane:

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

| Column                      | Runtime value              | Emitted                                 |
| --------------------------- | -------------------------- | --------------------------------------- |
| `point()`                   | `[number, number]`         | `z.tuple([z.number(), z.number()])`     |
| `line()`                    | `[number, number, number]` | `z.tuple([...])`                        |
| `geometry()`                | `[number, number]`         | `z.tuple([z.number(), z.number()])`     |
| `vector({ dimensions: 3 })` | `number[]`                 | `z.array(z.number()).length(3)`         |
| `bit({ dimensions: 3 })`    | `'010'`                    | `z.string().regex(/^[01]*$/).length(3)` |
| `bytea()`                   | `Buffer`                   | `z.instanceof(Uint8Array)`              |
| `json()`, `jsonb()`         | any JSON value             | `z.json()`                              |

`bytea` is typed as `Uint8Array` rather than `Buffer`, which is deliberately wider than
`drizzle-orm/zod`. A Buffer is a Uint8Array, so nothing official accepts is turned away; the wider
check needs no `@types/node`, survives a runtime where `Buffer` is not defined, and makes a
Postgres `bytea` and a SQLite `blob` validate the same way.

It is not the only place the output is wider. This page used to say it was, which the project's own
parity gate had already contradicted: that gate waives each difference from the first-party module
with the exact values measured, and prints on every run how many of them are DRZL accepting
something official refuses. The float bounds described above are wider on six columns across the
three dialects, and every one of those is waived too.

A CHECK constraint naming an array or a structured column is skipped rather than folded in, since
the comparison is against a scalar literal and describes neither.

## Dialects other than Postgres

The same rules apply, with each dialect's own widths:

| Column                                  | Emitted                                                    |
| --------------------------------------- | ---------------------------------------------------------- |
| MySQL `tinyint()`                       | `z.number().int().gte(-128).lte(127)`                      |
| MySQL `mediumint()`                     | `z.number().int().gte(-8388608).lte(8388607)`              |
| MySQL `year()`                          | `z.number().int().gte(1901).lte(2155)`                     |
| MySQL `serial()`                        | `z.number().int().gte(0)`, since it is unsigned            |
| MySQL `text()`                          | a string capped at 65535 **bytes**, the width the type implies |
| MySQL `binary(4)`                       | a string, capped at 4 characters on select and 4 bytes on insert |
| SQLite `blob({ mode: 'json' })`         | `z.json()`                                                 |
| SQLite `blob({ mode: 'bigint' })`       | `z.bigint()` with the 64 bit range                         |
| SQLite `integer({ mode: 'timestamp' })` | a date                                                     |

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

## CHECK constraints

A `check()` in your schema becomes a refinement. **No official Drizzle validator module does
this**, in any library: a table declaring `check('age_adult', sql\`${t.age} >= 18\`)` produces a
`drizzle-orm/zod` schema that accepts `{ age: 5 }`.

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

### `length()` becomes a character count

```ts
// check('name_len', sql`length(${t.name}) >= 3 AND length(${t.name}) <= 8`)
name: z.string()
  .refine((v) => [...v].length >= 3, { message: 'name_len: length(name) >= 3' })
  .refine((v) => [...v].length <= 8, { message: 'name_len: length(name) <= 8' }),
```

The one function call the parser reads, because the mapping is exact. `char_length` is the same
function and is read too. Counted in code points, so it agrees with the database on emoji.

`octet_length` is **not** read: it counts bytes, which depends on the encoding and cannot be
derived from a JavaScript string without choosing one. Neither is `lower`, which would need a
locale to be faithful.

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

| Skipped                            | Why                                                      |
| ---------------------------------- | -------------------------------------------------------- |
| `age >= 18 OR age <= 65`           | A disjunction cannot be split the way a conjunction can  |
| `NOT (age >= 18)`                  | Same: negation changes the scope of everything inside it |
| `age >= 18 AND lower(n) = 'x'`     | One part is not understood, so neither is enforced       |
| `email ~ '^[a-z]+$'`               | Postgres `~` is POSIX ERE, not JavaScript's regex dialect |
| `octet_length(s) <= 5`             | Bytes, and the column's encoding is not in the schema    |

Applied, and worth naming because they read like exceptions: `start_date < end_date` goes on the
object as a row-level check, `length()` and `char_length()` count code points, `cardinality()`
bounds an array, `BETWEEN` folds into the range, and `IN` becomes an enum. A conjunction is
applied when **every** part is understood.

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

### Why numeric is the only format checked

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

emits, for a table with unique constraints:

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

Two details it follows:

- **Null is not equal to null.** A constraint is skipped for any row where one of its columns is
  null or absent, because a unique index accepts any number of NULLs. Reporting those would send
  you chasing rows the database is perfectly happy with.
- **Composite keys compare by value.** The key is JSON, so `[1, '2']` never collides with
  `['1', 2]`, which a separator-joined key would.

A batch that passes can still collide with rows already stored. This checks the half that needs no
round trip.

Off by default: generated code ships in your bundle.
