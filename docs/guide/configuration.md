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

`generators` has a default, and it is worth knowing which one: a config that omits the key entirely
gets `[{ kind: 'orpc' }]` and writes an oRPC router tree. That surprises anyone who came for
validation schemas and wrote the smallest config that parses, so a run using the default says so and
lists the choices. Name the key and the warning goes away, even if you name the same value.

Two things are deliberately _not_ written twice here.

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

## Reading the schema path from drizzle-kit

A drizzle-kit project already names its schema once, in `drizzle.config.ts`. Naming it a second
time in `drzl.config.ts` is the same fact in two files, and the copies drift. So `schema` is
optional: when it is omitted, DRZL reads the schema path out of your drizzle-kit config instead.

```ts
// drizzle.config.ts, exactly as drizzle-kit already has it
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/*.ts',
  out: './drizzle',
});
```

```ts
// drzl.config.ts: no schema key at all
export default {
  outDir: 'src/api',
  generators: [{ kind: 'zod', path: 'src/validators/zod' }],
};
```

`drzl generate` announces the file it read (`Schema from drizzle.config.ts (3 files)`), so the
fallback is never silent. The lookup tries `drizzle.config.ts`, then `drizzle.config.js`, then
`drizzle.config.json`, which are the same candidates in the same order drizzle-kit's own CLI
uses. Kit's whole `schema` surface is honoured: a single path, an array, glob patterns, and a
directory (expanded one level, exactly as kit expands it). A multi-file schema needs no barrel;
the analyzer reads every file as one schema.

The `drizzleKit` key pins the behavior down when the default is not what you want:

- `drizzleKit: './config/drizzle.config.mjs'` reads that file, wherever it is, like kit's own
  `--config` flag. This is also how a `.mjs`/`.cjs` config is reached, since kit itself does not
  look for those names.
- `drizzleKit: true` insists on the fallback: a missing drizzle-kit config becomes an error
  instead of a quieter one about `schema`.
- `drizzleKit: false` disables it: omitting `schema` is then an error even beside a
  `drizzle.config.ts`.

Precedence is one rule: **`schema` wins**. If both `schema` and a truthy `drizzleKit` are set,
the drizzle-kit config is not read and DRZL warns, because two sources for one fact is how the
copies drift. If neither yields a schema, the error names both files and both fixes.

Only two things are read from the drizzle-kit config: `schema`, and `dialect`, which is
cross-checked against what the analyzer measures. When they contradict (the config says
`mysql`, the columns are Postgres), generation follows the schema and a warning names the
config, since a stale dialect line usually means the config points somewhere it should not.
Credentials, migrations settings and everything else in that file are for drizzle-kit alone
and are ignored.

`drzl watch` treats the drizzle-kit config as part of the config surface: the directories its
`schema` entries name are watched (including glob bases, so a newly created file that matches
the pattern triggers a rebuild), and editing `drizzle.config.ts` itself re-resolves the schema
on the next rebuild.

One option depends on how many files the kit config resolves to. `typedJson` and
`typedColumns` work by importing the schema module back and referencing
`typeof table.$inferSelect`, which needs a single module: when the kit `schema` resolves to
exactly one file they work unchanged, and when it resolves to several there is no one module
to import, so columns keep their wide types and the generator says so. Point `schema` (or the
kit config) at a barrel if you want typed columns over a multi-file schema.

## Router generators share `outDir`

`orpc`, `trpc`, `hono`, `express`, `fastify`, `nestjs`, `graphql`, `mcp`, `next`, `ai`,
`tanstack-start` and `h3` all write to the
top-level `outDir` by default, and every one of them writes an `index.ts` there, so a config
that runs more than one needs a `path` on all but one of them:

```ts
generators: [
  { kind: 'orpc' },                          // -> outDir
  { kind: 'trpc', path: 'src/trpc' },        // -> its own directory
  { kind: 'hono', path: 'src/hono' },        // -> its own directory
  { kind: 'express', path: 'src/routes' },   // -> its own directory
  { kind: 'fastify', path: 'src/fastify' },  // -> its own directory
  { kind: 'nestjs', path: 'src/dto' },       // -> its own directory
  { kind: 'graphql', path: 'src/graphql' },  // -> its own directory
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

### Tables in a Postgres schema

Postgres puts every table in a schema, and `pgSchema('reporting').table('users', ...)` gives you a
second table called `users`. A pattern therefore matches on two names, and you pick which one you
mean:

```ts
import { pgTable, pgSchema, integer, text } from 'drizzle-orm/pg-core';

export const reporting = pgSchema('reporting');

export const users = pgTable('users', {
  id: integer('id').primaryKey(),
  email: text('email').notNull(),
});

