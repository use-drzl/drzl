<div align="center">

# @drzl/generator-valibot

<div align="center">

[![CI](https://github.com/use-drzl/drzl/actions/workflows/ci.yml/badge.svg)](https://github.com/use-drzl/drzl/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40drzl%2Fgenerator-valibot)](https://www.npmjs.com/package/@drzl/generator-valibot)

</div>

Valibot schemas from your Drizzle analysis (insert / update / select).

</div>

## 💚 Sponsor DRZL

<div align="center">

<strong>DRZL is crafted nights & weekends. Sponsorships keep the generators fast, tested, and free.</strong>

[![Sponsor DRZL](https://img.shields.io/badge/GitHub%20Sponsors-Support%20the%20project-ff69b4?logo=github)](https://github.com/sponsors/omar-dulaimi)

</div>

- Every dollar speeds up CI hardware and offsets long test runs on my aging laptop.
- Sponsors get roadmap input and priority responses in GitHub Issues.
- Prefer a quick overview? Check `docs/sponsor.md` for the current goals and thank-yous.

## Use

Add to `drzl.config.ts`:

```ts
generators: [{ kind: 'valibot', path: 'src/validators/valibot' }];
```

## Output

- `Insert<Table>Schema`, `Update<Table>Schema`, `Select<Table>Schema`
- Optional `index` barrel
- Shared vs inlined schemas supported

## Custom names

`affix` renames the exported schemas and type aliases, and `tableCase: 'pascal'` upper-camels
the Drizzle export name (`users` -> `Users`) instead of interpolating it verbatim. Omit it and
the names above are unchanged.

```ts
generators: [
  {
    kind: 'valibot',
    path: 'src/validators/valibot',
    affix: {
      tableCase: 'pascal',
      schema: { suffix: 'Schema' },
      type: {
        prefix: { insert: 'Create', update: 'Edit', select: '' },
        suffix: { insert: 'Input', update: 'Input', select: '' },
      },
    },
  },
];
```

Emits `InsertUsersSchema` / `UpdateUsersSchema` / `SelectUsersSchema` plus `CreateUsersInput`,
`EditUsersInput` and a bare `Users`. Every prefix and suffix takes a string or a per-mode
object keyed by `insert`, `update`, `select`. The legacy `schemaSuffix` still works and is the
default for `affix.schema.suffix`.
