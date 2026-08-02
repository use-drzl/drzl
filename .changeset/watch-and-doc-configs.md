---
'@drzl/cli': major
'@drzl/analyzer': patch
---

**`drzl watch` never regenerated.** It has been inert since the chokidar v4 upgrade: it did one
build on startup and then sat there, no matter how many times the schema was saved.

Chokidar removed glob support in v4 (September 2024). The watcher was handed
`<schema dir>/**/*.{ts,tsx,js}` and, in v4, that is a literal path, so it watched a directory
called `**` which does not exist. No event ever fired. The startup build is what made this look
like it worked: run `drzl watch`, see files appear, assume the watcher is live.

Watch targets are the schema's directory now, which chokidar recurses into by itself, and the
extension filtering the glob used to do happens on the event instead, so an unrelated file next
to the schema does not trigger a rebuild.

Marked breaking because a project relying on `watch` has been silently running against stale
output, and the command now genuinely reruns.

### Also, in the analyzer

Analyzing the same path twice returned the first parse. The schema is loaded through jiti, which
delegates to `require` and keeps a process-global module cache, so re-analysis in a long-lived
process never saw the file as it now is. Constructing a fresh analyzer per run did not help; the
cache is not the instance's. It passes `moduleCache: false` now.

This has no effect on a one-shot `generate`, which analyzes once and exits. It matters for
`watch`, and it would have made the fix above produce confidently stale output rather than no
output at all, which is worse.
