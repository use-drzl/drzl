# Init

Scaffold a minimal `drzl.config.ts` in the current directory.

Usage:

::: code-group

```bash [pnpm]
pnpm dlx @drzl/cli init
```

```bash [npm]
npx @drzl/cli init
```

```bash [yarn]
yarn dlx @drzl/cli init
```

```bash [bun]
bunx @drzl/cli init
```

:::

Output example:

```ts
export default {
  schema: 'src/db/schema.ts',
  outDir: 'src/api',
  analyzer: { includeRelations: true, validateConstraints: true },
  generators: [{ kind: 'orpc', template: 'standard', includeRelations: true }],
} as const;
```
