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

## Generated Output License

- You own the generated output. DRZL grants you a worldwide, royalty‑free, irrevocable license to use, copy, modify, and distribute the generated files under your project’s license.
- A short header is added by default. Configure via `outputHeader` in `drzl.config.ts`:
  - `outputHeader.enabled = false` to disable
  - `outputHeader.text = '...'` to customize
