---
---

Assert in the gate that emitted code imports no Node builtin, rather than hoping.

Cloudflare Workers, D1 and Turso are first-class Drizzle targets, and a Worker has no Node builtins:
an `import 'node:crypto'` there is a deploy-time failure, not a runtime one, so it is not something a
consumer's own tests would catch either. It surfaces the first time they push.

DRZL emits nothing of the sort, and that was true by construction rather than by check. A new stage
scans the whole emitted tree, which is 64 files across every generator kind the consumer fixture
runs, and fails on a `node:` import or a bare builtin name. It refuses to pass on an empty tree,
because a grep over nothing succeeds exactly as loudly as a grep over something clean, and it plants
a file that does import one to prove the pattern still matches, because a broken expression would
otherwise pass by matching nothing.

The generators themselves import `node:path` and `node:fs` freely and must: they run at build time on
Node. What has to be portable is the text they write, which is what the stage looks at.

`nodejs_compat` exists and many Workers projects enable it. The emitted output is still held to the
stricter bar, because a generator cannot know whether a given consumer turned it on, and emitting
something that needs a flag nobody asked for is a requirement that surfaces on someone's first
deploy.

Gate and docs only. No package is bumped.
