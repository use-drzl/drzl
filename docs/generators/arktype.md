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

## Generated Output License

- You own the generated output. DRZL grants you a worldwide, royalty‑free, irrevocable license to use, copy, modify, and distribute the generated files under your project’s license.
- A short header is added by default. Configure via `outputHeader` in `drzl.config.ts`:
  - `outputHeader.enabled = false` to disable
  - `outputHeader.text = '...'` to customize
