---
'@drzl/cli': minor
'@drzl/validation-core': minor
'@drzl/generator-orpc': minor
'@drzl/generator-trpc': minor
'@drzl/generator-hono': minor
'@drzl/generator-express': minor
'@drzl/generator-fastify': minor
'@drzl/generator-nestjs': minor
'@drzl/generator-graphql': minor
'@drzl/generator-service': minor
'@drzl/generator-zod': minor
'@drzl/generator-valibot': minor
'@drzl/generator-arktype': minor
'@drzl/generator-typebox': minor
'@drzl/generator-effect': minor
'@drzl/generator-json-schema': minor
---

`generate` knows what it is about to write before it writes it (plan items 68, 80, 81, 75, 82)

**One mechanism, three features.** `--dry-run`, "say what changed rather than how many files", and
"a `--check` failure should show a diff" are the same question asked once per file: what content is
about to land here, and what is here now. So generators now hand their writes to a `fileSink`
instead of calling `node:fs/promises` themselves, and `generate` decides whether that sink writes.
Fourteen generator packages changed by exactly one line each, because the sink is shaped like the
`fs` namespace they already used, plus one option on their public type.

The tempting alternative was to leave the generators alone and patch `node:fs/promises` for the
duration of a run, and it was measured and rejected. Patching the CommonJS exports object is
visible through a later dynamic import, but a module namespace that already exists is a snapshot
and never changes: with `const ns = await import('node:fs/promises')` evaluated first,
`require('node:fs/promises').writeFile = spy` leaves `ns.writeFile` untouched, on Node 22.22. The
CLI links `chokidar`, which imports `node:fs/promises` at module scope, so a dry run built on that
would write real files whenever an unrelated dependency happened to import first.

**`drzl generate --dry-run` writes nothing at all** (item 68). Not "writes and puts it back":
no file, no directory, no formatter output. A dry run in a project that has never been generated
into leaves the directory byte-for-byte as it found it, asserted per entry and per byte rather than
by looking for generated files. It exits `0` whether or not anything would change, because a dry
run that computed its answer did what it was asked, and `2` is for a run that found what it was told
to look for; `--check` is the flag whose question is "is anything stale". stdout still carries one
absolute path per line, so `drzl generate --dry-run > files.txt` gives the list that _would_ be
written in the same shape as the list that was.

Because generators are separate packages that a user can install at a different version from the
CLI, the claim is also checked at runtime rather than only in a test. A run that promised to write
nothing and wrote something restores the tree, exits `1` with the new `DRZL_GEN_003`, and names the
generator to update.

**Every run says what it did to each file** (item 80): created, changed or unchanged, with the
counts and the names of the ones that are not the same as before.

```
✔ Generated (zod): 3 files (1 created, 1 changed, 1 unchanged)
  + zod/posts.zod.ts
  ~ zod/index.ts
```

A run that rewrote twelve identical files and one real change used to say `13 files`. Unchanged
files are counted rather than listed: the list is what changed. That report is narration, so it is
on stderr, `--quiet` drops it, and **stdout is unchanged**, still one absolute path per line.
`--json` gains a `changes` array per generator beside the existing `files`, and a `dryRun` flag.

**`--check` prints a unified diff under each drifted file** (item 81), `a/` being what is on disk
and `b/` what the schema produces, so it reads like `git diff` and applies like a patch. "Changed"
alone cannot tell a regenerated header from somebody's hand-edit to a generated file, and those two
want opposite responses. Diffs are capped at the first 20 files, at 4000 lines and at 1500 line
edits, and every cap states itself in the output; every drifted file is still named in the list
above the diffs, so what is capped is the explanation and never the finding. `--quiet` keeps the
list and drops the diffs. The diff is written here rather than installed: `diff` (jsdiff) is only
resolvable in this workspace as a transitive dependency of a devDependency, and adding it as a real
one costs a package on every install of the CLI in exchange for about a hundred lines of a
published algorithm. It is checked by applying its own output: every case in its suite requires the
emitted patch, replayed against the "before" text, to reproduce the "after" text exactly.

**`--check` also stopped writing.** It used to snapshot the output directories, let the generators
overwrite them for real, compare, and restore the snapshot, so the one command documented as never
touching your tree was the command that rewrote every generated file on every CI run, with a window
in which a killed process left the tree modified. It now compares in memory. One consequence: a file
in an output directory that the run no longer produces is not reported, and the `removed` drift
status is no longer produced. Reporting every unrecognised file in an output directory would mean a
config whose `outDir` is `src` failed CI over every hand-written module in the project.

**`drzl watch` runs one rebuild at a time** (item 75). The debounce that was there covered the wait
and not the work: it collapsed changes arriving close together and then started a rebuild that took
as long as it took, and every change arriving during _that_ started another one on top of it,
writing the same output directory. Measured on a 600-table schema where one rebuild takes about
1.4s, six saves 700ms apart produced six rebuilds with four running at once. A save that arrives
during a rebuild is now remembered rather than started, and produces exactly one more rebuild when
the current one finishes, however many arrive; the same measurement now shows at most one in
flight. No save is dropped, because refusing one loses an edit, which is worse than the overlap.

`--debounce` keeps its 200ms default, now measured rather than inherited: with the write-settling
this watcher asks chokidar for, one editor save arrives as a single event and the widest gap inside
one burst was 9ms; without it, a chunked write spread to 62ms, an atomic save to 101ms and
format-on-save to 121ms. `--debounce 0` now works, having previously been read as absent by
`Number(x) || 200` and silently replaced, and a value that is not a number is refused with a warning
instead of quietly becoming 200.

**Clearing the screen is opt-in** (item 75). `drzl watch` cleared the terminal on every rebuild with
no way to stop it, throwing away the previous rebuild's errors and the banner naming the watched
directories. It is now `--clear`, off by default, and it writes to the stream the output is actually
on: the old `console.clear()` decided from stdout while every human-readable line goes to stderr, so
`drzl watch > events.json` at a terminal cleared nothing and aimed the escape at the stream carrying
the JSON.

**The analysis was already shared between generators** (item 82), and there is now a test that says
so. Measured on a 200-table schema: one, two, three and five generators each report exactly one
analysis step, at a constant 37ms, and the four extra generators cost 2468ms of generator work
where four extra analyses would have added about 148ms. `watch` re-analyses per rebuild, which is
what keeps a cached analysis from going stale when the schema changes.
