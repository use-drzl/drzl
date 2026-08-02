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
export const InsertUsersSchema = v.object({
  /* ... */
});
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
