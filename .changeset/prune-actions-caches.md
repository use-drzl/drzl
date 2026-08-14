---
---

Add a `cache-prune` workflow, which deletes a branch's Actions caches once its pull request closes,
and every cache monthly.

The repository's cache store had reached 5.6 GB across 56 entries. Nothing failed outright, because a
full store makes a cache *save* warn and skip rather than error, but every run past that point
installed from the network with no restore, so the whole gate was slower for no benefit. GitHub
evicts by least-recent-use against a per-repository ceiling, which bounds the count and does nothing
about a store that is mostly dead branches: a pnpm store for this workspace is around 100 MB per key,
and a feature branch produces one per job that installs.

No package changes, so this changeset is deliberately empty of version bumps.
