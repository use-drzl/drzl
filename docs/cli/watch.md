# Watch

Watch schema (and template paths) and regenerate on changes.

A schema resolved from your drizzle-kit config is watched the same way a `schema` path is: the
directories its entries name (glob bases included, so a new file matching the pattern counts)
and `drizzle.config.*` itself, whose edits re-resolve the schema on the next rebuild. See
[Reading the schema path from drizzle-kit](/guide/configuration#reading-the-schema-path-from-drizzle-kit).

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
- `--pipeline <name>`: `all | analyze | generate-orpc | generate-trpc | generate-hono | generate-express | generate-fastify | generate-nestjs | generate-graphql` (default `all`)
  Anything other than `all` or `analyze` runs exactly one generator kind and skips the rest.
- `--debounce <ms>`: debounce milliseconds (default `200`)
- `--json`: emit structured JSON logs on stdout, one object per line
- `-q, --quiet`: drop the narration; errors still print
- `--poll`: force polling, which helps on WSL, Docker and network mounts

## Streams

A watch never finishes, so it has no answer to give: everything human it prints goes to stderr, and
stdout carries only the `--json` event stream. Each line is one object with an `event` key, one of
`watching`, `trigger`, `watch_config_applied`, `analyze_complete`, `generate_complete`, `diff` or
`error`.

```bash
drzl watch --json | jq -r 'select(.event == "generate_complete") | .kind'
```

Exits `1` when there is no config, or when the schema path cannot be resolved at startup. It was
`2` before. See [Output & exit codes](/cli/output).
