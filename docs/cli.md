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

Every command shares the same output rules, the same `--json` contract and the same three exit
codes: see [Output & exit codes](/cli/output).

Jump to commands:

- Init: set up a starter config → [/cli/init](/cli/init)
- Analyze: inspect a schema → [/cli/analyze](/cli/analyze)
- Explain: what DRZL understood about one table → [/cli/explain](/cli/explain)
- Doctor: what DRZL cannot type or enforce → [/cli/doctor](/cli/doctor)
- Generate: run configured generators, or one of them with `--only` → [/cli/generate](/cli/generate)
- Generate (oRPC): deprecated, see `generate --only orpc` → [/cli/generate-orpc](/cli/generate-orpc)
- Watch: watch schema and regenerate → [/cli/watch](/cli/watch)
- Output: streams, colour, `--json`, exit codes → [/cli/output](/cli/output)

Something failed? [Troubleshooting](/guide/troubleshooting) is keyed by the message the CLI printed.

## Every command

- `--json`: write one JSON document to stdout and nothing else
- `-q, --quiet`: drop the progress narration on stderr; errors still print
- stdout carries the answer, stderr carries the narration
- colour is off on a stream that is not a terminal, and off entirely under `NO_COLOR`
- `0` did the work, `1` could not do the work, `2` did the work and found something

All four are documented in [Output & exit codes](/cli/output).

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
- `--out <file>`: write JSON to file, as a bare `Analysis` with no envelope
- `--json` (default false): print one JSON document to stdout (overrides `--out`)

Exits `1` when the schema could not be read at all, and `2` when it was read and `issues` holds an
error-level entry. See [Exit codes](/cli/output#exit-codes).

### explain

Show what DRZL understood about one table: the type it resolved for every column, the facts the
generators read off it, the constraints it will enforce, and the ones it read and could not use.

::: code-group

```bash [pnpm]
pnpm dlx @drzl/cli explain <table> [--json] [-s src/db/schema.ts] [-c drzl.config.ts]
```

```bash [npm]
npx @drzl/cli explain <table> [--json] [-s src/db/schema.ts] [-c drzl.config.ts]
```

```bash [yarn]
yarn dlx @drzl/cli explain <table> [--json] [-s src/db/schema.ts] [-c drzl.config.ts]
```

```bash [bun]
bunx @drzl/cli explain <table> [--json] [-s src/db/schema.ts] [-c drzl.config.ts]
```

:::

Options:

- `[table]`: the table, by database name, qualified name or export name. Omit it for the index.
- `-s, --schema <path>`: the schema to read, overriding the config
- `-c, --config <path>`: which config to read the schema path from
- `--json`, `-q, --quiet`

Writes nothing. Exits `0` when the table was explained, `1` when the name reaches no table or more
than one, or when there is no schema to read.

See [Explain](/cli/explain).

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
- `-q, --quiet`: drop the narration on stderr; the report still prints

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
- `-s, --schema <path>`: path to the schema, overriding the config
- `--only <kinds>`: run only these generator kinds, comma separated
- `--check`: regenerate and report drift, with a diff, without writing anything
- `--dry-run`: report what would be written, and write nothing
- `--json`, `-q, --quiet`

Behavior:

- Analyzes your schema
- Runs each generator in `generators[]`, printing a file summary per kind on stdout
- Says how many files it created, changed and left alone, and names the ones that are not the same
  as before
- Warnings, the spinner and the progress bar go to stderr, so `drzl generate > files.txt` holds
  only the paths that were written

`--only` takes the kinds a config uses, read from the same list the config parser is built from, so
an unknown one is refused by name rather than matching nothing. With `--schema` and no config file
present, a minimal config is built in memory, which is how one generator runs with no config at
all:

```bash
npx @drzl/cli generate --schema src/db/schema.ts --only orpc
```

See [Generate](/cli/generate).

### generate:orpc

**Deprecated, and removed in 5.0.** Use
`drzl generate --schema <schema> --only orpc`, which does the same thing and can reach every config
feature this command cannot.

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
- `--json`, `-q, --quiet`

Exits `1` when the schema is missing or cannot be imported. It used to exit `0` after writing a
placeholder file that read "No tables detected in analysis".

### generate:trpc

**Deprecated, and removed in 5.0.** Use
`drzl generate --schema <schema> --only trpc`, which does the same thing and can reach every config
feature this command cannot.

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
- `--json`, `-q, --quiet`

Exits `1` when the schema is missing or cannot be imported.

See [Generate (tRPC)](/cli/generate-trpc).

### watch

Watch schema (and template paths) and regenerate on changes.

Usage:

::: code-group

```bash [pnpm]
pnpm dlx @drzl/cli watch -c drzl.config.ts [--only zod] --debounce 200 [--json]
```

```bash [npm]
npx @drzl/cli watch -c drzl.config.ts [--only zod] --debounce 200 [--json]
```

```bash [yarn]
yarn dlx @drzl/cli watch -c drzl.config.ts [--only zod] --debounce 200 [--json]
```

```bash [bun]
bunx @drzl/cli watch -c drzl.config.ts [--only zod] --debounce 200 [--json]
```

:::

Options:

- `-c, --config <path>`
- `--only <kinds>`: rebuild only these generator kinds, comma separated
- `--pipeline <name>`: `all | analyze | generate-<kind>` (default `all`), the older spelling of
  `--only`
- `--debounce <ms>`: wait this long after the last change before rebuilding (default `200`)
- `--clear`: clear the terminal before each rebuild, off by default
- `--json`: emit structured JSON logs on stdout, one object per line
- `-q, --quiet`: drop the narration; errors still print
- `--poll`: force polling, which helps on WSL, Docker and network mounts

A watch has no answer to give, so everything human it prints goes to stderr. Exits `1` when there
is no config, when the schema path cannot be resolved, or when `--only` or `--pipeline` names
something that is not a generator kind.

`--pipeline` reaches all fourteen kinds now. It listed seven, and the other seven matched nothing
at all, so `drzl watch --pipeline generate-zod` ran and regenerated nothing. See
[Watch](/cli/watch).

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

Options:

- `-y, --yes`: take the defaults and ask nothing
- `--schema <path>`, `--generators <list>`
- `--json` (implies `--yes`), `-q, --quiet`

---

See also:

- Output, `--json` and exit codes: [/cli/output](/cli/output)
- Config reference: [/guide/configuration](/guide/configuration)
- Generators:
  - [/generators/orpc](/generators/orpc)
  - [/generators/trpc](/generators/trpc)
  - [/generators/hono](/generators/hono)
  - [/generators/service](/generators/service)
  - [/generators/zod](/generators/zod)
  - [/generators/valibot](/generators/valibot)
  - [/generators/arktype](/generators/arktype)
  - [/generators/typebox](/generators/typebox)
  - [/generators/effect](/generators/effect)
  - [/generators/json-schema](/generators/json-schema)
