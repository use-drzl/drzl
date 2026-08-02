# Configuration

DRZL reads a `drzl.config.ts` that describes your schema path and generators.

```ts
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: 'src/db/schemas/index.ts',
  outDir: 'src/api',
  analyzer: { includeRelations: true, validateConstraints: true },
  generators: [
    { kind: 'zod', path: 'src/validators/zod', schemaSuffix: 'Schema' },
    {
      kind: 'service',
      path: 'src/services',
      dataAccess: 'drizzle',
      schemaImportPath: 'src/db/schema',
      databaseInjection: {
        enabled: true,
        databaseType: 'Database',
        databaseTypeImport: { name: 'Database', from: 'src/db/db' },
      },
    },
    {
      kind: 'orpc',
      template: '@drzl/template-orpc-service',
      includeRelations: true,
      naming: { routerSuffix: 'Router', procedureCase: 'kebab' },
      validation: { library: 'valibot' },
      databaseInjection: {
        enabled: true,
        databaseType: 'Database',
        databaseTypeImport: { name: 'Database', from: 'src/db/db' },
      },
      servicesDir: 'src/services',
    },
  ],
});
```

## Choosing which tables to generate for

By default every table in the schema file gets generated for. Top-level `include` and `exclude`
narrow that:

```ts
export default defineConfig({
  schema: 'src/db/schema.ts',
  exclude: ['session', 'account', 'verification', '__drizzle_*'],
  generators: [{ kind: 'orpc' }],
});
```

Matching is on the **database table name**, anchored, with `*` as the only metacharacter.
Anchored matters: `exclude: ['user']` does not also drop `users`. `exclude` is applied after
`include`, so it wins when both name the same table.

### Auth tables in particular

If you use an auth library that writes into the same schema file, exclude its credential tables.
Better Auth generates `user`, `session`, `account` and `verification`, and **`account` holds
`accessToken`, `refreshToken`, `idToken` and `password`**. Without an exclusion DRZL will happily
generate unauthenticated CRUD endpoints over all of it.

```ts
exclude: ['session', 'account', 'verification'],
```

DRZL deliberately does not detect auth libraries and skip their tables for you. Better Auth's
model names are all overridable through `options.user.modelName`, so a built-in list would miss
renamed tables, and worse, would silently skip an ordinary table called `user`, which in most
applications is the primary entity you *do* want generated.

## Naming generated identifiers

By default the validation generators name their exports `Insert<Table>Schema`,
`Update<Table>Schema` and `Select<Table>Schema`, plus `Insert<Table>Input`,
`Update<Table>Input` and `Select<Table>Output` for the type aliases. `<Table>` is the export
name from your Drizzle schema, used exactly as written, so `export const users = ...` gives
`InsertusersSchema`.

The `affix` option on a `zod`, `valibot`, `arktype`, `typebox` or `json-schema` generator changes all of
that. Leaving
it out keeps the names above unchanged.

```ts
{
  kind: 'zod',
  path: 'src/validators/zod',
  affix: {
    // 'preserve' (default) uses the Drizzle export name verbatim: InsertusersSchema.
    // 'pascal' upper-camels it first:                             InsertUsersSchema.
    tableCase: 'pascal',

    // Affixes for the exported schema constants.
    schema: {
      prefix: { insert: 'Insert', update: 'Update', select: 'Select' },
      suffix: 'Schema',
    },

    // Affixes for the exported type aliases. Independent of `schema`.
    type: {
      prefix: { insert: 'Create', update: 'Edit', select: '' },
      suffix: { insert: 'Input', update: 'Input', select: '' },
    },
  },
}
```

That config emits:

```ts
export const InsertUserProfilesSchema = z.object({
  /* ... */
});
export const UpdateUserProfilesSchema = z.object({
  /* ... */
});
export const SelectUserProfilesSchema = z.object({
  /* ... */
});

export type CreateUserProfilesInput = z.input<typeof InsertUserProfilesSchema>;
export type EditUserProfilesInput = z.input<typeof UpdateUserProfilesSchema>;
export type UserProfiles = z.output<typeof SelectUserProfilesSchema>;
```

### Rules worth knowing

- Every `prefix` and `suffix` takes either a single string, applied to all three modes, or an
  object with any of the keys `insert`, `update` and `select`. Modes you leave out keep their
  default. The keys are lowercase.
- An empty string is allowed, which is how `Select<Table>Output` becomes a plain `<Table>`.
- `schema` and `type` do not inherit from each other. Setting `schema.prefix` leaves the type
  aliases on their defaults, and the other way round.
- Affixes rename identifiers only. File names stay on the raw Drizzle export name
  (`users.zod.ts`), so the barrel and any `importPath` keep resolving. Use `fileSuffix`
  below to rename the files.
- The older flat `schemaSuffix` option still works and acts as the default for
  `affix.schema.suffix`. `affix.schema.suffix` wins when both are set.
- A config that would emit a name TypeScript cannot parse, or two exports in one file with
  the same name, is rejected before any file is written.

### Sharing names with the oRPC generator

An oRPC generator with `validation.useShared` imports those schemas by name, so both
generators have to agree. You do not have to say it twice: when exactly one other generator
produces the library named in `validation.library`, its `affix` is copied over automatically.