export const reportingUsers = reporting.table('users', {
  id: integer('id').primaryKey(),
  label: text('label').notNull(),
});
```

```ts
export default defineConfig({
  schema: 'src/db/schema.ts',
  // Every schema's `users`, which is what a bare name has always meant.
  exclude: ['users'],
  // Just the one in `reporting`.
  // exclude: ['reporting.users'],
  // The whole `reporting` schema.
  // exclude: ['reporting.*'],
  // Just the default schema's, which is what `pgTable` declares.
  // exclude: ['public.users'],
  generators: [{ kind: 'orpc' }],
});
```

- **A bare pattern matches in every schema.** `exclude: ['users']` written before `reporting`
  existed means "the users tables", and quietly narrowing it to one of them would start generating
  an endpoint the config had already turned off. When a bare pattern really does reach two schemas,
  DRZL says so on stderr and names the qualified spellings, because that is nearly always a pattern
  written before the second schema existed.
- **`public.` is how you name the default schema.** Drizzle refuses `pgSchema('public')` outright,
  with "Postgres is using public schema by default", so a table declared with plain `pgTable` is the
  only spelling of a table in `public` and `public.users` is how a config addresses it.
- **`*` works on either side of the dot**, so `reporting.*` is a whole schema and `*.users` is every
  `users` there is.

Everything else follows the schema too. Emitted file names and exported schema names come from the
Drizzle **export** name, which is unique per module, so `users` and `reportingUsers` never collided
and still do not. The OpenAPI document gives a qualified table its own path, `/reporting/users`,
while a table in the default schema keeps the bare `/users` it has always had. Relations, including
the foreign keys behind nested schemas, follow the key into its own schema rather than into a
same-named table in another one.

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
applications is the primary entity you _do_ want generated.

## Choosing which columns to generate for

`include` and `exclude` are all or nothing per table, and the column you do not want in a generated
schema is usually sitting in a table you _do_ want: a `passwordHash` on `users`, an internal note
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
name, anchored, with `*` as the only metacharacter, and the schema-qualified name too. Column
patterns are that language again, so `omit: ['*At']` drops `createdAt` and `updatedAt` and
`omit: ['bio']` does not also drop `bios`.

```ts
columns: {
  // Only the users table in the default schema.
  'public.users': { omit: ['passwordHash'] },
  // Every table in the reporting schema.
  'reporting.*': { omit: ['internal_note'] },
},
```

A bare key reaches every schema, exactly as `include` and `exclude` do, and DRZL warns when one
really does. That warning is worth reading here in particular: a column pattern only has to match
in **one** of the tables its entry matched, so `columns: { users: { pick: ['id', 'email'] } }`
against two same-named tables narrows both and the one without an `email` silently loses every
column but `id`, with no typo to report.

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

The schema stops _describing_ the column. Whether a value carrying it survives a `parse` is then the
validator's own policy about undeclared keys, and they do not agree. Measured:

| Generator       | A row carrying the omitted column                                            |
| --------------- | ---------------------------------------------------------------------------- |
| zod 4.4.3       | key stripped from the parsed result                                          |
| valibot 1.4.2   | key stripped                                                                 |
| TypeBox 0.34.52 | `Value.Parse` and `Value.Clean` strip it; `Value.Check` alone returns `true` |
| Effect 3.22.1   | key stripped by `decodeUnknownSync`                                          |
| arktype 2.2.3   | key left in place                                                            |
| json-schema     | `additionalProperties: false`, so a validator rejects the payload            |

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

That is a real hazard and also the normal multi-tenant shape: an insert schema describes a _request
body_, not a row, and the server fills in the rest. Refusing it would remove one of the two things
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
export const InsertUserProfilesSchema = z.object({/* ... */});
export const UpdateUserProfilesSchema = z.object({/* ... */});
export const SelectUserProfilesSchema = z.object({/* ... */});

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
  Vite, esbuild, Rollup, Bun and Vitest, which map it back to the `.ts` source.
- `'none'` gives `./users.zod`. What DRZL emitted before 2.0. Use it if your bundler cannot
  map `.js` back to `.ts`: **Next.js**, webpack without `resolve.extensionAlias`, or Jest with
  `ts-jest` and no `moduleNameMapper`. It does not resolve under `node16`/`nodenext` in an ES
  module.
- `'ts'` gives `./users.zod.ts`. Needs `"allowImportingTsExtensions": true`, and
  `"rewriteRelativeImportExtensions": true` if you also emit. It is the only form Node's own
  type stripping accepts, so it is what a project running the generated `.ts` unbuilt wants.

Next.js is called out because it is the one that surprises people. Measured on 16.3.0,
`next build` fails with `Can't resolve './users.zod.js'` under Turbopack, which is the default
bundler, and under `--webpack` as well. Webpack can be taught with
`experimental.extensionAlias`; Turbopack has no equivalent, so nothing in `next.config.ts`
fixes it and the specifier has to change instead. See the
[Next.js example](/examples/nextjs-server-actions), which sets `'none'` for exactly this reason.

`importExtension` only touches specifiers DRZL invents. Paths you write yourself are emitted
verbatim, so under `node16`/`nodenext` in an ES module, spell them the same way: an `orpc`
generator's `validation.importPath` has to name the barrel file rather than its directory
(`'../validators/zod/index.js'`, not `'../validators/zod'`), and the `service` generator's
`dbImportPath` and `schemaImportPath` need their own `.js`.

