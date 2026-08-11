# @drzl/generator-ts-rest

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
