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
- `--out <file>`: write JSON to file, as a bare `Analysis` with no envelope
- `--json`: print one JSON document to stdout (overrides `--out`)
- `-q, --quiet`: drop the spinner on stderr; the analysis and any error still print

## Streams

The analysis goes to stdout and the spinner goes to stderr, so `drzl analyze src/db/schema.ts >
analysis.json` writes a file holding JSON and nothing else. See
[Output & exit codes](/cli/output).

## `--json`

The `Analysis`, with `command` and `exitCode` merged in at the top level, so `.dialect`, `.tables`
and `.issues` are where they have always been:

```json
{ "command": "analyze", "exitCode": 0, "dialect": "postgres", "tables": [], "issues": [] }
```

A failure is a document too, never prose on stdout:

```json
{ "ok": false, "command": "analyze", "code": "DRZL_CLI_ANALYZE", "message": "...", "exitCode": 1 }
```

## Exit codes

| Code | When                                                                            |
| ---- | ------------------------------------------------------------------------------- |
| `0`  | The schema was analysed and nothing in `issues` is an error.                    |
| `1`  | The schema is missing, or importing it threw. There is no analysis to print.    |
| `2`  | The schema was analysed and `issues` holds an error-level entry.                |

`1` and `2` were both `2` before. They are different events: the first means the document you
asked for is not there, the second means it is there and something in it needs looking at.
