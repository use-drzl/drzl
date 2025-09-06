# Init

Scaffold a minimal `drzl.config.ts` in the current directory.

Usage:

::: code-group

```bash [pnpm]
pnpm dlx drzl init
```

```bash [npm]
npx drzl init
```

```bash [yarn]
yarn dlx drzl init
```

```bash [bun]
bunx drzl init
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
