---
'@drzl/cli': minor
---

`drzl init` finds your schema, asks what to generate, and defaults to a validator

`init` wrote `schema: 'src/db/schema.ts'` whether or not that file existed. That is not an inert
mistake, and the measurement is the argument: in an empty directory, `drzl init` exits 0, and the
`drzl generate` that follows it analyzes nothing, writes `src/api/placeholder.orpc.ts` reading "No
tables detected in analysis", and also exits 0. The first two commands a new user runs both
reported success having read no schema at all.

`init` now detects the schema, drizzle-kit first. If `drizzle.config.ts` is there, DRZL reads its
`schema` entry through the same resolver `generate` uses, expanding globs and directories exactly
as drizzle-kit does, and the scaffolded config then states no `schema` of its own: the path stays
written in one place and DRZL reads it from drizzle-kit at generate time. Otherwise it walks
conventional locations, `src/db/schema.ts` first, then the same shape under `src/lib/db`, `app/db`,
`lib/db`, `db`, `drizzle` and the project root, as a file or an `index.ts` inside a `schema/` or
`schemas/` directory.

A candidate is validated by **importing it and counting Drizzle tables**, never by `existsSync`. A
file that imports cleanly and declares no tables is skipped and the walk continues, because a
`schema.ts` exporting a connection string is worse than no detection: it produces exactly the
silent placeholder run above. A file that cannot be imported at all, which is usually "install has
not been run yet", is used with a warning instead of being skipped. When nothing is found, the
config is still written, with `schema` left out and commented; `init` will not name a file that is
not on disk.

The default generator is now `zod` rather than `orpc`, and the rule behind it is narrower than
taste: `init` offers only generators `@drzl/cli` depends on outright, so every kind it can
scaffold is installed by definition beside the CLI that scaffolded it. Eight generators are
`optionalDependencies` instead, including every route generator except oRPC, and an installer skips
an optional dependency that is not on the registry, so scaffolding one would produce a config whose
first `drzl generate` fails on a module that was never installed. A test asserts the offered list against `package.json` so that
cannot drift. The choices are `zod`, `valibot`, `arktype`, `typebox` and `orpc`.

`-y, --yes` was declared and then ignored: `init` and `init --yes` were byte-identical, so the
flag advertised an interactive command that did not exist. The prompts are now real, and the flag
keeps the meaning it always advertised. Non-interactive stays the first-class path: questions are
asked only when stdin **and** stdout are both terminals and `CI` is unset, no readline interface is
constructed otherwise, and closing stdin or pressing `Ctrl+D` at a prompt takes the defaults and
stops rather than waiting. Two new flags, `--schema <path>` and `--generators <list>`, answer the
two questions from a script, so nothing `init` asks can only be answered by a human.

An existing config is still never overwritten, and now it is not shadowed either. `init` checked
only `drzl.config.ts`, so running it beside a `drzl.config.json` wrote the scaffold, exited 0, and
left the user's config in place but dead: the loader tries the five config names with `.ts` first,
so the next `drzl generate` ran the scaffold instead of it. All five names are checked now. The
message is also no longer the raw `EEXIST: file already exists, open ...` errno string, which
named no command and suggested nothing.
