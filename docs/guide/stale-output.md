# Stale output

`drzl generate` writes a manifest of the files it produced, at `.drzl/manifest.json`. The next run
compares against it and tells you about files a previous run wrote that this one did not.

## Why it exists

A generator writes the tables it finds and leaves everything else alone. Rename a table, or delete
one, and the file for the old name stays where it was. It still compiles, it still exports a schema,
and it describes a table your database does not have. Nothing reported it, because nothing knew DRZL
had written it.

```
drzl generate: 1 file(s) written by a previous run were not written by this one, and are still on
disk: src/generated/zod/posts.zod.ts. That usually means a table was renamed or removed. Delete them
with `drzl generate --prune`, which removes only files a previous run recorded writing.
```

## Why a manifest rather than a glob

The manifest is what makes deleting safe, and that is the whole point of it.

An output directory is a place you also keep hand-written files, barrels you edited, and the output
of other tools. A generator that deleted "everything that looks generated" would eventually delete
something a person wrote. Deleting only what a previous run recorded writing cannot.

`--prune` is bounded by that record, and refuses any path that climbs out of the project root, since
the manifest is an ordinary file somebody can edit.

## What is in it

```json
{
  "version": 1,
  "files": ["src/generated/zod/index.ts", "src/generated/zod/users.zod.ts"]
}
```

Paths relative to the project root, forward slashes, sorted. No timestamp and no checksum,
deliberately: a timestamp would rewrite the file on every run and put noise in every commit, and a
checksum answers a question `--check` already answers better by comparing the content it just
produced.

Commit it. It is small, it diffs cleanly when a table is added, and its whole value is being there
on the next run.

## What does not touch it

`--check` and `--dry-run` read the manifest and report against it, and never write it. Recording a
run that wrote nothing would tell the next one that every file is stale, and offering to delete the
whole output because somebody ran `--check` is the worst thing this could do.

A missing, truncated or unreadable manifest means "no record", never an error. A generator that
refused to run because its own bookkeeping file was malformed would be a worse tool than one that
quietly rebuilds it.

## One thing worth knowing

A stale file that is still on disk stays in the manifest until it is pruned or deleted. Recording
only what the run wrote would lose it after exactly one run: the warning would fire once and then
never again, and `--prune` would find nothing, because by the time you ran it the record would be
gone.
