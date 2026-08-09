# Watch

Watch schema (and template paths) and regenerate on changes.

A schema resolved from your drizzle-kit config is watched the same way a `schema` path is: the
directories its entries name (glob bases included, so a new file matching the pattern counts)
and `drizzle.config.*` itself, whose edits re-resolve the schema on the next rebuild. See
[Reading the schema path from drizzle-kit](/guide/configuration#reading-the-schema-path-from-drizzle-kit).

Usage:

::: code-group

```bash [pnpm]
pnpm dlx @drzl/cli watch -c drzl.config.ts --pipeline all --debounce 200 [--clear] [--json]
```

```bash [npm]
npx @drzl/cli watch -c drzl.config.ts --pipeline all --debounce 200 [--clear] [--json]
```

```bash [yarn]
yarn dlx @drzl/cli watch -c drzl.config.ts --pipeline all --debounce 200 [--clear] [--json]
```

```bash [bun]
bunx @drzl/cli watch -c drzl.config.ts --pipeline all --debounce 200 [--clear] [--json]
```

:::

Options:

- `-c, --config <path>`
- `--pipeline <name>`: `all | analyze | generate-orpc | generate-trpc | generate-hono | generate-express | generate-fastify | generate-nestjs | generate-graphql` (default `all`)
  Anything other than `all` or `analyze` runs exactly one generator kind and skips the rest.
- `--debounce <ms>`: wait this long after the last change before rebuilding (default `200`)
- `--clear`: clear the terminal before each rebuild, off by default
- `--json`: emit structured JSON logs on stdout, one object per line
- `-q, --quiet`: drop the narration; errors still print
- `--poll`: force polling, which helps on WSL, Docker and network mounts

## One rebuild at a time

A save that lands while a rebuild is running does not start a second one. It is remembered, and one
more rebuild follows when the current one finishes, however many saves arrived meanwhile.

This is what the debounce alone could not do. `--debounce` collapses changes arriving close
together and then starts a rebuild that takes as long as it takes; every change arriving during
_that_ used to start another one on top of it, writing the same output directory. Measured on a
600-table schema where one rebuild takes about 1.4s, six saves 700ms apart produced six rebuilds
with four running at once. Now the same burst produces at most one rebuild in flight, and no save
is dropped.

`--debounce` itself stays at 200ms, which is measured rather than chosen. With the write-settling
this watcher asks chokidar for, one editor save reaches it as a single event, and the widest gap
inside one burst was 9ms, from a tool rewriting two files back to back. Without that settling the
same bursts spread out to at most 121ms, from format-on-save. 200ms covers the widest of them and
is short enough that a save still feels immediate.

`--debounce 0` is allowed and means "rebuild on the next tick". A value that is not a number is
now refused with a warning instead of being silently replaced by 200.

## Clearing the screen

`--clear` wipes the terminal before each rebuild, so the screen holds only the current run. It is
**off by default**, because a watcher left running all day should not throw away the previous
rebuild's errors without being asked, and it does nothing at all when stderr is not a terminal, so
`drzl watch 2> build.log` never puts an escape sequence in the log.

Before 4.23 the screen was cleared on every rebuild with no way to stop it, and the decision was
made from stdout rather than from the stream the output is on, so `drzl watch > events.json` at a
terminal cleared nothing.

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

## A broken schema does not stop the watcher

The three states that make `drzl generate` exit `1` are reported here and then waited out: a schema
module that will not load (`DRZL_SCHEMA_001`), one that declares no tables (`DRZL_SCHEMA_002`), and
a config whose filters remove all of them (`DRZL_SCHEMA_003`). See
[Generate](/cli/generate#when-there-is-nothing-to-generate-from) for what each one says.

This is deliberate, and it is the one place those three are not fatal. A watcher exists to be
running while the schema is being edited, and all three are ordinary intermediate states: a file
saved mid-expression does not parse, a file being written from scratch declares no tables yet, and
a table filter is usually adjusted with the watcher up. Exiting would mean restarting the watcher
to recover from a typo. So the run says what is wrong, writes nothing, and rebuilds on the next
save, exactly as it already did for a generator that threw.

Under `--json` each one is an `error` event carrying the code:

```json
{
  "event": "error",
  "code": "DRZL_SCHEMA_002",
  "message": "No Drizzle tables found in src/db/schema.ts (DRZL_SCHEMA_002)."
}
```

`--pipeline analyze` is the exception to the second one: it reports an analysis rather than
generating, and an analysis of a schema with no tables is a true answer, so it completes normally
just as `drzl analyze` does.
