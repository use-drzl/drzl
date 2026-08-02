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
name:  "string <= 255",                  // varchar(255)
small: "-32768 <= number <= 32767",      // smallint()
```

A `check()` narrows that range rather than sitting beside it. **No official Drizzle validator
module enforces CHECK constraints**, in any library:

```ts
age:   "18 <= number <= 2147483647",     // check(sql`${t.age} >= 18`) on an integer
score: "(0 <= number <= 100 | null)",    // check(sql`${t.score} BETWEEN 0 AND 100`)
tier:  "'gold'",                         // check(sql`${t.tier} = 'gold'`)
```

An exclusive comparison stays exclusive, so `CHECK (n > 0)` yields `0 < number`. An equality on a
string becomes a literal type. Because the constraint is folded into the range, a nullable column
reads `(0 <= number <= 100 | null)`, which lets `null` through exactly as SQL does.

Only unambiguous comparisons are translated; see
[Zod → CHECK constraints](/generators/zod#check-constraints) for what is skipped and why.

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
export const InsertUsersSchema = type({
  /* ... */
});
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
