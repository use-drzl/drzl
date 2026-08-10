# @drzl/template-orpc-service

## 2.9.1

### Patch Changes

- acef357: Fix a dead link that shipped in every one of these READMEs. They pointed at
  `docs/sponsor.md`, and only `dist` is listed in `files`, so on npm that path resolves to nothing.
  They now point at https://use-drzl.github.io/drzl/sponsor, which answers 200. npm publishes README
  regardless of `files`, which is what makes this a change to the published artifact rather than a
  repository-only edit.

  The CLI README additionally listed four of its eight commands, omitting `doctor` and `explain`
  despite both having their own documentation pages, and did not say that all fourteen generators
  arrive with the CLI so no separate install is needed.

- Updated dependencies [acef357]
  - @drzl/validation-core@3.22.1

## 2.9.0

### Patch Changes

- e7e39a5: oRPC addressing inputs and handler bodies are typed from the primary key instead of a hardcoded `{ id: z.number() }`

  Every emitted `get`/`update`/`delete` input spelled `{ id: z.number() }` whatever the primary
  key was, at two layers: the generator's input rewrite (in all three validation libraries, and
  in the cross-table relation lookups), and both template packages' own procedure code, where
  `@drzl/template-orpc-service` called `Service.getById(input.id)` through it. Measured on pg
  books/composite/keyless beside the post-BP services: exactly 9 tsc errors confined to the
  routers (3x TS2345 number-into-varchar on books, 3x TS2554 arity on a composite key, 3x TS2339
  on a keyless table whose service correctly no longer has the methods).

  The key is now read the way `@drzl/generator-service` and the tRPC generator read it: every
  column of `primaryKey`, at its real type, in the configured library's spelling
  (`{ isbn: z.string() }`, `v.object({ isbn: v.string() })`, `type({ isbn: 'string' })`, an enum
  key's literals). A composite key keeps all of its columns, in key order, and the service
  template composes the call as one argument per key column
  (`Service.getById(input.orgId, input.userId)`). Update inputs are the same key beside the
  patch. A table with no primary key emits `list` and `create` only, drops the relation lookups
  that would take its key, and stops importing a shared update schema nothing references. A key
  column DRZL cannot type arrives as the library's `unknown`; the service template stubs those
  procedures with a note naming the column, because `unknown` is not assignable to the service's
  typed key parameter. Templates cannot reintroduce the defect: the generator rewrites every
  template's addressing inputs and drops keyless addressing procedures whatever the template
  emitted.

  Integer-key emissions are byte-identical to before, proved by running the previous build beside
  this one over the same analyses (43 configurations across templates, libraries, relations,
  shared validation, injection and naming: 172 file pairs, zero diffs; in the natural-key grid
  the 45 files that differ are exactly the natural, composite, keyless, untypeable and enum-key
  routers). This also restores the pairing BP left red: stub-mode services + oRPC on natural keys
  now compile, because the typed stubs and the routers finally agree. Red-first: the 9 measured
  errors reproduced against a real typed PgDatabase, 0 after; a real oRPC `call` round-trip
  addresses a natural-key row and a composite row end to end, and the old `{ id: 1 }` payload is
  now the one that fails validation.

- Updated dependencies [c56125f]
- Updated dependencies [28787ff]
- Updated dependencies [062f305]
- Updated dependencies [4801464]
- Updated dependencies [02fc84a]
  - @drzl/validation-core@3.22.0

## 2.8.0

### Minor Changes

- f019b03: `require('@drzl/…')` now reaches the CommonJS build, which is what these packages have been
  shipping and could not deliver.

  Every one of these packages built a `dist/index.cjs` and then published a manifest that could not
  name it. Ten had no `exports` map at all, so `require('@drzl/generator-zod')` fell through to
  `main`, which pointed at `dist/index.js` beside `"type": "module"`: an ES module. On Node 20.19 and
  Node 22.12 and later, `require()` loads one anyway, so it worked and the `.cjs` sat unused. Below
  those two versions it threw, against an `engines.node` of `>=18.17.0`:

  ```
  ERR_REQUIRE_ESM: require() of ES Module
    /app/node_modules/@drzl/generator-zod/dist/index.js from /app/probe.cjs not supported.
  ```

  Measured on a real install of the packed tarballs: broken on node 18.20.8, 20.18.3 and 22.11.0,
  working on 20.19.6, 22.22.0 and 24.19.0. The ESM half was never affected, and a Node 18 consumer who
  used `import` got correct output from all seven generators, which is why the floor stays at
  `>=18.17.0` rather than being raised: the packages really do run there, and the manifest was what
  was wrong.

  Each package now declares both entries:

  ```json
  "exports": {
    ".": {
      "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
      "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
    }
  }
  ```

  `@drzl/analyzer` was the one package whose `require` condition already named its `.cjs`, so it
  loaded. Its single shared `types` still handed a CommonJS consumer the ESM declarations, and
  `tsc --moduleResolution node16` rejected that with TS1479. It gets the same nested shape.

  **What can break.** These are minors rather than patches for two reasons, both about consumers
  doing something no DRZL documentation shows.

  An `exports` map is a gate: `@drzl/validation-core/dist/index.js` and any other path inside the
  package used to be importable and no longer is. Only the package root is a supported entry, and now
  that is enforced rather than merely intended.

  `main` moves from `dist/index.js` to `dist/index.cjs`, so a bundler old enough to ignore `exports`
  now picks up the CommonJS build. A `module` field pointing at `dist/index.js` is published beside
  it, which is what every bundler that predates `exports` reads first, so this only changes what the
  few that read neither would resolve.

  A consumer on Node 20.19 or newer who already used `require` gets the CommonJS bundle where they
  previously got the ES module through Node's interop. The named exports and `default` are the same
  either way, and `__esModule` is still true.

### Patch Changes

- Updated dependencies [b14cbed]
- Updated dependencies [f019b03]
  - @drzl/validation-core@3.16.0

## 2.3.2

### Patch Changes

- Updated dependencies [b0543a4]
  - @drzl/validation-core@3.0.0

## 2.3.0

### Minor Changes

- b8b44ec: Two defects in generated output that stopped it resolving or typechecking, both found by running
  the published packages rather than the workspace.

  **The service import was not a usable specifier.** `@drzl/template-orpc-service` built it by
  hand and got two things wrong at once:

      import { PostService } from "services/postService";       // before
      import { PostService } from "./services/postService.js";  // after

  `path.relative` returns a bare `services` whenever the services directory sits inside the
  router's output directory, and a specifier without a leading `./` is a _bare_ specifier: Node
  looks for a package of that name in node_modules and never considers the file next door. It also
  carried no extension, making it the one relative import DRZL emitted that failed under
  `moduleResolution: node16` and `nodenext`, despite 2.0.0 stating that every relative specifier
  now ends in `.js`. It goes through `importSpecifier` now, the same helper the router barrel uses,
  so it honours `importExtension` like everything else. `@drzl/generator-orpc` also now passes
  `importExtension` into the template context, which it previously had no way to see.

  **Service types rejected `null` for nullable columns.** A nullable column was emitted as
  optional, which admits `undefined` and not `null`:

      balance?: number          // before
      balance: number | null    // after, in Select
      balance?: number | null   // after, in Insert and Update

  Optional and nullable are different: `foo?: T` means the key may be absent, `foo: T | null` means
  it is present and may be null. So a row read back with a real `null` did not match `Select`, and
  passing `null` to update was a type error, while the validation generators emitted
  `z.number().nullable()` for the same column. Both halves of one generated project disagreed about
  the same database. `Select` no longer marks anything optional either: a row read back carries
  every column, whatever its default.

  Both were invisible because `scripts/verify-packed.sh` ran the oRPC generator with the default
  template, which imports nothing DRZL generated and never touches the service types. It now uses
  `@drzl/template-orpc-service`, so every generated module is imported and typechecked by another.

## 1.1.0

### Minor Changes

- c48d79a: sponsor initiatives

## 1.0.0

### Major Changes

- 5da6f6b: support MySQL, SingleStore, and Gel; expand Postgres/SQLite; add tests (fixes #13)

## 0.4.0

### Minor Changes

- 811dd61: feat: strict database injection for services and oRPC middleware (typed db context; valibot v1 compatibility)

## 0.3.0

## 0.2.0

## 0.1.0

## 0.0.3

## 0.0.2

## 0.0.1