## Config File Formats

DRZL looks for these filenames, in this order, and loads the first one that exists:

- TypeScript: `drzl.config.ts`
- ES Module: `drzl.config.mjs`
- CommonJS: `drzl.config.js` and `drzl.config.cjs`
- JSON: `drzl.config.json`

`-c/--config` names a file directly and skips the search.

Every form is parsed by the same schema and produces the same errors. When using JSON, ensure
it's strict JSON (no comments/trailing commas).

## Editor completion

### TypeScript configs

Wrap the object in `defineConfig` and your editor completes every key, every enum value and every
generator option:

```ts
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: 'src/db/schema.ts',
  generators: [{ kind: 'orpc' }],
});
```

`defineConfig` is the identity function: it returns what you pass it and exists only to attach the
type. If you would rather not import a value, the annotation alone does the same job, which is
what [`drzl init`](/cli/init) scaffolds:

```ts
import type { DrzlConfigInput } from '@drzl/cli/config';

export default {
  schema: 'src/db/schema.ts',
  generators: [{ kind: 'zod', path: 'src/validators/zod' }],
} satisfies DrzlConfigInput;
```

A type-only import is erased before the config runs, so this form also works when DRZL is not a
local dependency, such as under `npx`.

### JSON configs

`drzl.config.json` gets the same completion from a JSON Schema, generated from the same zod schema
the CLI validates with and shipped inside the package. Point at it with a `$schema` key:

```json
{
  "$schema": "./node_modules/@drzl/cli/dist/drzl.config.schema.json",
  "schema": "src/db/schema.ts",
  "generators": [{ "kind": "orpc" }]
}
```

DRZL ignores `$schema`, so the key is safe to leave in. The relative path resolves offline and
always matches the version you installed. The same schema is published at
`https://use-drzl.github.io/drzl/drzl.config.schema.json` if you would rather point at a URL.

To avoid touching the config file, map it in VS Code's `.vscode/settings.json` instead:

```json
{
  "json.schemas": [
    {
      "fileMatch": ["drzl.config.json"],
      "url": "./node_modules/@drzl/cli/dist/drzl.config.schema.json"
    }
  ]
}
```

### What the JSON Schema does not catch

The schema is generated from the zod schema, and `z.toJSONSchema` drops refinements without
reporting them. DRZL's one refinement holds the affix rules, so:

- **Illegal affix characters are caught.** The rule is re-encoded as a `pattern`, and a test fuzzes
  it against the CLI's own check over every printable ASCII position to keep the two identical.
- **Affix collisions are not caught.** Two modes whose prefix and suffix resolve to the same
  identifier is a comparison between sibling values, which JSON Schema cannot express.
  `drzl generate` still refuses, naming the two modes and the identifier they collide on.

Unknown top-level keys are accepted by the schema because the CLI accepts them too: it ignores what
it does not recognise rather than failing, though it now says so first. Keys inside `columns` and
`affix` are strict in both.

## When the config does not load

### A validation error names the key

A config that does not parse is reported one problem per line, each naming the key it is about the
way you would write it in the file:

```
drzl.config.ts is not valid (DRZL_CFG_002). 3 problems:
  - outDir: expected string, received number (found 123)
  - generators[0].nestedDepth: expected number, received string (found "deep")
  - columns.users: unrecognized key "ommit". Did you mean "omit"?
```

Array entries are indexed, so `generators[1].validation.library` says which generator, and a key
that is not an identifier is quoted, so a table pattern reads as `columns["app_*"].omit`. The
value that was found is shown when it fits on the line. Eight problems are listed and the rest are
counted.

The exit code is `1` and nothing is written. Under `--json` the same sentence is the `message` of
the [failure document](/cli/output#the-envelope), with `"code": "DRZL_CFG_002"`.

### An unknown key is a warning

Most of the config is permissive: an unrecognised key is dropped rather than refused, so a config
carrying one still runs. Each one is now named on stderr before the run continues:

```
drzl config: unknown key "outDirr" at the top level; it is ignored. Did you mean "outDir"?
drzl config: unknown key "typedJsn" in generators[0]; it is ignored. Did you mean "typedJson"?
drzl config: unknown key "librari" in generators[0].validation; it is ignored. Did you mean "library"?
```

A suggestion appears when the key is a typo of a real one rather than a different word. The run
still exits `0`, because the setting was dropped and the rest of the config was honoured, which is
what happened before this warning existed as well. `--quiet` drops the warnings; `--json` puts them
in the document's `warnings` array.

Nothing is warned about where a key is legitimately your own: the keys of `columns` are table
patterns, the keys of `templateOptions` belong to whichever template reads them, and `$schema` is
declared for editors. Where the config is strict instead, `columns`, `affix`, and the object forms
of `meta`, `constraints`, `branded` and `document`, an unknown key is a validation error rather
than a warning, and gets the key path and the suggestion above.

See package READMEs for generator‑specific options.
