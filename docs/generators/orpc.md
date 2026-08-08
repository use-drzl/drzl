# oRPC Generator

Generates oRPC routers per table, with optional validation reuse (Zod, Valibot, ArkType).

## Options

```ts
interface GenerateOptions {
  outputDir: string;
  template?: 'standard' | 'minimal' | string;
  includeRelations?: boolean;
  naming?: { routerSuffix?: string; procedureCase?: 'camel' | 'kebab' | 'snake' };
  format?: { enabled?: boolean; engine?: 'auto' | 'prettier' | 'biome'; configPath?: string };
  templateOptions?: Record<string, unknown>;
  validation?: {
    useShared?: boolean;
    library?: 'zod' | 'valibot' | 'arktype';
    importPath?: string;
    schemaSuffix?: string;
    // How the validation generator named its exports. Normally inherited, see below.
    affix?: {
      tableCase?: 'preserve' | 'pascal';
      schema?: { prefix?: Affix; suffix?: Affix };
      type?: { prefix?: Affix; suffix?: Affix };
    };
  };
  databaseInjection?: {
    enabled?: boolean;
    databaseType?: string;
    databaseTypeImport?: { name: string; from: string };
  };
  servicesDir?: string;
}
```

## Database injection

When used with `@drzl/template-orpc-service`, the generator wires a `dbMiddleware` and passes `context.db` to your services. Configure the context type via `databaseInjection`.

```ts
validation: { library: 'valibot' },
databaseInjection: {
  enabled: true,
  databaseType: 'Database',
  // Resolved by *your* compiler from the emitted file, so it is relative to the output
  // directory, not to the project root. A bare `src/db/db` is a package specifier to both Node
  // and tsc, and resolves to nothing. `databaseType` alone also takes an inline
  // `import('...').T` type, which needs no import statement at all.
  databaseTypeImport: { name: 'Database', from: '../db/db.js' },
},
```

`servicesDir` is not set here: the CLI derives it from the `service` generator's `path`. Declare
`databaseInjection` on this generator only, too. It describes a contract between the router and the
services, so the CLI pushes it onto the `service` generator, which has to be in `dataAccess:
'drizzle'` mode to honour it.

In the generated router:

```ts
import type { Database } from 'src/db/db';

export const dbMiddleware = os.$context<{ db?: Database }>().middleware(/* ... */);
```

## Validation reuse

When `validation.useShared` is true, the generator imports `Insert<Table>Schema`, `Update<Table>Schema`, and `Select<Table>Schema` from your `validation.importPath` and wires them into handlers (inputs and outputs) based on the selected `library`.

### Renamed schemas

