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
name:  v.pipe(v.string(), v.maxLength(255)),              // varchar(255)
small: v.pipe(v.number(), v.integer(),                    // smallint()
              v.minValue(-32768), v.maxValue(32767)),
```

A `check()` in your schema becomes a `v.check` action. **No official Drizzle validator module
enforces CHECK constraints**, in any library:

```ts
// check('age_adult', sql`${t.age} >= 18`)
age: v.pipe(v.number(), v.integer(), v.minValue(-2147483648), v.maxValue(2147483647),
            v.check((val) => val >= 18, "age_adult: age >= 18")),
```

The constraint sits on the inner schema, so `v.nullable()` wrapping it lets `null` through. That
matches SQL, where a CHECK passes when it evaluates to TRUE **or NULL**.

Only unambiguous comparisons are translated. Cross-column comparisons such as
`start_date < end_date`, compound predicates, function calls and regex matches are skipped rather
than guessed at, since a schema enforcing a guess rejects rows the database would accept. See
[Zod → CHECK constraints](/generators/zod#check-constraints) for the full table.

## Arrays and structured columns

A column declared with `.array()` produces a schema for the array, keeping everything the element
declares inside it:

```ts
tags:   v.array(v.pipe(v.string(), v.maxLength(50))),          // varchar(50).array()
scores: v.array(v.pipe(v.number(), v.integer(), v.minValue(-32768), v.maxValue(32767))),
```

The structured Postgres columns each get the shape their runtime value actually has:

| Column                      | Emitted                                               |
| --------------------------- | ----------------------------------------------------- |
| `point()`, `geometry()`     | `v.strictTuple([v.number(), v.number()])`             |
| `line()`                    | `v.strictTuple([...three...])`                        |
| `vector({ dimensions: 3 })` | `v.pipe(v.array(v.number()), v.length(3))`            |
| `bit({ dimensions: 3 })`    | `v.pipe(v.string(), v.regex(/^[01]*$/), v.length(3))` |
| `bytea()`                   | `v.instance(Uint8Array)`                              |
| `json()`, `jsonb()`         | a recursive `DrzlJsonValue`, declared once per file   |

`strictTuple` rather than `tuple` is deliberate: valibot's plain `tuple` ignores extra items, so a
schema built from it accepts `[1, 2, 3]` for a point. `drizzle-orm/valibot` uses the plain form.

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
