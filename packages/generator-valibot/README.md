<div align="center">

# @drzl/generator-valibot

<div align="center">

[![CI](https://github.com/use-drzl/drzl/actions/workflows/ci.yml/badge.svg)](https://github.com/use-drzl/drzl/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40drzl%2Fgenerator-valibot)](https://www.npmjs.com/package/@drzl/generator-valibot)

</div>

Valibot schemas from your Drizzle analysis (insert / update / select).

</div>

## Use

Add to `drzl.config.ts`:

```ts
generators: [{ kind: 'valibot', path: 'src/validators/valibot' }];
```

## Output

- `Insert<Table>Schema`, `Update<Table>Schema`, `Select<Table>Schema`
- Optional `index` barrel
- Shared vs inlined schemas supported
