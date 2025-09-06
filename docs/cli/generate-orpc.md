# Generate (oRPC)

Quickly generate oRPC routers without a config.

Usage:

::: code-group

```bash [pnpm]
pnpm dlx drzl generate:orpc <schema> -o src/api --template standard --includeRelations
```

```bash [npm]
npx drzl generate:orpc <schema> -o src/api --template standard --includeRelations
```

```bash [yarn]
yarn dlx drzl generate:orpc <schema> -o src/api --template standard --includeRelations
```

```bash [bun]
bunx drzl generate:orpc <schema> -o src/api --template standard --includeRelations
```

:::

Options:

- `-o, --outDir <dir>` (default `src/api`)
- `--template <name>` (default `standard`) — can be `standard` or a custom path
- `--includeRelations` — include relation endpoints