If the validation generator uses an [`affix`](/guide/configuration#naming-generated-identifiers), the router has to import the renamed identifiers. You do not configure it twice. When exactly one other generator in the config produces the library named in `validation.library`, the CLI copies that generator's `affix` onto this one:

```ts
generators: [
  { kind: 'zod', path: 'src/validators/zod', affix: { tableCase: 'pascal' } },
  {
    kind: 'orpc',
    validation: { useShared: true, library: 'zod', importPath: '../validators/zod' },
  },
],
```

```ts
// src/api/users.ts
import {
  InsertUsersSchema as InsertusersSchema,
  UpdateUsersSchema as UpdateusersSchema,
  SelectUsersSchema as SelectusersSchema,
} from '../validators/zod';
```

The local aliases stay `Insert<tsName>Schema` on purpose. They never leave the file, and keeping them fixed means an affix change never rewrites the router body.

Set `validation.affix` yourself only when the schemas come from somewhere DRZL does not generate. If you set it and it disagrees with the sibling generator, `drzl generate` fails with both sets of names in the error instead of emitting a router that cannot compile.

### Output typing

The generator attaches `.output(...)` to each procedure. For example (Zod):

```ts
// list
os.output(z.array(SelectusersSchema)).handler(...)
// get
os.output(SelectusersSchema.nullable()).handler(...)
// create/update
os.output(SelectusersSchema).handler(...)
// delete
os.output(z.boolean()).handler(...)
```

Valibot uses `v.array(...)` and `v.nullable(...)`; ArkType uses `SelectSchema.array()` and `SelectSchema.or('null')`.

## Key typing

The inputs of `get`, `update` and `delete` are built from the table's primary key, every column
of it, at its real type, in the configured validation library's spelling:

```ts
// integer key                       natural key
os.input(z.object({ id: z.number() }))          os.input(z.object({ isbn: z.string() }))
// composite key: every column, in key order
os.input(z.object({ orgId: z.number(), userId: z.string() }))
// update: the same key beside the patch
os.input(z.object({ isbn: z.string(), data: UpdatebooksSchema }))
```

Valibot spells the same shapes with `v.object(...)`, ArkType with `type({ isbn: 'string' })`, and
an enum key becomes its literals. This applies to every template, built in or custom: the
generator rewrites the template's `get`/`update`/`delete` inputs, so a template cannot reintroduce
a hardcoded key.

A table with **no primary key** cannot address one row, so it emits `list` and `create` only, and
no relation lookups that would take its key as input. `create` stays: inserting a row does not
require being able to address it afterwards. This matches `@drzl/generator-service`, which drops
`getById`/`update`/`delete` for the same tables, so nothing generated calls a method nothing
generated.

A key column DRZL cannot type (for example `bigint`, which has no JSON transport) becomes the
library's `unknown` in the input. The [service template](/templates/orpc-service) refuses to pass
that to the service's typed key parameter: those procedures throw with a note stating the reason,
instead of shipping a call that does not compile.

## Example

```ts
// drzl.config.ts
export default defineConfig({
  schema: 'src/db/schemas/index.ts',
  outDir: 'src/api',
  generators: [
    // `useShared` below imports these, and `template-orpc-service` imports the services, so
    // both have to be generated. A config naming them without producing them emits routers
    // that import modules nothing ever writes.
    { kind: 'zod', path: 'src/validators/zod', schemaSuffix: 'Schema' },
    { kind: 'service', path: 'src/services' },
    {
      kind: 'orpc',
      template: '@drzl/template-orpc-service',
      includeRelations: true,
      naming: { routerSuffix: 'Router', procedureCase: 'kebab' },
      validation: {
        useShared: true,
        library: 'zod',
        importPath: 'src/validators/zod',
        schemaSuffix: 'Schema',
      },
    },
  ],
});
```

Run:

```bash
drzl generate -c drzl.config.ts
```

Routers and an index barrel are generated at `outDir`.

## Template hooks API

Templates expose a small API used by the generator.

```ts
interface ORPCTemplateHooks {
  filePath(table, ctx): string;
  routerName(table, ctx): string;
  procedures(table): Array<{ name: string; varName: string; code: string }>;
  imports?(tables, ctx): string;
  prelude?(tables, ctx): string;
  header?(table): string;
}
```

- `filePath`: absolute output path for a table’s router
- `routerName`: exported const name of the router
- `procedures`: code snippets for each handler variable (`varName`) and exported key (`name`)
- `imports`: extra imports at file top
- `prelude`: code emitted after imports (utility helpers, etc.)
- `header`: a banner/comment string at the top of the file

See also: [oRPC + Service Template](/templates/orpc-service) and [Standard Template](/templates/standard)

## Generated Output License

- You own the generated output. DRZL grants you a worldwide, royalty‑free, irrevocable license to use, copy, modify, and distribute the generated files under your project’s license.
- A short header is added by default. Configure via `outputHeader` in `drzl.config.ts`:
  - `outputHeader.enabled = false` to disable
  - `outputHeader.text = '...'` to customize

::: tip Need something else?
If this generator doesn't cover what you need, DM me on X (https://x.com/omardulaimidev) and we can scope it together.
:::
