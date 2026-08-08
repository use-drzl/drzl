# Watch

Watch schema (and template paths) and regenerate on changes.

Usage:

::: code-group

```bash [pnpm]
pnpm dlx @drzl/cli watch -c drzl.config.ts --pipeline all --debounce 200 [--json]
```

```bash [npm]
npx @drzl/cli watch -c drzl.config.ts --pipeline all --debounce 200 [--json]
```

```bash [yarn]
yarn dlx @drzl/cli watch -c drzl.config.ts --pipeline all --debounce 200 [--json]
```

```bash [bun]
bunx @drzl/cli watch -c drzl.config.ts --pipeline all --debounce 200 [--json]
```

:::

Options:

- `-c, --config <path>`
- `--pipeline <name>`: `all | analyze | generate-orpc | generate-trpc | generate-hono | generate-express | generate-fastify | generate-nestjs` (default `all`)
  Anything other than `all` or `analyze` runs exactly one generator kind and skips the rest.
- `--debounce <ms>`: debounce milliseconds (default `200`)
- `--json`: emit structured JSON logs
