# Generate

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

- `-c, --config <path>`: path to the config
- `--check`: regenerate and report drift without changing the tree
- `--json`: one JSON document on stdout, described in [Output](/cli/output#generate-json)
- `-q, --quiet`: silent on success, errors still on stderr

Behavior:

- Analyzes your schema then runs each generator in `generators[]`
- Prints a file summary per generator kind on stdout
- Puts warnings, the spinner and the progress bar on stderr, so `drzl generate > files.txt` holds
  only the paths that were written
- Draws a progress bar only at a terminal, and only for a schema with enough tables that it will
  move; see [Output](/cli/output)

When the config has no `schema` key, the path is read from your drizzle-kit config
(`drizzle.config.ts`, then `.js`, then `.json`), and the run says so:
`Schema from drizzle.config.ts (3 files)`. See
[Reading the schema path from drizzle-kit](/guide/configuration#reading-the-schema-path-from-drizzle-kit).

## `--check`: fail CI when generated output is stale

```bash
npx @drzl/cli generate --check
```

Regenerates and compares the result against what is on disk. Exits `2` if anything differs and
`0` when everything is current, naming each file:

```
Generated output is out of date (2 file(s)):
  ~ changed  src/validators/zod/people.zod.ts
  + added    src/validators/zod/extra.zod.ts

Run `drzl generate` and commit the result. Nothing was written by this check.
```

It catches the two things that actually happen: someone edits a generated file by hand, and
someone changes the schema without regenerating. Both are review problems today and CI problems
with this.

**It never modifies your working tree.** The output directories are snapshotted before
regeneration and restored afterwards whether or not anything drifted, including deleting files
the run created. A failed check leaves the tree exactly as it found it.

`2` rather than `1`, because the check ran perfectly and is reporting what it found;
`1` is reserved for a run that could not happen, such as a config DRZL could not read. A job that
only tests for a non-zero exit is unaffected. See [Exit codes](/cli/output#exit-codes).

In GitHub Actions:

```yaml
- run: npx @drzl/cli generate --check
```

Or, for a machine reading the result:

```bash
npx @drzl/cli generate --check --json | jq -r '.check.drift[] | .status + " " + .file'
```

This check is only possible because DRZL writes files. Validators that derive schemas in memory
at import time have nothing on disk to compare, so they cannot offer it.

See also: [Guide → Configuration](/guide/configuration) ·
[Output & exit codes](/cli/output)
