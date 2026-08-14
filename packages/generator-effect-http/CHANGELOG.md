# @drzl/generator-effect-http

## 0.1.1

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

## 0.1.0

### Minor Changes

- fb536ae: Add `@drzl/generator-effect-http`: Effect Platform `HttpApi` groups generated from a Drizzle schema,
  one per table, declared against the Effect Schema modules `@drzl/generator-effect` already writes.

  The missing half of a story DRZL half told. The Effect Schema generator has shipped for a while and
  stopped at the schemas, so a project using them had the types and had to hand-write every endpoint
  that carries one. `HttpApiEndpoint.post('create', '/').setPayload(InsertusersSchema)` is a two-line
  wrapper around a schema that already exists, repeated five times per table.

  This is the only DRZL generator with no per-library choice, because `HttpApi` declares its payloads
  as Effect Schema and takes nothing else. A config naming another library is refused by the generator
  and reported by the config parser rather than silently overridden.

  Two details the emitted code gets right that a hand-writer often does not. A path parameter is a
  string, so a numeric key is declared `Schema.NumberFromString` rather than `Schema.Number`, which
  refuses every request; Effect names that conversion cleanly where zod and valibot need a regex and a
  transform, but the mistake underneath is the one the Hono generator measured first. And `delete` is
  a reserved word, so the endpoint is `HttpApiEndpoint.del('delete', ...)` bound to a local called
  `remove`: a property name may be a reserved word and a variable name may not, which is a syntax
  error the first draft of this generator shipped and the compile test caught.

  The barrel chains every group into one `HttpApi`, which is what lets `HttpApiClient.make` derive a
  client that knows every endpoint. Written as separate statements it would compile, run identically,
  and describe an API with no groups on it. That is what the package's main test asserts: it derives a
  client and calls an endpoint by name, and its canary calls one that should not exist on a keyless
  table.

  `@drzl/cli` gains the `effect-http` kind and the `apiName` option. `pnpm-workspace.yaml` gains an
  `allowBuilds` entry for `msgpackr-extract`, which arrives under `@effect/platform`: it is an optional
  native accelerator for msgpackr, which falls back to its JavaScript path without it, so it is set to
  `false` rather than compiled.
