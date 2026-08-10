---
'@drzl/cli': patch
---

`drzl generate` over an up-to-date tree now touches nothing

The command already knew which files were unchanged, and printed the count. It wrote them anyway. A
byte-identical write is a no-op with a side effect: it moves the file's mtime, and an mtime is what
every watcher downstream keys on, so regenerating a tree that had not changed restarted dev servers,
re-ran type checkers and invalidated bundler caches for no reason.

An unchanged file is now left alone, which makes `generate` idempotent at the filesystem level:
what it claims when it prints `unchanged`.

The comparison is against what is on disk now rather than against what was there when the run
started. The two differ for a path written twice in one run, which is what happens when two
generators share an output directory: the first write has already put different bytes there, so
"identical to what was there before the run" stops meaning "identical to what is there". That case
is tested, and the last write still wins.
