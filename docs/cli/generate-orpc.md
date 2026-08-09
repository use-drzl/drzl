# Generate (oRPC)

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

