# Standard Template

Minimal oRPC router template for quick scaffolding without service wiring.

See the [package README](https://github.com/use-drzl/drzl/blob/master/packages/template-standard/README.md) for hooks and notes.

## Key typing

The `get`, `update` and `delete` inputs are typed from the table's primary key, every column of
it, at its real type: `{ id: z.number() }` for an integer key, `{ isbn: z.string() }` for a
natural one, every column in key order for a composite one. A table with no primary key emits
`list` and `create` only, rather than addressing rows through a fictional `id`. See
[Key typing](/generators/orpc#key-typing) on the generator page for the full policy.

::: tip Need something else?
If this template doesn't cover what you need, DM me on X (https://x.com/omardulaimidev) and we can scope it together.
:::
