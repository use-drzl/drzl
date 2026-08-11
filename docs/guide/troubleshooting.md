# Troubleshooting

Keyed by what the CLI prints. Search this page for the code in the message, for example
`DRZL_SCHEMA_002`, and you will land on the section about it.

Every message quoted here was produced by running the CLI against a deliberately broken fixture,
not copied out of the source, so what you see is what you get including the punctuation. The one
exception is marked where it appears. The **code** is the stable part and is what a script should
match on; the sentence around it may be reworded in a later release. Codes also appear in the
`--json` failure document, which is the better thing to parse. See
[Output, exit codes and `--json`](/cli/output).

If the message you have is not here, run the command again with `--json`: the document carries the
same `code` and `message` with nothing else on the stream.

## Nothing runs at all

### `drzl: command not found`

```
$ drzl generate
bash: line 1: drzl: command not found
```

```
$ drzl generate
sh: 1: drzl: not found
```

Exit code `127`, from the shell rather than from DRZL. Almost always a fresh clone where
`node_modules` has not been installed yet, or a global install that was never done.

The fix, in order of how likely it is to be what you meant:

```bash
npm install                # you meant the project's own dependency
npx @drzl/cli generate     # you meant to run it without installing
pnpm exec drzl generate    # it is installed, but not on PATH in this shell
```

A package script (`"generate": "drzl generate"` run through `npm run generate`) puts
`node_modules/.bin` on `PATH` for you, which is why the same command works there and not in your
shell.

### `@drzl/cli looked for its own version in ... and found ...`

```
Error: @drzl/cli looked for its own version in /some/path/package.json and found "my-app",
so this build is not sitting where it thinks it is.
```

The CLI reads its version from the manifest beside its own `dist/`, and refuses to start when that
manifest is not `@drzl/cli`'s. It means a build was copied or vendored out of its package. Install
the package rather than moving its `dist` around.

## The config

### `DRZL_CFG_001`: no config, or no schema

```
No config found (DRZL_CFG_001). Create drzl.config.ts or pass --config.
```

From `generate` and `watch`, when there is no `drzl.config.*` in the working directory. Run
[`drzl init`](/cli/init) to write one, or pass `--config path/to/drzl.config.ts`.

`explain` prints a different sentence under the same code, because it can work from a bare schema
path and looks in three places before giving up:

```
No schema found (DRZL_CFG_001). There is no drzl.config, no drizzle-kit config, and no schema in
the usual locations.
Pass --schema <path>, or run `drzl init` to write a config.
```

Exit code `1` in both cases. A config that is not there is a run that could not start, not a
finding.

### `DRZL_CFG_002`: the config does not validate

```
drzl.config.ts is not valid (DRZL_CFG_002). 2 problems:
  - outDir: expected string, received number (found 123)
  - generators[0].kind: Invalid option: expected one of "orpc"|"trpc"|"hono"|"express"|"fastify"|"nestjs"|"graphql"|"mcp"|"next"|"service"|"zod"|"valibot"|"arktype"|"typebox"|"effect"|"json-schema" (found "zed")
```

Every problem is listed, not just the first, and each names the key path the way you would write
it in the file, so `generators[1].validation.library` is a path you can paste back. `(found ...)`
is what the file really says at that key. Eight are listed and the rest are counted.

