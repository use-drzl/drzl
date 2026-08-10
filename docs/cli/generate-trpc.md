# Generate (tRPC)

::: warning Deprecated, and removed in 5.0
Use [`drzl generate`](/cli/generate) instead:

```bash
drzl generate --schema src/db/schema.ts --only trpc
```

That emits the same files and can reach everything this command cannot: table and column filters,
naming, formatting, `importExtension`, shared validation schemas, database injection, a schema path
read from your drizzle-kit config, and, because it goes through the write plan, `--check`,
`--dry-run` and per-file drift verdicts. `--template` and `--servicesDir` become the `template` key
on the generator entry and the `path` on your `service` generator.

This command keeps working until 5.0 and prints one line on stderr naming the replacement. The line
goes through the output layer, so `--quiet` and `--json` both drop it.
:::

Quickly generate tRPC v11 routers without a config.

Usage:

::: code-group

```bash [pnpm]
pnpm dlx @drzl/cli generate:trpc <schema> -o src/api --template standard --includeRelations
```

```bash [npm]
npx @drzl/cli generate:trpc <schema> -o src/api --template standard --includeRelations
```

```bash [yarn]
yarn dlx @drzl/cli generate:trpc <schema> -o src/api --template standard --includeRelations
```

```bash [bun]
bunx @drzl/cli generate:trpc <schema> -o src/api --template standard --includeRelations
```

:::

Options:

- `-o, --outDir <dir>` (default `src/api`)
- `--template <name>` (default `standard`): `standard` for stub handlers, `service` to delegate to
  the classes `@drzl/generator-service` writes
- `--includeRelations`: include a `listBy<Column>` query per single-column foreign key
- `--servicesDir <dir>` (default `src/services`): where the service generator writes. Only consulted
  by `--template service`.

This command takes no config file, so it cannot reuse generated validation schemas or wire up
database injection. For those, use [`drzl generate`](/cli/generate) with a `{ kind: 'trpc' }` entry.
See the [tRPC generator](/generators/trpc) for the full option set.

The generator ships as `@drzl/generator-trpc`, an optional dependency of the CLI. If it is not
installed, this command says so and names the package to install.

## What lands on disk

```
src/api/
  trpc.ts      the shared initTRPC instance, Context, router, publicProcedure
  users.ts     one router per table
  posts.ts
  index.ts     appRouter, and the AppRouter type your client is parameterised by
```

Serve it with any tRPC adapter:

```ts
import { createHTTPServer } from '@trpc/server/adapters/standalone';
import { appRouter } from './src/api/index.js';

createHTTPServer({ router: appRouter, createContext: () => ({}) }).listen(3000);
```

## Options, output and exit codes

- `-o, --outDir <dir>` (default `src/api`)
- `--template <name>` (default `standard`): `standard` or `service`
- `--includeRelations`, `--servicesDir <dir>`
- `--json`: one JSON document on stdout
- `-q, --quiet`: silent on success, errors still on stderr

`0` when it generated, and `1` when the schema is missing, could not be imported, or the generator
is not installed. It used to exit `0` for a schema that was never read.

```json
{
  "ok": true,
  "command": "generate:trpc",
  "exitCode": 0,
  "generators": [{ "kind": "trpc", "files": ["/abs/path/users.ts"] }]
}
```

See [Output & exit codes](/cli/output).
