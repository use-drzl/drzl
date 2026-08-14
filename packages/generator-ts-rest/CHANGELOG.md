# @drzl/generator-ts-rest

## 0.2.1

### Patch Changes

- 555524a: Point the README documentation links at a host that resolves.

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

## 0.2.0

### Minor Changes

- 61fd360: Add `@drzl/generator-ts-rest`: ts-rest contracts generated from a Drizzle schema, one contract per
  table plus a root router, declared against the schemas a validation generator already writes.

  ts-rest inverts the usual arrangement. There is no router to implement and no handler to stub: a
  contract is a plain object of methods, paths and schemas, and both the server implementation and the
  typed client are derived from it. That makes it the surface where DRZL's output is closest to being
  the whole artefact, because the schemas are the contract.

  The package requires `@ts-rest/core` 3.53.0-rc.0 or newer, which is a release candidate, and that
  floor is measured rather than cautious. `latest` is 3.52.1, and it fails in two separate ways.

  It cannot be installed beside zod 4. 3.52.1 declares `zod: ^3.22.3` as a peer dependency and DRZL's
  zod generator requires `zod >=4.0.0`, so npm refuses the tree outright with
  `ERESOLVE ... Conflicting peer dependency: zod@3.25.76`. For a zod consumer the stable ts-rest is not
  a worse target, it is an uninstallable one.

  With valibot or arktype it is worse, because it is quiet. 3.52.1 decides whether a schema is a schema
  by testing `typeof obj?.safeParse === 'function'`, and anything failing that test falls through to a
  branch returning the input unchanged as a success. valibot and arktype expose `~standard` and have no
  `.safeParse` method, so a contract built from either validates nothing at all while looking exactly
  like one that does. Measured: a body of `{ email: 12345, wat: true }` came back as a success with the
  unknown key intact, against a schema requiring `email` to be a string. 3.53.0-rc.1 adds
  `StandardSchemaV1` to its contract types, drops the zod peer, and validates through
  `~standard.validate`, discriminating on `issues` rather than on the presence of `value`. Both halves
  are pinned as tests against both published versions, so a stable release that fixes either one makes
  this suite say the floor can move.

  TypeBox and Effect Schema are refused for the reason the oRPC generator gives: neither exposes
  `~standard` on the schema object, so the contract would type against `any` and validate nothing.
  Effect consumers have a native surface in `@drzl/generator-effect-http`.

  One defect the compile test caught before it shipped: optionality is not one spelling. zod and
  valibot wrap the value, ArkType marks the key, `type({ 'limit?': 'string.numeric.parse' })`. Emitting
  the value-wrapped form for all three left ArkType's paging required, so every list route demanded a
  `limit` and an `offset`. The probe calls `list({ query: {} })`, which is what found it.

  `@drzl/cli` gains the `ts-rest` kind and the `contractName` and `pathPrefix` options. `pathPrefix` is
  passed to ts-rest's own `c.router(..., { pathPrefix })` rather than written into each path string,
  because ts-rest lifts the prefix into the contract's type: a client derived from the result reports
  the full path, where writing it in by hand would produce the same requests and a different type.
