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
  };
}
```

## Validation reuse

When `validation.useShared` is true, the generator imports `Insert<Table>Schema`, `Update<Table>Schema`, and `Select<Table>Schema` from your `validation.importPath` and wires them into handlers (inputs and outputs) based on the selected `library`.

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

## Example

```ts
// drzl.config.ts
export default defineConfig({
  schema: 'src/db/schemas/index.ts',
  outDir: 'src/api',
  generators: [
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