The [configuration reference](/guide/configuration) lists every key. There is also a
[JSON Schema](/guide/configuration#json-configs) generated from the same zod schema the CLI
validates with, so an editor can catch this before you run anything.

### `drzl config: unknown key "..."; it is ignored.`

```
drzl config: unknown key "outDirr" at the top level; it is ignored. Did you mean "outDir"?
drzl config: unknown key "typedJsn" in generators[0]; it is ignored. Did you mean "typedJson"?
```

A warning, not a failure: the run continues and exits `0`. It is here because the failure it
reports used to be silent. A key the schema does not know is dropped, so a setting you wrote down,
believe in, and have possibly been debugging around simply never applied.

The suggestion appears only when the key really is a typo: one edit for a short key, two from five
characters up. No suggestion means the key is not a near miss of anything, which usually means it
belongs at a different level: `outDir` is a root key and `path` is the per-generator one, and they
are easy to swap. A wrong suggestion would send you to change a line that was right, so no
suggestion is preferred to a guess.

Under `drzl generate --json` these are in the document's `warnings` array rather than on stderr.

### `drzl config: no "schema" is set and no drizzle-kit config was found`

```
drzl config: no "schema" is set and no drizzle-kit config was found (looked for
drizzle.config.ts, drizzle.config.js, drizzle.config.json in /path/to/project). Set "schema" in
your drzl config, or add "drizzleKit" naming your drizzle-kit config file.
```

A config with no `schema` falls back to your drizzle-kit config, so a project that already states
the path once does not have to state it twice. This is that fallback finding nothing. Either set
`schema: 'src/db/schema.ts'` in your drzl config, or point `drizzleKit` at the drizzle-kit config
by path: `drizzleKit: './config/drizzle.config.ts'`.

Related messages from the same fallback, all of them naming the file they are about:

| Message                                                      | Cause                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------- |
| `"drizzleKit" points at ..., which does not exist.`          | The path you gave is wrong                                          |
| `... did not export a drizzle-kit config object.`            | The file loaded and its default export is not an object             |
| `... has no "schema" entry, so there is nothing to analyze.` | The drizzle-kit config found, without a `schema` of its own         |
| `the "schema" patterns in ... matched no schema files: ...`  | Globs that expand to nothing. DRZL expands them as drizzle-kit does |
| `no "schema" is set and "drizzleKit" is false`               | You turned the fallback off and did not replace it                  |

### `drzl config: both "schema" and "drizzleKit" are set.`

```
drzl config: both "schema" and "drizzleKit" are set. "schema" wins, so the drizzle-kit config was
not read; remove one of the two to silence this.
```

A warning. Nothing is broken, and the run continues, but one of the two lines in your config is
doing nothing, which is worth knowing before you edit the wrong one.

### `drzl config: the "columns" option cannot be honoured.`

```
Generate failed (DRZL_GEN_001): drzl config: the "columns" option cannot be honoured.
  - columns["users"].omit names "passwrodHash", which matches no column of users. Available: id, email, name, createdAt.
```

Every pattern in `columns` has to match something. This is deliberately a failure rather than a
warning: `omit: ['passwrodHash']` that silently does nothing is not a no-op, it is the leak you
reached for the option to close, wearing the shape of a fix. The available column names are
printed so you can see the spelling you meant.

A table pattern matching no table reports the same way, and lists the tables the schema declares.

Two warnings from the same option are worth reading rather than skipping, because both describe a
`columns` rule that worked and did more than you meant:

```
drzl config: columns pattern "users" matches tables in more than one schema, and every one of them
is affected: auth.users, public.users. Write the schema to mean one of them, for example
"auth.users".
```

```
drzl config: the "columns" option drops "token" from table "auth.users", and the database requires
it: NOT NULL with no default. The emitted insert schema therefore describes a payload that is not
a complete row, so whatever calls db.insert has to supply "token" itself.
```

A third fires when the dropped column is named by a CHECK, which then stops being enforced by
anything DRZL emits. Your database still enforces it; nothing generated does.

### `drzl config: the "<kind>" generator sets ..., which it does not read.`

A family of warnings, one per option a generator ignores. For example, `databaseInjection.enabled`
on `fastify`, `includeRelations` on `nestjs`, `validation` on `graphql`. The option is valid in the
config schema, so `DRZL_CFG_002` cannot catch it; it just has no effect on that generator, and the
warning names both the generator and the key.

Two of them are failures rather than warnings, because the result would not compile: a router
generator whose `validation.schemaSuffix` or `validation.affix` disagrees with the validation
generator it imports schemas from. Those messages print both spellings and both exports, since the
whole problem is that the two disagree.

## The schema

The three `DRZL_SCHEMA_*` codes are one moment for you ("I ran generate and got nothing") and
three unrelated causes: fix your import, export your tables, loosen your filter. All three exit
`1` and write nothing.

`drzl watch` is the exception: it reports all three and keeps running, because a file saved
mid-expression, a schema being written from scratch and a filter being adjusted are ordinary
states for a watcher to be in. `generate --check` is deliberately not exempt, so a CI run on an
unreadable schema fails rather than comparing an empty tree with itself and calling it up to date.

### `DRZL_SCHEMA_001`: the schema file is not there

```
Schema file not found (DRZL_SCHEMA_001): src/db/scehma.ts
Check the "schema" path in your drzl config, or point --config at another one. Nothing was generated.
```

The path in your config, spelled exactly as the config spells it, so a typo is visible by reading.
Paths are resolved from the directory you ran the command in, not from the config file's own
directory, which is the second most common cause after a typo: `drzl generate --config
config/drzl.config.ts` still resolves `src/db/schema.ts` from where you are standing.

`schema` in a drzl config is a single path. Several files, or a glob, reach DRZL through the
drizzle-kit config instead, whose `schema` is a string or an array of them and is expanded the way
drizzle-kit expands it. There, every file that is missing is named in the same run rather than one
per run.

### `DRZL_SCHEMA_001`: the schema will not import

```
Could not load the schema module src/db/schema.ts (DRZL_SCHEMA_001): Error: Cannot find module '@paralleldrive/cuid2'
Fix that error and run again. `drzl analyze src/db/schema.ts` prints it in full. Nothing was generated.
```

**This is usually not a DRZL problem.** DRZL runs your schema module to read it, so anything that
would throw when your application imports it throws here too. The reason is quoted from the throw,
first line only, and the file is named because a project with four schema modules and one bad
import needs to know which one.

The three that come up:

- **A package the schema imports is not installed.** The example above. `npm install` the named
  package. It happens most often on a fresh clone, and on a schema importing something that is a
  dev dependency somewhere else in the monorepo.
- **Module-scope code that needs the environment.** A schema that reads `process.env.DATABASE_URL`
  at module scope, or opens a connection, runs that code during analysis. Move it behind a
  function, or into the module that creates the client rather than the module that declares the
  tables.
- **A syntax or type error.** The loader compiles TypeScript on the fly, so an error your build
  would catch shows up here first.

`drzl analyze <path>` prints the whole message under `issues`, including the require stack that
names which file did the importing, which is the faster read when the first line is not enough:

```json
{
  "code": "DRZL_ANL_IMPORT",
  "level": "error",
  "message": "Failed to import schema: Error: Cannot find module '@paralleldrive/cuid2'\nRequire stack:\n- /path/to/src/db/schema.ts"
}
```

### `DRZL_SCHEMA_002`: no Drizzle tables in it

```
No Drizzle tables found in src/db/schema.ts (DRZL_SCHEMA_002).
That module imported cleanly and exported no tables, so every generator would write an empty
barrel. Export them from it, for example: export const users = pgTable(...). Nothing was generated.
```

The module ran perfectly and declares nothing DRZL can generate from. All three of these were
measured, and all three produce an analysis with zero tables and zero issues:

- **The tables are declared and never `export`ed.** DRZL reads the module's exports, so a
  `const users = pgTable(...)` used only inside the file is invisible to it.
- **The barrel re-exports them as types.** `export type { users }` is erased before the module
  runs, so there is nothing left to read. `export * from './tables.js'` is the shape that works.
- **`schema` names the wrong file**, one directory or one filename off, and the file it does name
  is a real module that declares no tables.

`drzl analyze <path>` on the same file prints an empty `tables` array with no error issues, which
confirms it read the file and there was nothing in it.

### `DRZL_SCHEMA_003`: your filters removed everything

```
Every table was removed by this config's filters (DRZL_SCHEMA_003). src/db/schema.ts declares 2
tables: posts, users.
Check "include" and "exclude" in your drzl config. A pattern is matched against the whole database
table name, with * as the only metacharacter. Nothing was generated.
```

The table names are the point: they are what turns "why is my output empty" into "my pattern is
wrong". Note what the patterns match against:

- the **database** name (`app_users`), not the TypeScript export name (`appUsers`)
- the whole name, not a substring. `include: ['user']` does not match `users`; `include: ['user*']`
  does
- `*` is the only metacharacter. It is not a regular expression and not a glob with `?` or `[]`

A table in a named SQL schema is addressed as `auth.users`, and a bare pattern that reaches into
more than one schema warns about it by name.

## Generators

### `DRZL_GEN_002`: the generator is not installed

```
The zod generator is not installed.
Install with: npm install @drzl/generator-zod
```

```json
{
  "ok": false,
  "command": "generate",
  "code": "DRZL_GEN_002",
  "message": "The zod generator is not installed. Install with: npm install @drzl/generator-zod",
  "exitCode": 1
}
```

Only ever printed when the package really is absent. A generator that is installed and throws gets
the message below instead, which was not always true: every failure used to send its user to
reinstall a package they already had.

### `DRZL_GEN_002`: the generator threw

```
The express generator failed: @drzl/generator-express: the routes for table "index" would be
written to /path/to/src/routes/index.ts, which is the barrel this generator also writes. Set
naming.routerSuffix to move it out of the way.
```

Same code, different sentence. Everything after the colon is the generator's own message, and it
names itself, so you always know which package to look at. The ones worth recognising are the
collisions, because the fix is in your config or your table names rather than in your schema:

- `the routes for table "..." would be written to ...` from a route generator: a table whose module
  would overwrite the barrel or the shared validation module. `naming.routerSuffix` moves it.
- `the OpenAPI path "..." is claimed twice` and `the operationId "..." would be emitted for both`
  from the JSON Schema generator: two tables produce one path or one method name. See
  [OpenAPI Document](/generators/openapi).

A generator that throws stops the run at `1`. Generators configured before it have already
written their files, which is why a failing run can leave a partly regenerated tree; rerun after
fixing, or use `--dry-run` while you are experimenting.

### `DRZL_GEN_003`: a generator wrote during `--dry-run` or `--check`

This is the one message on this page not reproduced from a run, because producing it needs a
generator package deliberately older than the CLI. It reads:

```
1 file(s) were written by a run that promised to write none, and have been restored. This means an
installed generator package is older than this CLI. Update your @drzl/generator-* packages. First
file: src/validators/zod/users.zod.ts
```

`--dry-run` and `--check` compute every file and put none of it on disk. Generators are versioned
separately from the CLI, so an older one does not know how to report a file instead of writing it.
Anything it wrote has been put back before this message printed. Update the `@drzl/generator-*`
packages to match the CLI.

### `DRZL_GEN_001`: everything else

The fallback for a `generate` that failed for a reason with no code of its own, which today means
most of the `drzl config:` messages above, a template path that does not resolve, and any I/O
failure while writing. The real message sits between a header and a tip:

```
Generate failed (DRZL_GEN_001): drzl config: no "schema" is set and no drizzle-kit config was found
(looked for drizzle.config.ts, drizzle.config.js, drizzle.config.json in /path/to/project). Set
"schema" in your drzl config, or add "drizzleKit" naming your drizzle-kit config file.
Tip: check your drzl.config.ts and template path.
```

The one exception is `DRZL_CFG_002`, which prints on its own: it is already a report with its own
header, and putting "Generate failed" over it would be a second header on one message.

## `explain`

### `DRZL_EXPLAIN_001`: no such table

```
No table called "userz" (DRZL_EXPLAIN_001). This schema declares 2 tables: posts, users.
Did you mean "users"?
```

The list is the useful part: a wrong name and the wrong schema file look identical from outside,
and the list tells you which you have. A table answers to its database name, its schema-qualified
name (`auth.users`), or the name it is exported under, and case is ignored when nothing matches
exactly.

### `DRZL_EXPLAIN_002`: the name reaches more than one table

```
"users" names 2 tables (DRZL_EXPLAIN_002): auth.users (exported as authUsers), public.users (exported as publicUsers).
Name one of them exactly, for example "auth.users".
```

Reachable from an ordinary schema with named SQL schemas in it. `explain` refuses rather than
picking one, because answering a question about one table with facts about another is worse than
not answering.

## Warnings that are not failures

These appear in `drzl analyze` output under `issues`, in the `drzl doctor` report, and on stderr
during `generate`. None of them stops a run.

| Code                      | What it means                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `DRZL_ANL_UNKNOWN_COLUMN` | A column has no knowable runtime type, so its validator accepts any value                 |
| `DRZL_ANL_DIALECT`        | The dialect could not be identified; column types fall back to coarse defaults            |
| `DRZL_ANL_DUP_EXPORT`     | Two schema files export the same name and disagree; the first one wins                    |
| `DRZL_ANL_RELATIONS`      | A `relations()` block threw while being read; those relations are missing                 |
| `DRZL_ANL_REL_V2`         | A drizzle v1 relation names no target table and was skipped                               |
| `DRZL_ANL_EXTRACONFIG`    | A table's extra-config callback threw; its indexes, composite keys and CHECKs are missing |
| `DRZL_ANL_TABLE`          | One export could not be analysed; the rest of the schema was                              |

### `DRZL_ANL_UNKNOWN_COLUMN`

`drzl generate` collects these into one block on stderr:

```
1 column could not be typed:
  - Column "label" on table "notes" has no known type (SQL type citext), so its validator will accept any value.
  A customType has no runtime shape to read. Declare it with .$type<T>() and turn on typedColumns to give the validator the type.
  Run `drzl doctor` for the full report.
```

The one to act on, because the generated validator for that column checks nothing. A `customType`
has no runtime shape to read, so tell DRZL what it is: declare the column with
`.$type<string>()` in your schema, and set `typedColumns: true` on the generator entry in your
config. The validator then describes the type you declared instead of accepting anything.

`drzl doctor` collects every one of these into a section with the fix under each, and
`drzl doctor --strict` exits `2` when there are any, which is how you keep them from accumulating.

### `DRZL_ANL_DIALECT`

```
Could not identify the Drizzle dialect for this schema; saw column kinds: SQL.Aliased, Aliased.
```

DRZL identifies the dialect from the column types in the schema. A file that exports only views
built from raw `sql` has no column that names one. Point `schema` at the module that declares the
tables, and the views come along with a dialect attached.

### `drzl: <config> declares dialect "...", but the schema analyzed as "..."`

```
drzl: drizzle.config.ts declares dialect "mysql", but the schema analyzed as "postgres". DRZL
follows the schema; if the schema files are the right ones, the dialect in that config is stale.
```

Only when the schema comes through a drizzle-kit config. Two sources disagree about one fact, and
DRZL uses the one it can verify. The usual cause is a `drizzle.config.ts` copied from another
project, and the usual fix is one line in that file.

## Exit codes

Three, and they mean the same thing on every command.

| Code | Meaning                                                 |
| ---- | ------------------------------------------------------- |
| `0`  | The command did what it was asked.                      |
| `1`  | DRZL could not do the work.                             |
| `2`  | DRZL did the work, and found what it was asked to find. |

The pair people trip over is `generate --check`:

```
Generated output is out of date (1 file(s)):
  ~ changed  src/validators/zod/users.zod.ts

--- a/src/validators/zod/users.zod.ts
+++ b/src/validators/zod/users.zod.ts
@@ -51,4 +51,3 @@
 export type InsertusersInput = z.input<typeof InsertusersSchema>;
 export type UpdateusersInput = z.input<typeof UpdateusersSchema>;
 export type SelectusersOutput = z.output<typeof SelectusersSchema>;
-export const extra = 1;

Run `drzl generate` and commit the result. Nothing was written by this check.
```

That is exit `2`, and it is not a failure. The check ran perfectly and is reporting what it found;
run `drzl generate` and commit. Exit `1` from the same command means it could not run at all. A CI
job that only tests for a non-zero exit does not need to care, and one that wants to show a diff
does. The full table is on [Output, exit codes and `--json`](/cli/output#exit-codes).

## Two more commands that answer "why"

Before opening an issue, these two usually say it:

- **`drzl doctor`** reports everything DRZL cannot type or enforce in your schema, with the fix
  under each finding, and exits `0` because none of it stops generation. `--strict` makes it exit
  `2` instead, for CI. See [Doctor](/cli/doctor).
- **`drzl explain <table>`** shows what DRZL understood about one table and, more usefully, what it
  did not: a CHECK it declined to translate and why, a column it could not type, a relation it
  could not follow. If a generated schema is missing a constraint you expected, this is the command
  that says why. See [Explain](/cli/explain).

```bash
drzl doctor
drzl explain users
```

Neither writes anything.
