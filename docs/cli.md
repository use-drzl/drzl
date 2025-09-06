# CLI Overview

The `drzl` CLI analyzes Drizzle schemas and runs generators.

Quick help:

::: code-group

```bash [pnpm]
pnpm dlx drzl --help
```

```bash [npm]
npx drzl --help
```

```bash [yarn]
yarn dlx drzl --help
```

```bash [bun]
bunx drzl --help
```

:::

Jump to commands:

- Init: set up a starter config → [/cli/init](/cli/init)
- Analyze: inspect a schema → [/cli/analyze](/cli/analyze)
- Generate: run configured generators → [/cli/generate](/cli/generate)
- Generate (oRPC): quick oRPC without config → [/cli/generate-orpc](/cli/generate-orpc)
- Watch: watch schema and regenerate → [/cli/watch](/cli/watch)

## Commands & Options

### analyze

Analyze a Drizzle schema (TypeScript) and output a normalized Analysis.

Usage (by package manager):

::: code-group

```bash [pnpm]
pnpm dlx drzl analyze <schema> [--relations] [--validate] [--out FILE] [--json]
```

```bash [npm]
npx drzl analyze <schema> [--relations] [--validate] [--out FILE] [--json]
```

```bash [yarn]
yarn dlx drzl analyze <schema> [--relations] [--validate] [--out FILE] [--json]
```

```bash [bun]
bunx drzl analyze <schema> [--relations] [--validate] [--out FILE] [--json]
```

:::

Options:

- `--relations` (default true): include relation inference
- `--validate` (default true): validate constraints
- `--out <file>`: write JSON to file
- `--json` (default false): print JSON to stdout (overrides `--out`)

Exits non‑zero when errors are found in `issues`.

### generate

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

Options:

- `-c, --config <path>`: path to config file

Behavior:

- Analyzes your schema
- Runs each generator in `generators[]`, printing a file summary per kind

### generate:orpc

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

### watch

Watch schema (and template paths) and regenerate on changes.

Usage:

::: code-group

```bash [pnpm]
pnpm drzl watch -c drzl.config.ts --pipeline all --debounce 200 [--json]
```

```bash [npm]
npx drzl watch -c drzl.config.ts --pipeline all --debounce 200 [--json]
```

```bash [yarn]
yarn drzl watch -c drzl.config.ts --pipeline all --debounce 200 [--json]
```

```bash [bun]
bunx drzl watch -c drzl.config.ts --pipeline all --debounce 200 [--json]
```

:::

Options:

- `-c, --config <path>`
- `--pipeline <name>`: `all | analyze | generate-orpc` (default `all`)
- `--debounce <ms>`: debounce milliseconds (default `200`)
- `--json`: emit structured JSON logs

### init

Scaffold a minimal `drzl.config.ts` in the current directory.

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

---

See also:

- Config reference: [/guide/configuration](/guide/configuration)
- Generators:
  - [/generators/orpc](/generators/orpc)
  - [/generators/service](/generators/service)
  - [/generators/zod](/generators/zod)
  - [/generators/valibot](/generators/valibot)
  - [/generators/arktype](/generators/arktype)
