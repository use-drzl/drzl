# Edge runtimes

Cloudflare Workers, D1 and Turso are first-class Drizzle targets, and the code DRZL emits runs on
them unchanged. That is asserted by the gate rather than assumed.

## What is checked

A Worker has no Node builtins. An `import 'node:crypto'` there is a deploy-time failure, not a
runtime one, so it is not something your own tests would catch either: it surfaces the first time
you push.

Every run of `verify-packed.sh` scans the whole emitted tree and fails if any file imports a Node
builtin, by its `node:` spelling or its bare name. The scan covers every generator kind the consumer
fixture runs, and it refuses to pass on an empty tree, because a grep over nothing succeeds exactly
as loudly as a grep over something clean. It also plants a file that does import one and checks the
pattern catches it, so a broken expression cannot pass by matching nothing.

## What is not checked, and why

The generators themselves import `node:path` and `node:fs` freely, and must. They run at build time
on Node, alongside `drizzle-kit`. What has to be portable is the text they write, which is what the
gate looks at.

`nodejs_compat` exists and many Workers projects enable it. The emitted output is still held to the
stricter bar, because a generator has no way to know whether a given consumer turned it on, and
emitting something that needs a flag nobody asked for is a requirement that surfaces on someone's
first deploy rather than in their editor.

## Bun and Deno

Both are covered separately, by `scripts/runtime-compat.sh`, which runs as its own CI job. It packs
the built packages, installs them into a throwaway app and runs the CLI and the emitted schemas under
each runtime.

That gate exists because of a real disagreement rather than for completeness: Bun's resolver answers
a missing package by installing it from npm, so `@biomejs/biome` was auto-installed mid-generate and
reformatted the output on a project that had never depended on it. `drzl generate --check` under
Node then called every file out of date. Nothing else in CI would have noticed.
