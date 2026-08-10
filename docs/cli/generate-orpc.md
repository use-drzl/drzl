# Generate (oRPC)

::: warning Deprecated, and removed in 5.0
Use [`drzl generate`](/cli/generate) instead:

```bash
drzl generate --schema src/db/schema.ts --only orpc
```

That emits the same files, byte for byte, and it can reach everything this command cannot: table
and column filters, naming, formatting, `importExtension`, shared validation schemas, database
injection, a schema path read from your drizzle-kit config, and, because it goes through the write
plan, `--check`, `--dry-run` and per-file drift verdicts.

This command keeps working until 5.0 and prints one line on stderr naming the replacement. The line
goes through the output layer, so `--quiet` and `--json` both drop it.

The split it comes from was chronological rather than principled: `generate:orpc` shipped when oRPC
was the only generator, `generate:trpc` arrived with the tRPC generator, and the twelve generators
added since added no command at all. `--only` names all fourteen.
:::

Quickly generate oRPC routers without a config.

Usage:

::: code-group

```bash [pnpm]
pnpm dlx @drzl/cli generate:orpc <schema> -o src/api --template standard --includeRelations
```

```bash [npm]
npx @drzl/cli generate:orpc <schema> -o src/api --template standard --includeRelations
```

```bash [yarn]
yarn dlx @drzl/cli generate:orpc <schema> -o src/api --template standard --includeRelations
```

```bash [bun]
bunx @drzl/cli generate:orpc <schema> -o src/api --template standard --includeRelations
```

:::

Options:

- `-o, --outDir <dir>` (default `src/api`)
- `--template <name>` (default `standard`): can be `standard` or a custom path
- `--includeRelations`: include relation endpoints
- `--json`: one JSON document on stdout
- `-q, --quiet`: silent on success, errors still on stderr

## Exit codes

`0` when it generated, and `1` when the schema is missing or could not be imported. It used to exit
`0` for a schema that was never read, having written a `placeholder.orpc.ts` whose contents read
"No tables detected in analysis": the command reported success and a CI step guarding the generated
tree passed. See [Output & exit codes](/cli/output#exit-codes).

## `--json`

```json
{
  "ok": true,
  "command": "generate:orpc",
  "exitCode": 0,
  "generators": [{ "kind": "orpc", "files": ["/abs/path/users.ts"] }]
}
```

