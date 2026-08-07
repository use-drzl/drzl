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
      // The same module `schema` above names, so the emitted services import the tables
      // themselves. Point it at the directory or at the file; either resolves.
      schemaImportPath: 'src/db/schemas',
    },
    {
      kind: 'orpc',
      template: '@drzl/template-orpc-service',
      includeRelations: true,
      naming: { routerSuffix: 'Router', procedureCase: 'kebab' },
      validation: { library: 'valibot' },
      databaseInjection: {
        enabled: true,
        databaseType: "import('drizzle-orm/node-postgres').NodePgDatabase",
      },
    },
  ],
});
```

Two things are deliberately *not* written twice here.

`servicesDir` is derived from the `service` generator's `path`, so naming it on the router as well
is how the two drift apart.

`databaseInjection` is declared on the router generator alone and pushed onto the `service`
generator for you, because it describes a contract between the two: the router emits
`Service.getById(ctx.db, id)`, and only a service generated in the same mode has a `db` parameter to
receive it. It needs `dataAccess: 'drizzle'` on the service generator, because that generator's stub
bodies take no database parameter whatever they are told; `drzl generate` warns if you pair it with
`stub`.

### Naming the database type

`databaseType` is emitted verbatim, so an inline `import(...)` type as above needs no import
statement and cannot resolve to the wrong file. The two-key form is available when you would rather
name it once:

```ts
databaseInjection: {
  enabled: true,
  databaseType: 'Database',
  // Resolved by *your* compiler from the emitted file, so it is relative to the output
  // directory, not to the project root. A bare `src/db/db` is a package specifier to both
  // Node and tsc, and resolves to nothing.
  databaseTypeImport: { name: 'Database', from: '../db/client.js' },
},
```

## Router generators share `outDir`

Both `orpc` and `trpc` write to the top-level `outDir` by default, and both write an `index.ts`
there, so a config that runs both needs a `path` on at least one of them:

```ts
generators: [
  { kind: 'orpc' },                    // -> outDir
  { kind: 'trpc', path: 'src/trpc' },  // -> its own directory
],
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

## Choosing which columns to generate for

`include` and `exclude` are all or nothing per table, and the column you do not want in a generated
schema is usually sitting in a table you *do* want: a `passwordHash` on `users`, an internal note
beside the public fields, a `tenantId` your server sets from the session. `columns` narrows a table
without dropping it:

```ts
columns: {
  users: { omit: ['passwordHash'] },
  // Table keys are patterns too, so one entry reaches every table that has the column.
  'app_*': { omit: ['deleted_at'] },
  // Or say what to keep instead.
  audit_log: { pick: ['id', 'action', 'created_at'] },
},
```

The key is a **table** pattern in the same language `include`/`exclude` uses: the database table
name, anchored, with `*` as the only metacharacter. Column patterns are that language again, so
`omit: ['*At']` drops `createdAt` and `updatedAt` and `omit: ['bio']` does not also drop `bios`.

Every matching entry applies, in the order it is written. Within one entry `pick` runs first and
`omit` then removes, so `omit` wins where both name the same column. That is the same precedence
`exclude` already has over `include` one level up, for the same reason: the direction that takes
something away is the safe one for the thing this option exists to remove.

### A name that matches nothing is an error

```
drzl config: the "columns" option cannot be honoured.
  - columns["users"].omit names "passwrodHash", which matches no column of users.
    Available: id, email, passwordHash, bio.
```

`omit: ['passwrodHash']` treated as a no-op would leave the column exactly where it was while
reading like a fix, and nothing downstream could tell that apart from a column that was never there.
So a table pattern matching no table and a column pattern matching no column both stop the run,
before anything is written, with every such problem in one message. A column pattern has to match in
at least one of the tables its entry matched, not in all of them, which is what makes a wildcard
table key usable.

### It applies to every mode and every generator

