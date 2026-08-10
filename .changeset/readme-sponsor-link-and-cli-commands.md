---
'@drzl/analyzer': patch
'@drzl/cli': patch
'@drzl/generator-arktype': patch
'@drzl/generator-effect': patch
'@drzl/generator-json-schema': patch
'@drzl/generator-orpc': patch
'@drzl/generator-service': patch
'@drzl/generator-typebox': patch
'@drzl/generator-valibot': patch
'@drzl/generator-zod': patch
'@drzl/template-orpc-service': patch
'@drzl/template-standard': patch
'@drzl/validation-core': patch
---

Fix a dead link that shipped in every one of these READMEs. They pointed at
`docs/sponsor.md`, and only `dist` is listed in `files`, so on npm that path resolves to nothing.
They now point at https://use-drzl.github.io/drzl/sponsor, which answers 200. npm publishes README
regardless of `files`, which is what makes this a change to the published artifact rather than a
repository-only edit.

The CLI README additionally listed four of its eight commands, omitting `doctor` and `explain`
despite both having their own documentation pages, and did not say that all fourteen generators
arrive with the CLI so no separate install is needed.
