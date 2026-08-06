# Valibot Generator

Generates Valibot schemas per table (insert/update/select) and an index barrel.

See the [package README](https://github.com/use-drzl/drzl/blob/master/packages/generator-valibot/README.md) for details.

## Example output

```ts
import * as v from 'valibot';
import type { InferInput, InferOutput } from 'valibot';

export const InsertusersSchema = v.object({
  email: v.string(),
});

export const UpdateusersSchema = v.object({
  id: v.number(),
  email: v.optional(v.string()),
});

export const SelectusersSchema = v.object({
  id: v.number(),
  email: v.string(),
});

export type InsertusersInput = InferInput<typeof InsertusersSchema>;
export type UpdateusersInput = InferInput<typeof UpdateusersSchema>;
export type SelectusersOutput = InferOutput<typeof SelectusersSchema>;
```

## Column constraints and CHECK

What the column declares is enforced, in Valibot's pipeline form:

```ts
id:    v.pipe(v.string(), v.uuid()),                      // uuid()
name:  v.pipe(v.string(), v.check((val) => [...val].length <= 255, 'at most 255 characters')),  // varchar(255)
small: v.pipe(v.number(), v.integer(),                    // smallint()
              v.minValue(-32768), v.maxValue(32767)),
```

A `check()` in your schema becomes a `v.check` action. **No official Drizzle validator module
enforces CHECK constraints**, in any library:

```ts
// check('age_adult', sql`${t.age} >= 18`)
age: v.pipe(v.number(), v.integer(), v.minValue(18), v.maxValue(2147483647)),

// check('n_range', sql`${t.n} > 0`)
n: v.pipe(v.number(), v.integer(), v.gtValue(0), v.maxValue(2147483647)),
```

A numeric comparison **replaces** the end of the range it narrows rather than sitting beside it. A
CHECK can only narrow, never widen, since the declared range is the column's type. valibot has the
exclusive forms natively, so `> 0` is `v.gtValue(0)` rather than a closure, and the issue it
raises carries `requirement: 0` as data rather than a sentence this generator wrote.

A constraint with no native form stays a `v.check`. The constraint sits on the inner schema, so
`v.nullable()` wrapping it lets `null` through. That matches SQL, where a CHECK passes when it
evaluates to TRUE **or NULL**.

Only unambiguous comparisons are translated. `start_date < end_date` is applied on the object,
`length()` and `cardinality()` are applied on the field, and disjunctions, negations, regex
matches and unrecognised function calls are skipped rather
than guessed at, since a schema enforcing a guess rejects rows the database would accept. See
[Zod → CHECK constraints](/generators/zod#check-constraints) for the full table.

## Arrays and structured columns

A column declared with `.array()` produces a schema for the array, keeping everything the element
declares inside it:

```ts
tags:   v.array(v.pipe(v.string(), v.check((val) => [...val].length <= 50, 'at most 50 characters'))),  // varchar(50).array()
scores: v.array(v.pipe(v.number(), v.integer(), v.minValue(-32768), v.maxValue(32767))),
```

The structured Postgres columns each get the shape their runtime value actually has:

| Column                      | Emitted                                               |
| --------------------------- | ----------------------------------------------------- |
| `point()`, `geometry()`     | `v.strictTuple([v.number(), v.number()])`             |
| `point({ mode: 'xy' })`     | `v.object({ x: v.number(), y: v.number() })`          |
| `line()`                    | `v.strictTuple([...three...])`                        |
| `line({ mode: 'abc' })`     | `v.object({ a, b, c })`                               |
| `vector({ dimensions: 3 })` | `v.pipe(v.array(v.number()), v.length(3))`            |
| `bit({ dimensions: 3 })`    | `v.pipe(v.string(), v.regex(/^[01]*$/), v.length(3))` |
| `bytea()`                   | `v.instance(Uint8Array)`                              |
| `json()`, `jsonb()`         | a recursive `DrzlJsonValue`, declared once per file   |

`strictTuple` rather than `tuple` is deliberate: valibot's plain `tuple` ignores extra items, so a
schema built from it accepts `[1, 2, 3]` for a point. `drizzle-orm/valibot` uses the plain form.

The object modes go the other way, `object` rather than `strictObject`, and for the same reason:
each follows the column. Asked of a real Postgres, drizzle reads `.x` and `.y` off whatever it is
given, so `{ x: 1, y: 2, z: 3 }` inserts and stores `(1,2)` while a tuple or a string is rendered
`(undefined,undefined)` and refused.

### `NaN` and the infinities

Postgres stores `NaN`, `Infinity` and `-Infinity` in a `real` and in a `double precision` and hands
all three back on SELECT. A bare `v.number()` already takes both infinities and refuses `NaN`, and
`v.maxValue(n)` refuses an infinity whatever `n` is, so what each column needs depends on whether it
carries a range:

```ts
c_real:   v.union([v.pipe(v.number(), v.minValue(-3402...), v.maxValue(3402...)),
                   v.nan(), v.literal(Infinity), v.literal(-Infinity)]),  // real()
c_double: v.union([v.number(), v.nan()]),                                 // doublePrecision()
c_num:    v.union([v.pipe(v.number(), v.minValue(-9007199254740991),
                          v.maxValue(9007199254740991)), v.nan()]),       // numeric({mode:'number'})
```

A `numeric` in number mode takes `NaN` and keeps refusing both infinities, because Postgres refuses
an infinity in any `numeric` carrying a precision and nothing in the analysis reads one. Integer
columns are unchanged, and so are MySQL and SQLite. See
[Zod → `NaN` and the infinities](/generators/zod#nan-and-the-infinities-are-values-not-out-of-range-numbers).

Valibot has no `json()` built-in, so a json column emits a recursive declaration at the top of the
file. It is stricter than the official one in two ways, both of which reject values that cannot
survive the round trip: `Infinity` is refused rather than written out as `null`, and a class
instance such as a `Date` is refused rather than being rebuilt as an empty object.

See [Zod → Structured columns](/generators/zod#structured-columns) for why `bytea` is typed as a
`Uint8Array`.

## Character limits count characters

A `varchar(n)` limit is n **characters**, and `v.maxLength` counts `.length`, which is UTF-16 code
units. This generator emits a code-point check instead, so it accepts the emoji the column does:

```ts
name: v.pipe(v.string(), v.check((val) => [...val].length <= 10, 'at most 10 characters')),
```

See [Zod, character limits](/generators/zod#character-limits-count-characters) for the
measurements against Postgres.

## `typedColumns`

`.$type<T>()` is a compile-time cast on any column, so `text().$type<'admin' | 'member'>()` is an
ordinary string to anything reading it at runtime and the narrowing is lost.

```ts
{ kind: 'valibot', path: 'src/validators/valibot', typedColumns: true }
```

```ts
role: v.pipe(v.string(), v.transform((x) => x as (typeof users.$inferSelect)['role'])),
```

Valibot has no equivalent of TypeBox's `Type.Unsafe`, so the reference is appended as an identity
transform: the value passes through unchanged and only `InferOutput` sees the narrower type. Every
action the schema carried still runs, and the transform is appended after the nullable and
optional wrappers so neither is disturbed.

Off by default. See [Zod → `typedColumns`](/generators/zod#typedcolumns) for the rationale.

## `applyDefaults`

Drizzle knows what a column defaults to, and `drizzle-orm` reproduces none of them.

```ts
{ kind: 'valibot', path: 'src/validators/valibot', applyDefaults: true }
```

```ts
country: v.optional(v.string(), 'GB'),
```

Only **literal** defaults. `defaultNow()`, `defaultRandom()` and any `sql` default are evaluated
by the database, and `$defaultFn` is called by Drizzle at insert time, so those stay optional: a
schema guessing at them would produce a different value than the one actually stored.

Insert only, and off by default, because it changes what parsing _returns_ rather than only what
it accepts.

## Custom names

`Insert<Table>Schema` is the default, not the only option. The `affix` block renames the
exported schemas and the type aliases, and `tableCase: 'pascal'` upper-camels the Drizzle
export name so `users` becomes `Users` instead of being interpolated verbatim.

```ts
{
  kind: 'valibot',
  path: 'src/validators/valibot',
  affix: {
    tableCase: 'pascal',
    type: { prefix: { select: '' }, suffix: { select: '' } },
  },
}
```

```ts
export const InsertUsersSchema = v.object({/* ... */});
export type InsertUsersInput = InferInput<typeof InsertUsersSchema>;
// Select's prefix and suffix are both empty, so the type is just the table name:
export type Users = InferOutput<typeof SelectUsersSchema>;
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
{ kind: 'valibot', path: 'src/validators/valibot', duplicateFinder: true }
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
