<div align="center">

# @drzl/generator-arktype

ArkType schemas from your Drizzle analysis (insert / update / select).

</div>

## Use

Add to `drzl.config.ts`:

```ts
generators: [
  { kind: 'arktype', path: 'src/validators/arktype' },
]
```

## Output

- `Insert<Table>Schema`, `Update<Table>Schema`, `Select<Table>Schema`
- Optional `index` barrel
- Shared vs inlined schemas supported

## Notes

- Formatting integrates with Prettier/Biome (via `format.engine: 'auto'`).
