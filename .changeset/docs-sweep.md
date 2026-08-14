---
---

Fix five wrong statements in the documentation, and gate the one that had already rotted.

The generator count was stale at fourteen in four places: the docs home page front matter, the
VitePress site description, the landing page's facts list and, differently, the runtimes page. There
are twenty-seven.

`docs/guide/configuration.md` listed the generators that share the top-level `outDir` and omitted
`pothos`, which does write there and does write an `index.ts`, so a config running it beside another
router would have lost one file with nothing in the docs to warn about it. Checked by generating with
each of the twenty kinds rather than by reading: nineteen write an `index.ts` and `openapi-fetch`
writes a `client.ts`, which the same sentence had also been overstating.

`docs/guide/runtimes.md` described "all 14 generators" emitting "47 files". The script it credits with
re-measuring that, `scripts/runtime-compat.sh`, runs six validator generators against a one-table
schema and emits twelve files. The page had been describing a configuration that no longer existed.

Renumbering a measurement is falsifying it, so the paragraph was re-measured against the script's
actual config, and the script now reads the count back out of the page and fails when its own run
disagrees. The number reports its own rot instead of waiting to be noticed, which is the only reason
the previous one survived: the page credits the script with keeping it honest, and no gate ever read
the page.

The count is matched with `awk` on a literal substring rather than a regex, because `grep` is ugrep
on at least one maintainer's machine and a detector that silently matches nothing would pass forever.
