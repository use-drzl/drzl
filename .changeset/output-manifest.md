---
'@drzl/cli': minor
---

Record what each run wrote, and report the files a later run no longer owns.

A generator writes the tables it finds and leaves everything else alone. Rename a table, or delete
one, and the file for the old name stays where it is: it compiles, it exports a schema, and it
describes a table the database does not have. Nothing reported it, because nothing knew DRZL had
written it.

`drzl generate` now writes `.drzl/manifest.json` and compares against the previous one. Files a
previous run wrote and this one did not are reported, with `drzl generate --prune` offered to remove
them.

The manifest is what makes deleting safe, and that is the whole reason it exists rather than a glob
over the output directory. An output directory is a place a consumer also keeps hand-written files,
barrels they edited, and the output of other tools, so a generator that deleted "everything that
looks generated" would eventually delete something a person wrote. `--prune` is bounded by the
record, and refuses any path that climbs out of the project root, since the manifest is an ordinary
file somebody can edit.

`--check` and `--dry-run` read it and never write it. Recording a run that wrote nothing would tell
the next one that every file is stale, and offering to delete the whole output because somebody ran
`--check` is the worst thing this could do. A missing, truncated or unreadable manifest means "no
record" rather than an error, because a tool that refused to run over its own bookkeeping file would
be worse than one that quietly rebuilds it.

The manifest carries no timestamp and no checksum, deliberately: a timestamp would rewrite the file
on every run and put noise in every commit, and a checksum answers a question `--check` already
answers better by comparing the content it just produced.

One defect found by running it rather than reading it. Recording only the files the run wrote loses
a stale file after exactly one run: run one writes `posts.zod.ts`, run two drops the table and
records only what it wrote, and by run three nothing says DRZL ever created it. The warning fired
once and `--prune` then deleted nothing. A stale file still on disk now stays in the record until it
is pruned or removed, and the three-run sequence is a test.
