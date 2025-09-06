# Custom Templates

You can provide a custom oRPC template by passing a module path to `template`.

```ts
export default defineConfig({
  generators: [
    {
      kind: 'orpc',
      template: './src/templates/my-orpc-template.ts',
      naming: { routerSuffix: 'Router', procedureCase: 'camel' },
    },
  ],
});
```

Your template should export `ORPCTemplateHooks`:

```ts
import type { ORPCTemplateHooks } from '@drzl/generator-orpc';

const template: ORPCTemplateHooks = {
  filePath: (table, ctx) => `${ctx.outDir}/${table.tsName}.ts`,
  routerName: (table) => `${table.tsName}Router`,
  imports: () => `import { os } from '@orpc/server'`,
  prelude: () => `// helpers`,
  header: (table) => `// Router for table: ${table.name}`,
  procedures: (table) => [
    {
      name: 'list',
      varName: `list${table.tsName}`,
      code: `const list${table.tsName} = os.handler(async () => [])`,
    },
  ],
};

export default template;
```

See also: [Template Hooks API](/generators/orpc#template-hooks-api)
