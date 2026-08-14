---
'@drzl/generator-ai': patch
'@drzl/generator-effect': patch
'@drzl/generator-effect-http': patch
'@drzl/generator-elysia': patch
'@drzl/generator-fast-check': patch
'@drzl/generator-forms': patch
'@drzl/generator-h3': patch
'@drzl/generator-openapi-fetch': patch
'@drzl/generator-pothos': patch
'@drzl/generator-seed': patch
'@drzl/generator-tanstack-start': patch
'@drzl/generator-ts-rest': patch
---

Point the README documentation links at a host that resolves.

Twelve package READMEs linked `https://drzl.dev/generators/<kind>`. That host does not resolve at
all: curl fails to connect rather than returning a status. The site is published at
`https://use-drzl.github.io/drzl/`, which every one of the twelve now uses, and each target was
checked for a 200 before the link was rewritten.

These are the READMEs npm renders on the package page, so the dead link was the "Full documentation"
line a reader follows first. A version bump is the only way a corrected README reaches npm, which is
why a link fix is a release.

The split was along age: the twelve newest packages used `drzl.dev` and the ten older ones used the
working form, so the wrong host was copied forward from one new package to the next.

`@drzl/generator-ts-rest` also carries a version correction. Its source comments, the header it
writes into every emitted contract, and its test docstring all said `@ts-rest/core` 3.53.0-rc.0 or
newer, while `package.json` requires `^3.53.0-rc.1`. Both are now rc.1, which is the version the
package actually pins and tests against. The distinction is real rather than cosmetic: 3.53.0-rc.0
is published and does carry the Standard Schema support this generator depends on, exporting
`isStandardSchema`, `validateAgainstStandardSchema` and `parseAsStandardSchema` and no
`checkZodSchema`. Nothing here has been run against it, so the floor stays at the version the tests
use and the test file now records why.
