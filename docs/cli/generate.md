# Generate

Run configured generators from `drzl.config.*`.

Usage:

::: code-group

```bash [pnpm]
pnpm drzl generate -c drzl.config.ts
```

```bash [npm]
npx drzl generate -c drzl.config.ts
```

```bash [yarn]
yarn drzl generate -c drzl.config.ts
```

```bash [bun]
bunx drzl generate -c drzl.config.ts
```

:::

Behavior:

- Analyzes your schema then runs each generator in `generators[]`
- Prints a file summary per generator kind

See also: [Guide → Configuration](/guide/configuration)