`columns` narrows the analysis once, before any generator runs, so the insert, update and select
schemas, the OpenAPI document, the emitted metadata and the service layer all describe the same
columns. There is deliberately no per-mode form: a column cannot be kept in `select` and dropped
from `insert`. Half the output could not honour it if there were. The service generator's
`Update<Table>` is `Partial<Omit<typeof users.$inferInsert, 'id'>>`, taken from Drizzle's own types
rather than from the analysis, so a per-mode narrowing would be invisible there, and an option whose
effect disappears in half the generated tree is worse than one that is not offered.

### What it does not do

The schema stops *describing* the column. Whether a value carrying it survives a `parse` is then the
validator's own policy about undeclared keys, and they do not agree. Measured:

| Generator | A row carrying the omitted column |
| --- | --- |
| zod 4.4.3 | key stripped from the parsed result |
| valibot 1.4.2 | key stripped |
| TypeBox 0.34.52 | `Value.Parse` and `Value.Clean` strip it; `Value.Check` alone returns `true` |
| Effect 3.22.1 | key stripped by `decodeUnknownSync` |
| arktype 2.2.3 | key left in place |
| json-schema | `additionalProperties: false`, so a validator rejects the payload |

If you are relying on a parse to strip a secret rather than on never selecting it, check which of
those you are using.

### Two cases DRZL will not simply do

**Omitting a primary key column is refused.** The generated `getById`, `update` and `delete` address
rows by that key, and every generator reads it differently: the tRPC generator resolves it against
the columns and silently drops those three procedures, the oRPC generator keeps emitting them typed
`{ id: number }`, the service generator falls back to a column literally named `id`, and the OpenAPI
document drops its `/{id}` paths. One config, four outcomes, none of them announced. Use `exclude`
on the whole table instead.

**Omitting a NOT NULL column with no default is a warning**, and generation continues:

```
drzl config: the "columns" option drops "tenantId" from table "users", and the database
requires it: NOT NULL with no default. The emitted insert schema therefore describes a
payload that is not a complete row, so whatever calls db.insert has to supply "tenantId"
itself.
```

That is a real hazard and also the normal multi-tenant shape: an insert schema describes a *request
body*, not a row, and the server fills in the rest. Refusing it would remove one of the two things
this option is for. A CHECK constraint naming a column you omitted also warns, because nothing DRZL
emits can enforce it any more, though your database still does.

### A complete config

Against a schema declaring `users(id, email, nickname)` and `posts(id, slug, authorId)`:

```ts
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: 'src/db/schema.ts',
  columns: {
    users: { omit: ['nickname'] },
    posts: { pick: ['id', 'slug'] },
  },
  generators: [{ kind: 'zod', path: 'src/validators/zod' }],
});
```

`InsertusersSchema`, `UpdateusersSchema` and `SelectusersSchema` are emitted without `nickname`;
`posts` keeps its key and its `slug` and loses `authorId`, along with the foreign key over it, so
the relation lookup procedures the router generators would have derived from it are not emitted
either.

## Naming generated identifiers

By default the validation generators name their exports `Insert<Table>Schema`,
`Update<Table>Schema` and `Select<Table>Schema`, plus `Insert<Table>Input`,
`Update<Table>Input` and `Select<Table>Output` for the type aliases. `<Table>` is the export
name from your Drizzle schema, used exactly as written, so `export const users = ...` gives
`InsertusersSchema`.

The `affix` option on a `zod`, `valibot`, `arktype`, `typebox`, `effect` or `json-schema` generator changes all of
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

### Sharing names with a router generator

An `orpc` or `trpc` generator with `validation.useShared` imports those schemas by name, so both
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

A `zod`, `valibot`, `arktype`, `typebox`, `effect` or `json-schema` generator writes one file per
table, named after the Drizzle export name plus a suffix that defaults to `.zod.ts`,
`.valibot.ts`, `.arktype.ts`, `.typebox.ts`, `.effect.ts` or `.schema.ts`, and an `index.ts`
barrel that re-exports them.
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
