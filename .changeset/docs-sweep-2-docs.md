---
---

Fix twenty-eight more wrong statements across the documentation, found by three independent audits.

The generator count was still "fourteen" in nine more places after the first pass corrected four:
the README, CONTRIBUTING, the CLI overview, four command pages, getting-started and the CLI package
README. The first pass missed them because its search required the number to sit immediately before
the word "generators", and these say "Fourteen in all", "the fourteen code generators", "all fourteen
kinds". A detector that matches nothing looks exactly like a clean result.

Several counts were wrong in ways a reader would act on. `docs/adapters/overview.md` described seven
generators and listed Next.js as planned, years of releases after `@drzl/generator-next` shipped; a
"planned" list is a list of absences and nothing makes it notice when one stops being absent.
`nested-relations`, `json-schema` and `doctor` each said four validation generators where Effect
Schema is a fifth that implements the same options and has its own test suite for them. The
moduleResolution sweep was described as missing two kinds; it misses seven.

Four pages and the home-page grid still said there is no `@drzl/*` package for forms. There is:
`@drzl/generator-forms`, which emits the per-table resolver and the per-field `control`, `required`,
`nullable`, `min`, `max` and `integer` metadata those same pages argue is the harder half of the
problem. The grid contradicted itself, carrying two entries that link to the generator's page above
a paragraph saying it does not exist.

The behavioural corrections are the ones most likely to have cost someone an afternoon: a config
snippet on the openapi-fetch page that `ConfigSchema` rejects outright, an emitted import path on the
same page that is one directory short of what the generator writes, `generate --check` documented as
exiting 1 where it exits 2, the no-config route attributed to `--schema` when it is `--only`,
`outDir` listed as a service generator option when the key is `path` and `outDir` is silently
ignored, a `validation.schemaSuffix` disagreement described as a failure when it is a warning,
`--pipeline all` described as refusing `--only` when it accepts it, and a non-numeric `--debounce`
described as refused when it falls back to 200ms.

`watch --json` emits a `generate_skipped` event that appeared in neither of the two closed lists of
watch events. That one is new: it shipped with the incremental watch change earlier the same day and
was never written down. A consumer counting `generate_complete` to decide a rebuild happened reads a
skipped rebuild as a watcher that has stopped responding.

The `fast-check` and `seed` pages had no install instruction at all, while every other generator page
carries one and the fast-check output imports `fast-check` directly.
