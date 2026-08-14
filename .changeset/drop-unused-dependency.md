---
'@drzl/template-standard': patch
---

Drop the unused `@drzl/analyzer` dependency.

It was the package's only dependency and it was never imported. `src/index.ts` has no imports at all:
a template hands back oRPC source text as strings, and the one place the analyzer is mentioned is a
comment explaining what a caller passes in, with the fields it reads declared locally so a hand-built
object works too.

It was invisible because `src/shims.d.ts` declared `@drzl/analyzer` as `any`, so nothing ever
resolved the real package and nothing ever noticed the import was missing. That shim is gone as well,
along with three others that were switching off type checking elsewhere.

Anyone installing `@drzl/template-standard` now installs one package instead of two.
