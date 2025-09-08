# Analyze

Analyze a Drizzle schema (TypeScript) and output a normalized Analysis.

Usage:

::: code-group

```bash [pnpm]
pnpm dlx @drzl/cli analyze <schema> [--relations] [--validate] [--out FILE] [--json]
```

```bash [npm]
npx @drzl/cli analyze <schema> [--relations] [--validate] [--out FILE] [--json]
```

```bash [yarn]
yarn dlx @drzl/cli analyze <schema> [--relations] [--validate] [--out FILE] [--json]
```

```bash [bun]
bunx @drzl/cli analyze <schema> [--relations] [--validate] [--out FILE] [--json]
```

:::

Options:

- `--relations` (default true): include relation inference
- `--validate` (default true): validate constraints
- `--out <file>`: write JSON to file
- `--json`: print JSON to stdout (overrides `--out`)

Exits non‑zero when `issues` include any errors.
