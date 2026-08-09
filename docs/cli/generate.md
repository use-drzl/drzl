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
- `--check`: regenerate and report drift, with a diff, without writing anything
- `--dry-run`: report what would be written, and write nothing
- `--json`: one JSON document on stdout, described in [Output](/cli/output#generate-json)
- `-q, --quiet`: silent on success, errors still on stderr

Behavior:

- Analyzes your schema then runs each generator in `generators[]`
- Prints a file summary per generator kind on stdout
- Says what changed, not only how many files it wrote
- Puts warnings, the spinner and the progress bar on stderr, so `drzl generate > files.txt` holds
  only the paths that were written
- Draws a progress bar only at a terminal, and only for a schema with enough tables that it will
  move; see [Output](/cli/output)

When the config has no `schema` key, the path is read from your drizzle-kit config
(`drizzle.config.ts`, then `.js`, then `.json`), and the run says so:
`Schema from drizzle.config.ts (3 files)`. See
[Reading the schema path from drizzle-kit](/guide/configuration#reading-the-schema-path-from-drizzle-kit).

## What changed, not how many files

Every run reports each file as **created**, **changed** or **unchanged**, and names the ones that
are not the same as they were:

```
✔ Analysis complete in 41ms
✔ Generated (zod): 3 files (1 created, 1 changed, 1 unchanged)
  + zod/posts.zod.ts
  ~ zod/index.ts
```

A run that rewrote twelve identical files and one real change used to say `13 files`, which is true
and is not the sentence anyone was looking for. Unchanged files are counted rather than listed: the
list is what changed.

That report is narration, so it is on stderr and `--quiet` drops it. **stdout is unchanged**: still
one absolute path per line, so anything parsing `drzl generate > files.txt` is unaffected.

## `--dry-run`: what would happen

```bash
npx @drzl/cli generate --dry-run
```

Runs every generator, computes every file, and writes none of them. stdout still lists the paths,
because "what would you write" and "what did you write" are the same answer to the same question, so
`drzl generate --dry-run > files.txt` works. stderr says what each file would be:

```
✔ Would write (zod): 3 files (1 created, 1 changed, 1 unchanged)
  + zod/posts.zod.ts
  ~ zod/index.ts
✔ Dry run: 3 file(s) would be written (1 created, 1 changed, 1 unchanged). Nothing was written.
```

**Nothing at all is written**, and that includes directories: a dry run in a project that has never
been generated into leaves the directory byte-for-byte as it found it, with no `mkdir`, no output
and no formatter cache. That is asserted by test rather than claimed, and checked at runtime as
well, because generators are separate packages: a run that promised to write nothing and then wrote
something puts the tree back and exits `1` with `DRZL_GEN_003`, telling you to update your
`@drzl/generator-*` packages.

It exits `0` whether or not anything would change. A dry run that computed its answer did what it
was asked, and `2` is reserved for a run that found what it was told to look for. `--check` is the
flag whose question is "is anything stale", and it still answers `2`.

Passing both is not an error. `--check` already writes nothing, so `--dry-run` adds nothing to it,
and `--check` decides the exit code.

## When there is nothing to generate from

A run that would write nothing but an empty barrel exits `1` and writes no files at all. There are
three ways to get there and they have three different fixes, so they are three different messages.

**The schema module would not load** (`DRZL_SCHEMA_001`). The file is not there, or importing it
threw: a syntax error, a missing package, a module that runs code at import time and fails.

```
Could not load the schema module src/db/schema.ts (DRZL_SCHEMA_001): Error: Cannot find module 'postgres'
Fix that error and run again. `drzl analyze src/db/schema.ts` prints it in full. Nothing was generated.
```

```
Schema file not found (DRZL_SCHEMA_001): src/db/schema.ts
Check the "schema" path in your drzl config, or point --config at another one. Nothing was generated.
```

**The module loaded and declares no tables** (`DRZL_SCHEMA_002`). Nothing is wrong with your
imports; the module exports no `pgTable`, `mysqlTable` or `sqliteTable`.

```
No Drizzle tables found in src/db/schema.ts (DRZL_SCHEMA_002).
That module imported cleanly and exported no tables, so every generator would write an empty
barrel. Export them from it, for example: export const users = pgTable(...). Nothing was generated.
```

**The config's filters removed every table** (`DRZL_SCHEMA_003`). The schema is fine and
`include`/`exclude` left nothing, so the message names the tables that were really there:

```
Every table was removed by this config's filters (DRZL_SCHEMA_003). src/db/schema.ts declares 3 tables: users, posts, comments.
Check "include" and "exclude" in your drzl config. A pattern is matched against the whole database
table name, with * as the only metacharacter. Nothing was generated.
```

All three exit `1` under `--check` too: a check needs something to compare, and reporting an empty
tree as up to date is how a broken schema passes CI. `generate:orpc` and `generate:trpc` report the
same three and, unlike before, write no placeholder file.

`drzl watch` reports all three and keeps watching rather than exiting, because a file saved
mid-edit is expected to be in one of these states for a moment. See [Watch](/cli/watch).

## `--check`: fail CI when generated output is stale

```bash
npx @drzl/cli generate --check
```

Regenerates and compares the result against what is on disk. Exits `2` if anything differs and
`0` when everything is current, naming each file and then showing what is different about it:

```
Generated output is out of date (2 file(s)):
  ~ changed  src/validators/zod/people.zod.ts
  + added    src/validators/zod/extra.zod.ts

--- a/src/validators/zod/people.zod.ts
+++ b/src/validators/zod/people.zod.ts
@@ -6,7 +6,7 @@

 export const InsertpeopleSchema = z.object({
   id: z.number().int().optional(),
-  email: z.string().email(),
+  email: z.string(),
 });

Run `drzl generate` and commit the result. Nothing was written by this check.
```

The diff is a standard unified diff, so it greps, it reads the way `git diff` reads, and it applies:
`a/` is what is on disk and `b/` is what this schema produces. That distinction is the point.
"Changed" alone cannot tell a regenerated header from a hand-edit somebody made to a generated file,
and those two want opposite responses.

Diffs are capped at the first **20** files, and a file longer than 4000 lines, or one that differs
by more than 1500 line edits, prints a one-line summary instead of hunks. Every cap says so in the
output, and every drifted file is still named in the list above the diffs: what is capped is the
explanation, never the finding.

`--quiet` keeps the list and drops the diffs. The list is the finding, which a `2` with nothing to
read makes unusable; the diff is the explanation.

It catches the two things that actually happen: someone edits a generated file by hand, and
someone changes the schema without regenerating. Both are review problems today and CI problems
with this.

**It never writes anything.** Not "writes and puts it back": the files are produced in memory and
compared there, so there is no window in which your tree is in an intermediate state and nothing to
restore if the process is killed. Before 4.23 this snapshotted the output directories, let the
generators overwrite them for real, compared, and restored the snapshot.

One consequence worth stating: a file in an output directory that the run no longer produces is not
reported. `--check` compares the files this schema generates against what is on disk under those
names, and a `removed` status is no longer possible. Reporting every unrecognised file in an output
directory would mean a config whose `outDir` is `src` failed CI over every hand-written module in
the project.

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