```ts
generators: [
  { kind: 'zod', path: 'src/validators/zod', affix: { tableCase: 'pascal' } },
  {
    kind: 'orpc',
    // No affix here. It is inherited from the zod generator above, so the router imports
    // InsertUsersSchema and not InsertusersSchema. `importPath` is emitted verbatim, so it
    // names the barrel file rather than its directory: see "Import extensions" below.
    validation: {
      useShared: true,
      library: 'zod',
      importPath: '../validators/zod/index.js',
    },
  },
],
```

Set `validation.affix` explicitly only when the schemas come from somewhere DRZL does not
generate. If you set it and it disagrees with the sibling generator, `drzl generate` stops
with an error naming both sets of identifiers rather than writing a router that cannot
compile.

## Naming generated files

A `zod`, `valibot`, `arktype`, `typebox` or `json-schema` generator writes one file per table,
named after the Drizzle export name plus a suffix that defaults to `.zod.ts`, `.valibot.ts`,
`.arktype.ts`, `.typebox.ts` or `.schema.ts`, and an `index.ts` barrel that re-exports them.
`fileSuffix` replaces that suffix.

```ts
{ kind: 'zod', path: 'src/validators/zod', fileSuffix: '.schema.ts' }
```

```
src/validators/zod/
  users.schema.ts
  posts.schema.ts
  index.ts        // export * from './users.schema.js';
```

The barrel follows whatever you set, so the generated tree always compiles:

- A suffix with no leading dot runs straight onto the table name. `'Schema.ts'` gives
  `usersSchema.ts` and `./usersSchema.js`.
- A suffix that is only an extension leaves the bare table name. `'.ts'` gives `users.ts`
  and `./users.js`.
- `.mts` and `.cts` are written as `.mjs` and `.cjs`, because that is the only form
  TypeScript resolves for them.

## Import extensions

Every relative specifier DRZL invents ends in `.js` by default:

```ts
// src/validators/zod/index.ts
export * from './users.zod.js';

// src/api/index.ts
import { users } from './users.js';

// src/services/userService.ts
import type { Insertusers } from './types/users.js';
```

Generated files land in your own source tree, so it is your `tsconfig.json` that decides
which specifiers resolve. Measured against tsc 5.9.2 and 7.0.2, for a specifier pointing at
a sibling `.ts` file:

| specifier        | `bundler`                          | `node10` | `node16`/`nodenext`, CommonJS | `node16`/`nodenext`, ESM |
| ---------------- | ---------------------------------- | -------- | ----------------------------- | ------------------------ |
| `./users.zod.js` | resolves                           | resolves | resolves                      | resolves                 |
| `./users.zod`    | resolves                           | resolves | resolves                      | **does not resolve**     |
| `./users.zod.ts` | needs `allowImportingTsExtensions` | needs it | needs it                      | needs it                 |

`.js` is the default because it is the only form that needs no compiler flag and still
resolves everywhere, and because it is what your build emits anyway: after `tsc`,
`users.zod.ts` really is `users.zod.js` on disk. A file is only ESM or CommonJS by virtue of
the nearest `package.json`, so `"type": "module"` plus `moduleResolution: "node16"` is the
combination the extensionless form cannot serve. That combination is not exotic:
`tsc --init` has emitted `"module": "nodenext"` since TypeScript 5.9, every `@tsconfig/node*`
base sets `"moduleResolution": "node16"`, and TypeScript 7 removed `node10` altogether.

Set `importExtension` at the top level to change it for every generator, or on one generator
to override it there:

```ts
export default defineConfig({
  schema: 'src/db/schema.ts',
  importExtension: 'js', // 'js' (default) | 'none' | 'ts'
  generators: [{ kind: 'zod', path: 'src/validators/zod' }],
});
```

- `'js'` gives `./users.zod.js`. The default. Correct after a `tsc` build, and understood by
  Vite, esbuild, Rollup, Bun, Vitest and Next.js, which map it back to the `.ts` source.
- `'none'` gives `./users.zod`. What DRZL emitted before 2.0. Use it if your pipeline cannot
  map `.js` back to `.ts`: webpack without `resolve.extensionAlias`, or Jest with `ts-jest`
  and no `moduleNameMapper`. It does not resolve under `node16`/`nodenext` in an ES module.
- `'ts'` gives `./users.zod.ts`. Needs `"allowImportingTsExtensions": true`, and
  `"rewriteRelativeImportExtensions": true` if you also emit. It is the only form Node's own
  type stripping accepts, so it is what a project running the generated `.ts` unbuilt wants.

`importExtension` only touches specifiers DRZL invents. Paths you write yourself are emitted
verbatim, so under `node16`/`nodenext` in an ES module, spell them the same way: an `orpc`
generator's `validation.importPath` has to name the barrel file rather than its directory
(`'../validators/zod/index.js'`, not `'../validators/zod'`), and the `service` generator's
`dbImportPath` and `schemaImportPath` need their own `.js`.

## Config File Formats

DRZL accepts multiple config formats:

- TypeScript: `drzl.config.ts`
- ES Module: `drzl.config.mjs`
- CommonJS: `drzl.config.js`
- JSON: `drzl.config.json`

When using JSON, ensure it’s strict JSON (no comments/trailing commas). TS/JS configs can export either a default object or use `defineConfig(...)`.

See package READMEs for generator‑specific options.
