# Router Adapters

Router adapters are implemented as templates with a small hook interface. The generator calls these hooks to produce files, names, imports, and procedure code.

Generic template interface (example):

```ts
interface RouterTemplateHooks<Table = any> {
  filePath(
    table: Table,
    ctx: {
      outDir: string;
      naming?: { routerSuffix?: string; procedureCase?: 'camel' | 'kebab' | 'snake' };
    }
  ): string;
  routerName(
    table: Table,
    ctx: { naming?: { routerSuffix?: string; procedureCase?: 'camel' | 'kebab' | 'snake' } }
  ): string;
  procedures(
    table: Table,
    ctx?: { databaseInjection?: { enabled?: boolean; databaseType?: string } }
  ): Array<{ name: string; varName: string; code: string }>;
  imports?(
    tables: Table[],
    ctx?: {
      outDir: string;
      naming?: { routerSuffix?: string; procedureCase?: 'camel' | 'kebab' | 'snake' };
      servicesDir?: string;
      databaseInjection?: { enabled?: boolean; databaseType?: string };
    }
  ): string;
  prelude?(
    tables: Table[],
    ctx?: {
      outDir: string;
      naming?: { routerSuffix?: string; procedureCase?: 'camel' | 'kebab' | 'snake' };
    }
  ): string;
  header?(table: Table): string;
}
```

- `filePath`: absolute path for a table’s router file
- `routerName`: the exported constant name
- `procedures`: an array of procedures; each item provides an exported key (`name`), a variable identifier (`varName`), and the implementation `code`
- `imports`: additional imports at file top. The context carries the output directory, the naming
  options, the services directory when one is configured, and the database-injection settings
- `prelude`: helper code after imports, with the output directory and naming options
- `header`: banner/comment string at top

Example custom template: see [/templates/custom](/templates/custom)

Notes:

- Validation libraries can be reused/injected by the generator (Zod/Valibot/ArkType)
- Output typing is attached by the generator when possible
- Adapters can map to oRPC, tRPC, Express handlers, etc., by changing the `procedures` implementation
