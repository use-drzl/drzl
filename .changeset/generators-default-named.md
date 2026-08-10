---
'@drzl/cli': patch
---

A run that falls back to the default `generators` says so

`generators` defaults to `[{ kind: 'orpc' }]`, so the smallest config that parses writes a whole
oRPC router tree. Someone who came for validation schemas and wrote `{ schema: './db.ts' }` got an
API surface, with nothing in the output naming where it came from.

The default is now named where it applies, with the choices beside it: which kinds emit validation
schemas, which emit an API surface, and which emits typed data-access stubs. Writing the key out
silences it, even when the value written is the same one.

Deliberately a warning rather than a change. Both ways of removing the surprise, requiring the key
or defaulting to `zod`, change what an existing config does, and that belongs with a major rather
than a patch. The silence does not have to wait for one.
