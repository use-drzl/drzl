# ArkType Generator

Generates ArkType schemas per table (insert/update/select) and an index barrel.

See the [package README](https://github.com/use-drzl/drzl/blob/master/packages/generator-arktype/README.md) for details.

## Example output

```ts
import { type } from 'arktype';

export const InsertusersSchema = type({
  email: 'string',
});

export const UpdateusersSchema = type({
  id: 'number?',
  email: 'string?',
});

export const SelectusersSchema = type({
  id: 'number',
  email: 'string',
});

export type InsertusersInput = (typeof InsertusersSchema)['infer'];
export type UpdateusersInput = (typeof UpdateusersSchema)['infer'];
export type SelectusersOutput = (typeof SelectusersSchema)['infer'];
```

## Column constraints and CHECK

ArkType states constraints inside the type expression rather than by chaining, so what the column
declares becomes part of the type itself:

```ts
id:    "string.uuid",                    // uuid()
small: "-32768 <= number <= 32767",      // smallint()

// A varchar cap counts characters, which the string DSL cannot express, so the field holds a
// Type carrying a narrow. See "Character limits count characters" below.
name: type("string").narrow(
  (v, ctx) => v == null || [...v].length <= 255 || ctx.mustBe("at most 255 characters")
),
```

A `check()` narrows that range rather than sitting beside it. **No official Drizzle validator
module enforces CHECK constraints**, in any library:

```ts
age:   "18 <= number.integer <= 2147483647",  // check(sql`${t.age} >= 18`) on an integer
score: "(0 <= number.integer <= 100 | null)", // check(sql`${t.score} BETWEEN 0 AND 100`)
n:     "number > 0",                          // check(sql`${t.n} > 0`) on a double
tags:  "string[] >= 2",                       // check(sql`cardinality(${t.tags}) >= 2`)
tier:  "'gold'",                              // check(sql`${t.tier} = 'gold'`)
```

The `.integer` is load bearing: an integer range does not imply integrality in ArkType, and
without it every `integer()` column accepted `1.5`.

A **lone** bound is written on the right of the type, as `number > 0`. ArkType refuses a left
bound with no right bound (`0 < number` is a parse error), so the module used to throw the moment
anything imported it. A pair still reads `0 < number < 10`.

An equality on a string becomes a literal type. Because a constraint is folded into the range, a
nullable column reads `(0 <= number.integer <= 100 | null)`, which lets `null` through exactly as
SQL does.

### What goes on the object

Two constraints cannot live in a field's type, and both go on the object as a `.narrow`:

```ts
})
  .narrow((o, ctx) =>
    o['lo'] == null || o['hi'] == null || o['lo'] < o['hi'] || ctx.mustBe('order: lo < hi'))
  .narrow((o, ctx) =>
    o['name'] == null || [...o['name']].length >= 3 || ctx.mustBe('len: length(name) >= 3'));
```

- **`CHECK (lo < hi)`** compares two columns, so neither field alone can decide it. Both sides are
  null-guarded, matching SQL, where a comparison involving NULL leaves the CHECK satisfied.
- **`CHECK (length(name) >= 3)`** counts characters, and `string >= 3` counts UTF-16 code units.
  See [Character limits count characters](#character-limits-count-characters).

A constraint naming a column the mode does not carry, a generated column on insert say, is left
out rather than evaluated against `undefined`.

Only unambiguous comparisons are translated; see
[Zod → CHECK constraints](/generators/zod#check-constraints) for what is skipped and why.

## Arrays and structured columns

A column declared with `.array()` becomes an array of the element type. The element is
parenthesised, because `'a' | 'b'[]` parses as the literal `'a'` or an array of `'b'`, which is
not what an enum array means:

```ts
tags:  "string[]",                      // text().array()
moods: "('happy' | 'sad')[]",           // moodEnum().array()

// varchar(50).array(): the cap limits each entry, so the narrow goes on the element.
names: type("string")
  .narrow((v, ctx) => v == null || [...v].length <= 50 || ctx.mustBe("at most 50 characters"))
  .array(),
```

| Column                      | Emitted                                           |
| --------------------------- | ------------------------------------------------- |
| `point()`, `geometry()`     | `"number[] == 2"`                                 |
| `point({ mode: 'xy' })`     | `type({ "x": "number", "y": "number" })`          |
| `line()`                    | `"number[] == 3"`                                 |
| `line({ mode: 'abc' })`     | `type({ "a": ..., "b": ..., "c": ... })`          |
| `vector({ dimensions: 3 })` | `"number[] == 3"`                                 |
| `bit({ dimensions: 3 })`    | `"/^[01]*$/ & string == 3"`                       |
| `bytea()`, SQLite `blob()`  | `"TypedArray.Uint8"`                              |
| `json()`, `jsonb()`         | `"number \| object \| string \| boolean \| null"` |

The tuple types are written as a length-constrained array rather than as `[number, number]`.
ArkType does accept a real tuple, but only as a nested array in the definition object, and this
generator emits one string per field. Both reject an array of the wrong length; the tuple form
would additionally give a static type of `[number, number]` rather than `number[]`.

The object modes are the one column with no string form at all: `type({ p: '{ x: number, y: number }' })`
throws `'{' is unresolvable`, and it throws at import, so an approximation there would be a module
nothing can load. Those fields are emitted as a `type(...)` instance instead, with `.array()` per
array dimension, `.or("null")` where the column is nullable, and `?` on the key where it is
optional.

### One thing ArkType cannot state here

A `bigint({ mode: 'bigint' })` column is emitted as plain `bigint`, with no range. ArkType's
comparison operators take numeric literals, so a 64 bit bound cannot be written in the string
DSL at all; `drizzle-orm/arktype` states it through a narrow predicate built with the builder
API instead. Every other column type is bounded here exactly as the official module bounds it.

## Character limits count characters

A `varchar(n)` limit is n **characters**, in both Postgres and MySQL. ArkType's `string <= n`
counts UTF-16 code units, which is a different measurement: a `varchar(10)` column accepts ten
emoji and `string <= 10` refuses eight of them.

That is the direction that breaks working code, so the cap is not written in the string DSL at
all. The field holds a Type instead, carrying a narrow that counts code points:

```ts
name: type("string").narrow(
  (v, ctx) => v == null || [...v].length <= 255 || ctx.mustBe("at most 255 characters")
),
```

For an array column the narrow goes on the element, since `varchar(50).array()` limits each entry
rather than the list:

```ts
tags: type("string")
  .narrow((v, ctx) => v == null || [...v].length <= 50 || ctx.mustBe("at most 50 characters"))
  .array(),
```

MySQL's TEXT family is a byte budget rather than a character count, and gets a narrow counting
encoded bytes. All four generators agree on every one of these, checked column by column against
`drizzle-orm/arktype` and against Postgres, SQLite and MySQL on every commit.

See [Zod, character limits](/generators/zod#character-limits-count-characters) for the
measurements against Postgres.

## `applyDefaults`

Drizzle knows what a column defaults to, and `drizzle-orm` reproduces none of them.

```ts
{ kind: 'arktype', path: 'src/validators/arktype', applyDefaults: true }
```

```ts
country: "string = 'GB'",
```

A field that already holds a Type takes its default through `.default()` instead, after the
narrow, because `type("string = 'GB'")` is not something ArkType will build on its own:
"Defaultable definitions like `'number = 0'` are only valid as properties in an object or tuple".
The same route carries every value the string DSL has no literal for, which is an object, an
array, a Date and a bigint:

```ts
country: type('string')
  .narrow((v, ctx) => [...v].length <= 2 || ctx.mustBe('at most 2 characters'))
  .default('GB'),
payload: type('number | object | string | boolean | null').default(() => ({ a: 1 })),
created: type('Date | string').default(() => new Date('2020-01-01T00:00:00.000Z')),
```

Only **literal** defaults. `defaultNow()`, `defaultRandom()` and any `sql` default are evaluated
by the database, and `$defaultFn` is called by Drizzle at insert time, so those stay optional: a
schema guessing at them would produce a different value than the one actually stored. A literal
this generator cannot write down exactly is left out for the same reason, and `Infinity` is the
one that looks like a literal and is not: `JSON.stringify` turns it into `null`.

Insert only, and off by default, because it changes what parsing _returns_ rather than only what
it accepts.

## Custom names

`Insert<Table>Schema` is the default, not the only option. The `affix` block renames the
exported schemas and the type aliases, and `tableCase: 'pascal'` upper-camels the Drizzle
export name so `users` becomes `Users` instead of being interpolated verbatim.

```ts
{
  kind: 'arktype',
  path: 'src/validators/arktype',
  affix: {
    tableCase: 'pascal',
    type: { prefix: { select: '' }, suffix: { select: '' } },
  },
}
```

```ts
export const InsertUsersSchema = type({/* ... */});
export type InsertUsersInput = (typeof InsertUsersSchema)['infer'];
// Select's prefix and suffix are both empty, so the type is just the table name:
export type Users = (typeof SelectUsersSchema)['infer'];
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
{ kind: 'arktype', path: 'src/validators/arktype', duplicateFinder: true }
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
