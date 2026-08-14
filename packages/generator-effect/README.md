<div align="center">

# @drzl/generator-effect

<div align="center">

[![CI](https://github.com/use-drzl/drzl/actions/workflows/ci.yml/badge.svg)](https://github.com/use-drzl/drzl/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40drzl%2Fgenerator-effect)](https://www.npmjs.com/package/@drzl/generator-effect)

</div>

Effect Schema validators from your Drizzle analysis (insert / update / select).

</div>

## 💚 Sponsor DRZL

<div align="center">

<strong>DRZL is crafted nights & weekends. Sponsorships keep the generators fast, tested, and free.</strong>

[![Sponsor DRZL](https://img.shields.io/badge/GitHub%20Sponsors-Support%20the%20project-ff69b4?logo=github)](https://github.com/sponsors/omar-dulaimi)

</div>

- Every dollar speeds up CI hardware and offsets long test runs on my aging laptop.
- Sponsors get roadmap input and priority responses in GitHub Issues.
- Prefer a quick overview? The current goals and thank-yous are at
  https://use-drzl.github.io/drzl/sponsor.

## Install

`effect` is an **optional** peer, so it is never installed for you. Install it yourself:

```sh
npm install effect
```

`effect` 3.x, imported as `effect/Schema` from core. Not `@effect/schema`, which stopped at 0.75.5
and predates the move into core, and not the 4.0 beta. The floor is **3.13.0**, where
`Schema.standardSchemaV1` first appears.

The peer is optional rather than required because `drizzle-orm@1.0.0-rc.4` declares its own optional
peer on `effect` as `>=4.0.0-beta.83 || >=4.0.0`, and npm installs a required peer automatically.
Declaring one made `npm install @drzl/cli drizzle-orm@1.0.0-rc.4` fail with `ERESOLVE` for every
consumer, whether or not they used this generator.

## Use

Add to `drzl.config.ts`:

```ts
generators: [{ kind: 'effect', path: 'src/validators/effect' }];
```

## Output

- `Insert<Table>Schema`, `Update<Table>Schema`, `Select<Table>Schema` as plain `Schema.Struct`s
- `Standard<Name>` beside each: `Schema.standardSchemaV1(<Name>)`, which is what a tRPC or oRPC
  route needs, since a bare `Schema.Struct` carries no `~standard` key
- `Insert<Table>Input`, `Update<Table>Input`, `Select<Table>Output` type aliases
- Optional `index` barrel, nested relation schemas and a duplicate finder

Both forms are emitted because neither substitutes for the other: the wrapper is the only one with
a `~standard`, and the bare `Struct` is the only one that keeps `.fields`, which `Schema.pick`,
`Schema.omit` and a spread into a wider `Struct` all read.

## Custom names

`affix` renames the exported schemas and type aliases, and `tableCase: 'pascal'` upper-camels
the Drizzle export name (`users` -> `Users`) instead of interpolating it verbatim. Omit it and
the names above are unchanged. The `Standard` prefix sits in front of whatever the affix resolved,
so `StandardInsertUsersSchema` wraps `InsertUsersSchema`.

```ts
generators: [
  {
    kind: 'effect',
    path: 'src/validators/effect',
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

See [the Effect generator docs](https://use-drzl.github.io/drzl/generators/effect) for the column table, the
character-count rule and how `NaN` and the infinities are handled, which runs the opposite way here
from every other validator DRZL emits.
