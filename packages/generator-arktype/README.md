<div align="center">

# @drzl/generator-arktype

<div align="center">

[![CI](https://github.com/use-drzl/drzl/actions/workflows/ci.yml/badge.svg)](https://github.com/use-drzl/drzl/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40drzl%2Fgenerator-arktype)](https://www.npmjs.com/package/@drzl/generator-arktype)

</div>

ArkType schemas from your Drizzle analysis (insert / update / select).

</div>

## Use

Add to `drzl.config.ts`:

```ts
generators: [{ kind: 'arktype', path: 'src/validators/arktype' }];
```

## Output

- `Insert<Table>Schema`, `Update<Table>Schema`, `Select<Table>Schema`
- Optional `index` barrel
- Shared vs inlined schemas supported

## Notes

- Formatting integrates with Prettier/Biome (via `format.engine: 'auto'`).
