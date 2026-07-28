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

## Naming generated identifiers

By default the validation generators name their exports `Insert<Table>Schema`,
`Update<Table>Schema` and `Select<Table>Schema`, plus `Insert<Table>Input`,
`Update<Table>Input` and `Select<Table>Output` for the type aliases. `<Table>` is the export
name from your Drizzle schema, used exactly as written, so `export const users = ...` gives
`InsertusersSchema`.

The `affix` option on a `zod`, `valibot` or `arktype` generator changes all of that. Leaving
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
  (`users.zod.ts`), so the barrel and any `importPath` keep resolving.
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
    // InsertUsersSchema and not InsertusersSchema.
    validation: { useShared: true, library: 'zod', importPath: '../validators/zod' },
  },
],
```

Set `validation.affix` explicitly only when the schemas come from somewhere DRZL does not
generate. If you set it and it disagrees with the sibling generator, `drzl generate` stops
with an error naming both sets of identifiers rather than writing a router that cannot
compile.

## Config File Formats

DRZL accepts multiple config formats:

- TypeScript: `drzl.config.ts`
- ES Module: `drzl.config.mjs`
- CommonJS: `drzl.config.js`
- JSON: `drzl.config.json`

When using JSON, ensure it’s strict JSON (no comments/trailing commas). TS/JS configs can export either a default object or use `defineConfig(...)`.

See package READMEs for generator‑specific options.
