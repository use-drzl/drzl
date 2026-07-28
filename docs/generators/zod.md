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
export const InsertUsersSchema = z.object({
  /* ... */
});
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
