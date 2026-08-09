---
'@drzl/cli': minor
---

Fail loudly when there is nothing to generate, and name the key when a config is wrong (plan items
70, 71, 78, 79)

**A run that produces nothing is now a failure.** Seven inputs were measured on the built 4.22.0
CLI, and every one of them printed a green tick, exited `0`, and wrote a single `index.ts`
containing three comment lines and no exports: a schema module that throws on import, one importing
a package that is not installed, one with a syntax error, a `schema:` naming a file that does not
exist, a module exporting no tables, a module exporting only helpers, and a config whose
`include`/`exclude` removed every table. That barrel is how the `.array()` typing bug hid: the run
that should have reported it reported success.

All seven exit `1` and write no files. The three causes are three messages, because the fixes have
nothing in common:

```
Could not load the schema module src/db/schema.ts (DRZL_SCHEMA_001): Error: Cannot find module 'postgres'
No Drizzle tables found in src/db/schema.ts (DRZL_SCHEMA_002).
Every table was removed by this config's filters (DRZL_SCHEMA_003). src/db/schema.ts declares 3 tables: users, posts, comments.
```

The distinction is the analyzer's own, not a guess from an empty table list: `DRZL_ANL_IMPORT` and
`DRZL_ANL_NOFILE` mean the module never ran, and anything else it says describes a module that did.
That is the same rule `drzl init` was built on. The failing module's file name is in the message,
which the analyzer's own wording does not carry, because a project with four schema modules and one
bad import needs to be told which one.

This covers `--check` as well, where it matters most: a check on a schema that would not load used
to compare an empty tree with itself and report it up to date, so a CI job guarding the generated
output passed on a schema nobody could read. `generate:orpc` and `generate:trpc` stop writing
`placeholder.orpc.ts`, whose contents read "No tables detected in analysis", on a schema that
imports cleanly and declares nothing.

**`drzl watch` reports all three and keeps watching.** The one place they are not fatal, and
deliberately: a watcher exists to be running while the schema is being edited, and a file saved
mid-expression, a file being written from scratch and a filter being adjusted are all ordinary
intermediate states. Exiting would mean restarting the watcher to recover from a typo.
`--pipeline analyze` still completes on a schema with no tables, matching `drzl analyze`, which
exits `0` on one because that is a true answer to the question it was asked.

**A config that does not validate names the offending key.** `ConfigSchema.parse` throws a
`ZodError` whose message is a formatted JSON array of issue objects, and that array was printed
verbatim: eleven lines in which `outDir` appeared once, inside a `path` array, three levels down.
Now:

```
drzl.config.ts is not valid (DRZL_CFG_002). 3 problems:
  - outDir: expected string, received number (found 123)
  - generators[0].nestedDepth: expected number, received string (found "deep")
  - columns.users: unrecognized key "ommit". Did you mean "omit"?
```

Array entries are indexed and a key that is not an identifier is quoted, so
`generators[1].validation.library` and `columns["app_*"].omit` can be pasted back into the file.
Every problem is listed rather than the first, capped at eight. The value found there is shown
when it fits, through `String` rather than `JSON.stringify`, so a `NaN` is reported as `NaN` and
not as the four characters `null`.

**An unknown config key warns instead of vanishing.** The root object and `GeneratorSchema` are
both permissive, so zod dropped an unrecognised key in silence: `outDirr` at the root, `typedJsn`
in a generator entry and `validation: { librari: 'zod' }` in a nested object all generated normally
and exited `0`. Each is now named, with a suggestion when it is a typo of a real key rather than a
different word:

```
drzl config: unknown key "typedJsn" in generators[0]; it is ignored. Did you mean "typedJson"?
```

A warning rather than an error, because the run really did honour the rest of the config. Nothing
is warned about where the key is legitimately the user's own: `columns` is keyed by table pattern,
`templateOptions` by whatever a template reads, and `$schema` is declared for editors. Where the
config is strict, an unknown key stays the validation error it already was and gets the key path
and the suggestion above.

The known keys at every level are read from the JSON Schema generated from the zod config schema,
rather than from a list maintained beside it, so `additionalProperties: false` is what tells the
strict levels from the permissive ones and neither can drift as the config grows.

**Config warnings go through the output layer.** They were written with `console.warn` from inside
`loadConfig`, which no flag could see: `drzl generate --json` printed them beside the document that
is supposed to be the only thing on that channel, and `--quiet` could not remove them. They are
warnings like any other now, so `--quiet` drops them and `--json` puts them in the document's
`warnings` array.
