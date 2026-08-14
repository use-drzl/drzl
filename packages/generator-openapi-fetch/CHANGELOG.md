# @drzl/generator-openapi-fetch

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

- 8f84105: Add `@drzl/generator-openapi-fetch`, which emits a typed [openapi-fetch](https://openapi-ts.dev/openapi-fetch/)
  client from your Drizzle schema.

  ```ts
  generators: [
    { kind: 'zod', path: './src/validators/zod' },
    { kind: 'openapi-fetch', path: './src/api/client' },
  ];
  ```

  ```ts
  const { data, error } = await client.GET('/users/{id}', { params: { path: { id: 1 } } });
  if (error)
    console.error(error.message); //  typed, because the 404 and 400 are declared
  else console.log(data.email); //             typed from the select schema
  ```

  **The `paths` type is derived from the document DRZL already emits**, by calling the same builder
  `@drzl/generator-json-schema` uses and walking its output rather than deriving the routes a second
  time. A path that exists in one exists in the other by construction, which is the lesson the
  constraint drift report and its SQL emitter recorded.

  The path parameter is the table's real primary key, so an integer key is `number` and a text key is
  `string`, and a table with no primary key gets no single-row path at all. Bodies are the insert,
  update and select types a validation generator already exports.

  **The non-2xx responses are carried, and that is not cosmetic.** Measured against `openapi-fetch`
  0.17.0: on a `paths` declaring only its `200`, `result.error?.message` is a type error because there
  is no shape to read; with the `404` and `400` the document already declares, it is typed and needs
  no cast.

  **The emitted type is not `openapi-typescript`'s, on purpose.** Three shapes were compiled under
  `strict` and `nodenext`, each with canaries for an undeclared path, an undeclared verb, a wrong
  path-parameter type and a missing required parameter. All three type identically, and
  `openapi-typescript`'s own output is 426 lines for a five-path document where the shape emitted here
  is a fraction of that. Nothing about the typing is weaker for it.

  **One limitation is asserted rather than papered over.** An excess body field compiles:
  `{ email: 'a@b.c', nope: 1 }` is accepted while `{ email: 7 }` is refused, because TypeScript's
  excess-property check is lost through openapi-fetch's generic `init` parameter.
  `openapi-typescript`'s output behaves identically, so nothing the generator emits causes it or can
  fix it. The suite asserts the limitation, so a release closing it fails a test and the documentation
  gets corrected rather than quietly going stale.

  Both this generator and `json-schema` read a `document` option and never see each other's config, so
  they have to be given the same value. `validationStatus` is the one that bites: it lands in the
  emitted document and in the client's response keys.

  The package spends this release in `optionalDependencies` of `@drzl/cli`, as every new generator
  does: a package name that has never existed cannot publish through npm's trusted-publisher flow, and
  naming it as a hard dependency in the release that introduces it breaks `npm i @drzl/cli` for
  everyone until the first publish lands.

### Patch Changes

- Updated dependencies [d702af3]
- Updated dependencies [331aa82]
- Updated dependencies [8a1798e]
  - @drzl/validation-core@3.23.0
  - @drzl/analyzer@1.22.0
