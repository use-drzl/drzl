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

`real` and `double precision` are bounded too, at the point past which a float stops being able
to represent consecutive integers. That is narrower than the column, which holds far larger
values, but a number above it comes back out of the database as a _different_ number.
`drizzle-orm/zod` draws the line in the same place.

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

TypeBox and ArkType keep the UTF-16 form: both state a length declaratively with no predicate to
hook, so their output is approximate for astral text. The zod and valibot generators are exact.

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

`bytea` is typed as `Uint8Array` rather than `Buffer`, which is the one place the output is
deliberately wider than `drizzle-orm/zod`. A Buffer is a Uint8Array, so nothing official accepts
is turned away; the wider check needs no `@types/node`, survives a runtime where `Buffer` is not
defined, and makes a Postgres `bytea` and a SQLite `blob` validate the same way.

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
| MySQL `text()`                          | `z.string().max(65535)`, the width the type itself implies |
| MySQL `binary(4)`                       | `z.string().regex(/^[01]*$/).max(4)`                       |
| SQLite `blob({ mode: 'json' })`         | `z.json()`                                                 |
| SQLite `blob({ mode: 'bigint' })`       | `z.bigint()` with the 64 bit range                         |
| SQLite `integer({ mode: 'timestamp' })` | a date                                                     |

MySQL's text and blob caps are byte counts and this is a character count, which is the same
approximation `drizzle-orm/zod` makes: without knowing the column's charset it is the only one
available. Postgres `text` has no cap and does not get one.

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
age: z.number().int().gte(-2147483648).lte(2147483647)
  .refine((v) => v >= 18, { message: "age_adult: age >= 18" }),

// check('score_range', sql`${t.score} BETWEEN 0 AND 100`)
score: z.number().int()
  .refine((v) => v >= 0, { message: "score_range: score >= 0" })
  .refine((v) => v <= 100, { message: "score_range: score <= 100" })
  .nullable(),
```

Note the ordering on `score`: the refinement sits inside `.nullable()`, so `null` skips it. That
is deliberate, because a SQL CHECK passes when it evaluates to TRUE **or NULL**. Enforcing it on
a nullable column would make the schema stricter than the database.

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
n: z.number().int()
  .refine((v) => v > 0, { message: "n_bounds: n > 0" })
  .refine((v) => v < 10, { message: "n_bounds: n < 10" })
  .refine((v) => v !== 5, { message: "n_bounds: n <> 5" }),
```

Every part of an `AND` has to hold on its own, which is exactly what a list of refinements means.
The split walks the expression rather than splitting on the text, so the `AND` inside a `BETWEEN`
and the one inside `'A AND B'` are both left alone. If any single part is not understood, the
whole constraint is skipped: enforcing half of a constraint is enforcing a different one.

**Only unambiguous constraints are translated.** These are skipped rather than guessed at:

| Skipped                       | Why                                                       |
| ----------------------------- | --------------------------------------------------------- |
| `start_date < end_date`       | A statement about the row, not about either field         |
| `age >= 18 OR age <= 65`      | A disjunction cannot be split the way a conjunction can   |
| `NOT (age >= 18)`             | Same: negation changes the scope of everything inside it  |
| `age >= 18 AND length(n) > 3` | One part is not understood, so neither is enforced        |
| `length(name) > 3`            | Function call                                             |
| `email ~ '^[a-z]+$'`          | Postgres `~` is POSIX ERE, not JavaScript's regex dialect |

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

Views get schemas too, including materialized views and views declared with an explicit column
list. There is nothing special to configure: a view in your schema file produces
`Select<View>Schema` alongside the tables.

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
