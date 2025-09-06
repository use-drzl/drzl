<div align="center">

# @drzl/generator-zod

Zod schemas from your Drizzle analysis (insert / update / select).

</div>

## Use

Add to `drzl.config.ts`:

```ts
generators: [
  { kind: 'zod', path: 'src/validators/zod' },
]
```

## Output

- `Insert<Table>Schema`, `Update<Table>Schema`, `Select<Table>Schema`
- Optional `index` barrel
- Shared vs inlined schemas supported
