# Init

Scaffold a `drzl.config.ts` in the current directory. `init` finds your schema, asks what you want
generated, and writes a config that runs.

Usage:

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

## Options

| Flag                  | What it does                                                     |
| --------------------- | ---------------------------------------------------------------- |
| `-y, --yes`           | Ask nothing. Take the detected schema and the default generator. |
| `--schema <path>`     | Write this path into the config, skipping detection.             |
| `--generators <list>` | Comma-separated: `zod`, `valibot`, `arktype`, `typebox`, `orpc`. |

Every prompt has a flag, and every flag skips its prompt. Nothing `init` asks can only be answered
by a human, which is what keeps it usable from a script.

## It only asks when someone is there to answer

Prompts appear when **stdin and stdout are both terminals** and `CI` is unset. Otherwise `init`
writes the config straight out, with the same result `--yes` gives. That covers `npx` one-liners,
CI jobs, agents, and any invocation whose output is being piped somewhere.

Pressing `Ctrl+D` at a prompt, or closing stdin, stops the questions and takes the defaults for
whatever is left. `init` never waits for input it cannot get.

## Finding the schema

`init` does not guess a path and hope. It looks in two places, in order, and **validates a
candidate by importing it and counting Drizzle tables** rather than by checking that a file exists.

1. **Your drizzle-kit config.** If `drizzle.config.ts` (or `.js`, or `.json`) is there, DRZL reads
   its `schema` entry, expanding globs and directories the way drizzle-kit does. When that resolves
   to files with tables in them, the scaffolded config states **no** `schema` at all: DRZL reads it
   from drizzle-kit at generate time, so the path stays written in exactly one place. See
   [reading the schema path from drizzle-kit](/guide/configuration#reading-the-schema-path-from-drizzle-kit).
2. **Conventional locations**, `src/db/schema.ts` first, then the same shape under `src/lib/db`,
   `app/db`, `lib/db`, `db`, `drizzle` and the project root, each as a file or an `index.ts` inside
   a `schema/` or `schemas/` directory.

A candidate that imports cleanly and declares no tables is **skipped**, and the walk continues. A
`schema.ts` that exports a connection string is worse than no detection: the config it produces
analyzes nothing, and `drzl generate` then reports success over an empty schema. A candidate that
cannot be imported at all, usually because dependencies are not installed yet, is used with a
warning rather than skipped.

If nothing is found, `init` still writes the config, with `schema` left out and commented:

```ts
export default {
  // Set this to your Drizzle schema file, for example 'src/db/schema.ts'. DRZL
  // found no drizzle-kit config and no schema declaring tables in the usual
  // locations, and will not name a file that is not there.
  // schema: 'src/db/schema.ts',
  ...
}
```

It will not write a `schema` naming a file that is not on disk.

## What it scaffolds

The default is **Zod validators**. Every generator `@drzl/cli` depends on is installed by
definition alongside the CLI that scaffolded the config, and that is all fourteen of them; the five
in the list are the ones whose config entry `init` knows how to write. The other nine work exactly
as well, and you add their entry by hand from the page documenting each.

```ts
import type { DrzlConfigInput } from '@drzl/cli/config';

export default {
  schema: 'src/db/schema.ts',
  analyzer: { includeRelations: true, validateConstraints: true },
  generators: [
    // Other kinds this CLI already has installed: 'valibot', 'arktype', 'typebox', 'orpc'.
    { kind: 'zod', path: 'src/validators/zod' },
  ],
} satisfies DrzlConfigInput;
```

Choosing `orpc` adds an `outDir` and scaffolds the router instead:

```ts
import type { DrzlConfigInput } from '@drzl/cli/config';

export default {
  schema: 'src/db/schema.ts',
  outDir: 'src/api',
  analyzer: { includeRelations: true, validateConstraints: true },
  generators: [
    // A second router generator needs its own "path"; they share "outDir".
    { kind: 'orpc', template: 'standard', includeRelations: true },
  ],
} satisfies DrzlConfigInput;
```

The annotation is a **type-only import plus `satisfies`**, never `defineConfig`. A type import is
erased before the config is ever executed, so the scaffold still runs under `npx` in a project with
no local `@drzl/cli` to resolve, while an editor still gets full completion. See
[TypeScript configs](/guide/configuration#typescript-configs).

## An existing config is never overwritten

If a config is already there, `init` writes nothing, names the file, and exits 1. Delete it or edit
it by hand.

All five config names are checked, not just `drzl.config.ts`. DRZL loads them in a fixed order with
`.ts` first, so writing a `.ts` scaffold beside a `drzl.config.json` would leave that file
untouched and still replace it in practice: the next `drzl generate` would run the scaffold. `init`
refuses rather than shadowing.

## Output and exit codes

What `init` produces is a file on disk, so everything it prints is a report about that and goes to
stderr. `-q, --quiet` silences it; errors still print.

`--json` writes one document to stdout and implies `--yes`, since a prompt written into a document
is a question nobody answers:

```json
{
  "ok": true,
  "command": "init",
  "exitCode": 0,
  "written": "/abs/path/drzl.config.ts",
  "schema": "src/db/schema.ts",
  "schemaSource": "convention",
  "generators": ["zod"]
}
```

`schemaSource` is `convention`, `drizzle-kit` or `none`, and `schema` is `null` when the config was
written without one. Exits `0` when a config was written and `1` when it was not. See
[Output & exit codes](/cli/output).
