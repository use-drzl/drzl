# CLI Overview

The `drzl` CLI analyzes Drizzle schemas and runs generators.

Quick help:

::: code-group

```bash [pnpm]
pnpm dlx @drzl/cli --help
```

```bash [npm]
npx @drzl/cli --help
```

```bash [yarn]
yarn dlx @drzl/cli --help
```

```bash [bun]
bunx @drzl/cli --help
```

:::

Jump to commands:

- Init: set up a starter config → [/cli/init](/cli/init)
- Analyze: inspect a schema → [/cli/analyze](/cli/analyze)
- Doctor: what DRZL cannot type or enforce → [/cli/doctor](/cli/doctor)
- Generate: run configured generators → [/cli/generate](/cli/generate)
- Generate (oRPC): quick oRPC without config → [/cli/generate-orpc](/cli/generate-orpc)
- Watch: watch schema and regenerate → [/cli/watch](/cli/watch)

## Commands & Options

### analyze

Analyze a Drizzle schema (TypeScript) and output a normalized Analysis.

Usage (by package manager):

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
- `--json` (default false): print JSON to stdout (overrides `--out`)

Exits non‑zero when errors are found in `issues`.

### doctor

Report what DRZL cannot type or enforce in your schema, and why. Not `analyze`: that prints the
whole `Analysis` and leaves you to spot the trouble in it, this prints only what will silently not
work.

::: code-group

```bash [pnpm]
pnpm dlx @drzl/cli doctor [schema] [--json] [--strict] [-c drzl.config.ts]
```

```bash [npm]
npx @drzl/cli doctor [schema] [--json] [--strict] [-c drzl.config.ts]
```

```bash [yarn]
yarn dlx @drzl/cli doctor [schema] [--json] [--strict] [-c drzl.config.ts]
```

```bash [bun]
bunx @drzl/cli doctor [schema] [--json] [--strict] [-c drzl.config.ts]
```

:::

Options:

- `[schema]`: path to the schema. Read from `drzl.config.*` when omitted.
- `-c, --config <path>`: which config to read the schema path from
- `--json`: print the report as JSON instead of prose
- `--strict`: exit `2` when anything is reported

Exits `0` by default even with findings, because a schema carrying a `customType` is normal and
usable. Exits `1` only when the schema could not be read at all.

See [Doctor](/cli/doctor).

### generate

Run configured generators from `drzl.config.*`.

Usage:

::: code-group

```bash [pnpm]
pnpm dlx @drzl/cli generate -c drzl.config.ts
```

```bash [npm]
npx @drzl/cli generate -c drzl.config.ts
```

```bash [yarn]
yarn dlx @drzl/cli generate -c drzl.config.ts
```

```bash [bun]
bunx @drzl/cli generate -c drzl.config.ts
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

### generate:trpc

Quickly generate tRPC v11 routers without a config.

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
- `--template <name>` (default `standard`): `standard` or `service`
- `--includeRelations`: include a lookup per single-column foreign key
- `--servicesDir <dir>` (default `src/services`): only consulted by `--template service`

See [Generate (tRPC)](/cli/generate-trpc).

### watch

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
- `--pipeline <name>`: `all | analyze | generate-orpc` (default `all`)
- `--debounce <ms>`: debounce milliseconds (default `200`)
- `--json`: emit structured JSON logs

### init

Scaffold a minimal `drzl.config.ts` in the current directory.

::: code-group

```bash [pnpm]
pnpm dlx @drzl/cli init
```

```bash [npm]
npx @drzl/cli init
```

```bash [yarn]
yarn dlx @drzl/cli init
```

```bash [bun]
bunx @drzl/cli init
```

:::

---

See also:

- Config reference: [/guide/configuration](/guide/configuration)
- Generators:
  - [/generators/orpc](/generators/orpc)
  - [/generators/trpc](/generators/trpc)
  - [/generators/service](/generators/service)
  - [/generators/zod](/generators/zod)
  - [/generators/valibot](/generators/valibot)
  - [/generators/arktype](/generators/arktype)
  - [/generators/typebox](/generators/typebox)
  - [/generators/json-schema](/generators/json-schema)
