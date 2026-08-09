# Output, exit codes and `--json`

Every command in the `drzl` CLI answers these questions the same way: which stream a line goes
to, whether it carries colour, what `--quiet` and `--json` do to it, and what the exit code means.

## Streams: stdout is the answer, stderr is the narration

**stdout** carries what you asked for and nothing else:

| Command                        | On stdout                                              |
| ------------------------------ | ------------------------------------------------------ |
| `analyze`                      | the analysis, as JSON                                  |
| `doctor`                       | the report, as prose or as JSON                        |
| `generate`                     | the list of files written, one per line                |
| `generate:orpc`, `generate:trpc` | the list of files written                            |
| `init`                         | nothing (what it produces is a file on disk)           |
| `watch`                        | nothing, unless `--json`, which puts the event stream there |
| any command with `--json`      | exactly one JSON document                              |

**stderr** carries everything else: the spinner, the progress bar, warnings, the "Generated
(zod): 3 files" summary, errors, and the sponsor tip.

This is what makes redirection work:

```bash
drzl analyze src/db/schema.ts > analysis.json   # the file holds JSON and nothing else
drzl generate --json | jq '.generators[].files' # parses with no filtering
drzl generate > files.txt 2> build.log          # the two are separated
```

## Colour: decided once, per stream

Colour is decided for each stream separately, because `drzl generate > out.txt` leaves stderr a
terminal and stdout a file, and the right answer differs between them.

In order:

1. `NO_COLOR` set to anything but the empty string: **no colour**, on either stream.
2. `TERM=dumb`: **no colour**.
3. `FORCE_COLOR`: colour on. `0` or `false` means off; `1`, `2` and `3` name a level; `true` or an
   empty value means on at level 1.
4. Otherwise: colour when that stream is a terminal, at the level `COLORTERM` and `TERM` describe,
   and no colour when it is not.

`NO_COLOR` wins over `FORCE_COLOR`. That is deliberate, and it is not what chalk does. `NO_COLOR`
is the one a person puts in their shell profile; `FORCE_COLOR` is overwhelmingly injected by a
wrapper, and CI runners set it routinely. A wrapper's guess should not overrule a refusal.

No escape sequence ever reaches a stream that is not a terminal unless `FORCE_COLOR` asked for it.
That includes the spinner's tick, the progress bar, and the report `doctor` prints.

## The progress bar

`drzl generate` draws a progress bar only when all of these hold:

- stderr is a terminal
- neither `--quiet` nor `--json` was passed
- the schema has at least 25 tables

The last one is measured rather than chosen. The generator loop the bar covers costs about 105ms
fixed plus 3.6ms per table, and the bar redraws ten times a second, so below about 25 tables it
paints a single frame reading `0%` and is then wiped without ever advancing. A bar is only drawn
where it will move.

Below that, the run is already described by the lines around it: the analysis time, and the file
count per generator.

## `--quiet`

Every command takes `-q, --quiet`. It removes the narration on stderr: the spinner, the progress
bar, warnings, the per-generator summary and the sponsor tip.

It does not remove:

- **errors**, which still go to stderr, because a script that cannot tell a success from a
  swallowed failure is worse off than one with no `--quiet` at all
- **the exit code**, which means exactly what it means without the flag
- **the answer** on stdout for the commands whose answer is text: `analyze` still prints the
  analysis, `doctor` still prints the report

For `generate`, `generate:orpc`, `generate:trpc` and `init`, what the command produces is files on
disk, so all of their text is a report about the work, and `--quiet` leaves them silent on success.

```bash
drzl generate --quiet          # prints nothing, exits 0
drzl generate --quiet          # prints the error to stderr, exits 1, when the config is missing
```

`generate --check --quiet` still names the files that drifted. That list is the finding the check
exists to produce, and an exit code of `2` with no list is an answer nobody can act on.

## `--json`

Every command takes `--json`. It writes **exactly one JSON document to stdout** and nothing else,
on success and on failure alike, so this always works:

```bash
drzl generate --json | jq .
```

Nothing goes to stderr under `--json`: the warnings that would have been printed are in the
document instead.

### The envelope

Every document carries:

| Key        | Meaning                                                            |
| ---------- | ------------------------------------------------------------------ |
| `command`  | the command that produced it, for example `generate` or `doctor`   |
| `exitCode` | the code the process is about to return, so you read one field     |

A **failure** document carries three more, and no payload. It is emitted when the command could
not produce its payload at all:

```json
{
  "ok": false,
  "command": "generate",
  "code": "DRZL_CFG_001",
  "message": "No config found (DRZL_CFG_001). Create drzl.config.ts or pass --config.",
  "exitCode": 1
}
```

`code` is a stable identifier. `message` is the same sentence the human run prints.

### One name, two meanings, and why

