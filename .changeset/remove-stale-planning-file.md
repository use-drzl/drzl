---
---

Delete the stale planning file from the repository root.

`2026-08-03-top-100.md` was a working log of shipped verdicts and addenda from a task run that
finished. Nothing links it, no gate reads it, and it is not in the docs sidebar, so it rendered
nowhere and served only to sit in the root of a public repository looking like documentation.

Two of its addenda were already resolved in the versions they describe. The one that is not is worth
restating rather than losing: the happy-path benchmark range appears as the literal string
"15% to 21%" on three pages, `benchmarks.md`, `comparison.md` and `index.md`, and nothing enforces
that they agree. The file's own conclusion was that a gate stage is the wrong fix, since a benchmark
on a shared CI runner measures the runner, and that a test asserting the string appears the same
number of times across the three pages would be the cheap answer. That remains true and remains
undone; git history keeps the full reasoning.

Working notes belong outside a public repo, which is what `drzl-files` is for.
