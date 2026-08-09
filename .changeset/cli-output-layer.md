---
'@drzl/cli': minor
---

One output layer for the whole CLI: streams, colour, `--json`, `--quiet` and exit codes (plan
items 72, 73, 74, 76, 77).

**`NO_COLOR` is honoured.** It was not, at all: `chalk@6.0.0` vendors a `supports-color` that
contains the string `NO_COLOR` zero times, so `drzl doctor` emitted the same 32 escape sequences
with the variable set as without it. Colour is now decided in one place from `NO_COLOR`,
`FORCE_COLOR`, `TERM` and whether the specific stream is a terminal. `NO_COLOR` wins over
`FORCE_COLOR`, which is not what chalk does and is deliberate: `NO_COLOR` is what a person puts in
a shell profile, `FORCE_COLOR` is what a wrapper injects.

**Colour is decided per stream.** chalk's default instance takes its level from stdout alone, so
`drzl generate > out.txt` with a terminal still on stderr turned the warnings on that terminal
colourless. Each stream now gets its own answer.

**No escape sequence reaches a pipe.** `ora`'s success symbol came from `log-symbols`, which
colours through `yoctocolors` and never asks whether the stream is a terminal, so on any machine
with `TERM` set `drzl analyze 2> log` wrote `\x1b[32m✔\x1b[39m` into the file. The symbol and the
spinner frame are rendered through the shared decision now.

**stdout is the answer, stderr is the narration.** The sponsor tip was written with `console.log`,
putting 246 bytes of advertisement into the file list a script was parsing; it is on stderr now,
and is shown only where an aside has a reader. `init` and `watch` print nothing to stdout at all,
because what they produce is a file on disk and a running process.

**`--json` and `-q, --quiet` on every command**, not three and none. `--json` writes exactly one
JSON document to stdout and nothing anywhere else, on success and on failure alike, so
`drzl <cmd> --json | jq .` parses with no filtering. Every document carries `command` and
`exitCode`; failures carry `ok`, `code` and `message`. `analyze` and `doctor` keep their published
payloads with the envelope merged in at the top level, so existing readers of `.issues` and
`.findings` are unaffected. `--quiet` drops narration and never drops an error or changes an exit
code.

**Three exit codes, documented in one place** (`docs/cli/output.md`): `0` did the work, `1` could
not do the work, `2` did the work and found something. Four codes moved:

- `generate` with no config was `2`, now `1`.
- `generate --check` with drift was `1`, now `2`.
- `watch` with no config or an unresolvable schema was `2`, now `1`.
- `analyze` on a missing or unimportable schema was `2`, now `1`; an error-level issue in a schema
  it did read stays `2`.

And a command stopped reporting success when it had failed: `generate:orpc` and `generate:trpc`
given a schema that does not exist exited `0` after writing a placeholder file reading "No tables
detected in analysis". They exit `1` and write nothing.

**The progress bar only appears when it can say something.** It was drawn for a single table,
painting one frame at `0%` before being wiped. Measured: the generator loop costs about 105ms fixed
plus 3.6ms per table and `cli-progress` redraws at 10fps, so it is now drawn only at a terminal,
only without `--quiet` or `--json`, and only from 25 tables up, which is where the loop first
outlasts a frame. It is also started per generator rather than once for the run, which fixes a
config with two generators drawing nothing for the second.