`ok` is **not** part of the envelope, and that is because `doctor` published an `ok` of its own
before this contract existed, meaning "there is nothing to report about your schema". That is a
statement about the schema, not about the run: a report full of findings is a perfectly successful
`doctor`. Rather than redefine a published field or carry two spellings of one word, `ok` keeps its
meaning where it already had one, appears on failure documents where nothing can collide with it,
and `exitCode` is the field to read for how the run went.

### `analyze --json`

The `Analysis`, with the envelope merged in at the top level, so `.dialect`, `.tables`, `.enums`,
`.relations` and `.issues` are exactly where they have always been.

```json
{ "command": "analyze", "exitCode": 0, "dialect": "postgres", "tables": [], "issues": [] }
```

`--out <file>` still writes the bare `Analysis`, with no envelope: that option names a file of
analysis, not a command result.

A schema that is missing or will not import is the one failure `analyze` reports through its normal
document rather than through a failure envelope, because it still has one to give: the analysis
comes back empty with the reason in `issues`, which says more than a one-line message would. The
`exitCode` is `1` either way.

### `doctor --json`

The `DoctorReport`, with the envelope merged in at the top level. See
[Doctor](/cli/doctor#json) for the report's own shape.

```json
{ "command": "doctor", "exitCode": 0, "schema": "src/db/schema.ts", "ok": false, "findings": [] }
```

### `generate --json`

```json
{
  "ok": true,
  "command": "generate",
  "exitCode": 0,
  "check": null,
  "generators": [{ "kind": "zod", "files": ["/abs/path/users.zod.ts"] }],
  "warnings": ["1 column could not be typed: ..."]
}
```

- `generators` is one entry per configured generator, in config order, each with the absolute
  paths it wrote.
- `warnings` holds every warning the human run prints to stderr, as strings.
- `check` is `null` unless `--check` was passed, and otherwise:

```json
{
  "check": {
    "upToDate": false,
    "drift": [{ "file": "src/validators/zod/users.zod.ts", "status": "changed" }]
  }
}
```

`status` is `added`, `removed` or `changed`. Paths are relative to the working directory.

### `generate:orpc --json`, `generate:trpc --json`

```json
{
  "ok": true,
  "command": "generate:orpc",
  "exitCode": 0,
  "generators": [{ "kind": "orpc", "files": ["/abs/path/users.ts"] }]
}
```

### `init --json`

`--json` implies `--yes`: a prompt written into a document is a question nobody answers and a
document nobody can parse.

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

`schemaSource` is `convention`, `drizzle-kit` or `none`. `schema` is `null` when the config was
written without one.

### `watch --json`

The one command whose `--json` is a stream rather than a document, because a watch never finishes.
One JSON object per line on stdout, each with an `event` key: `watching`, `trigger`,
`watch_config_applied`, `analyze_complete`, `generate_complete`, `diff`, `error`.

## Exit codes

Three codes, and only three.

| Code | Meaning                                                  |
| ---- | -------------------------------------------------------- |
| `0`  | The command did what it was asked.                       |
| `1`  | DRZL could not do the work.                              |
| `2`  | DRZL did the work, and found what it was asked to find.  |

The distinction between `1` and `2` is the one a pipeline acts on differently: a build stops on the
first and shows a diff or a report on the second.

| Command                          | `0`                       | `1`                                                        | `2`                             |
| -------------------------------- | ------------------------- | ---------------------------------------------------------- | ------------------------------- |
| `analyze`                        | analysed                  | schema missing or could not be imported                    | analysed, with error-level issues |
| `doctor`                         | reported                  | schema missing or could not be imported                    | findings **and** `--strict`     |
| `generate`                       | generated                 | no config, invalid config, a generator threw               | `--check` found drift           |
| `generate:orpc`, `generate:trpc` | generated                 | schema missing, could not be imported, or a generator threw | not used                        |
| `init`                           | config written            | a config already exists, or it could not be written        | not used                        |
| `watch`                          | (runs until interrupted)  | no config, or the schema path could not be resolved        | not used                        |
| any command                      |                           | an unknown flag or a missing argument                      |                                 |

In CI:

```yaml
- run: npx @drzl/cli generate --check # 2 means commit the regenerated files
- run: npx @drzl/cli doctor --strict # 2 means the schema has findings
```

### What changed

Codes moved, all in the same direction: towards `1` meaning "could not run".

- `generate` with no config was `2`, and is now `1`. A config that is not there is not a finding.
- `generate --check` with drift was `1`, and is now `2`. The check ran perfectly and is reporting
  what it found. A job that only tests for a non-zero exit is unaffected.
- `watch` with no config, or with an unresolvable schema, was `2` and is now `1`.
- `analyze` on a schema that is missing or will not import was `2`, and is now `1`. An error-level
  issue in a schema it *did* read is still `2`.

And two commands stopped reporting success when they had failed:

- `generate:orpc <missing-schema>` and `generate:trpc <missing-schema>` exited `0`, having written
  a placeholder file whose contents read "No tables detected in analysis". They now exit `1` and
  write nothing.

`doctor`'s codes are unchanged: `0` when it read the schema, `1` when it could not, `2` with
`--strict` and findings.
