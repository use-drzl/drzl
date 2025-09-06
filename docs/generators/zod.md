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

## Generated Output License

- You own the generated output. DRZL grants you a worldwide, royalty‑free, irrevocable license to use, copy, modify, and distribute the generated files under your project’s license.
- A short header is added by default. Configure via `outputHeader` in `drzl.config.ts`:
  - `outputHeader.enabled = false` to disable
  - `outputHeader.text = '...'` to customize
