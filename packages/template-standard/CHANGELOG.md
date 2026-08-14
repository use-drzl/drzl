# @drzl/template-standard

## 2.9.3

### Patch Changes

- a0ba795: Drop the unused `@drzl/analyzer` dependency.

  It was the package's only dependency and it was never imported. `src/index.ts` has no imports at all:
  a template hands back oRPC source text as strings, and the one place the analyzer is mentioned is a
  comment explaining what a caller passes in, with the fields it reads declared locally so a hand-built
  object works too.

  It was invisible because `src/shims.d.ts` declared `@drzl/analyzer` as `any`, so nothing ever
  resolved the real package and nothing ever noticed the import was missing. That shim is gone as well,
  along with three others that were switching off type checking elsewhere.

  Anyone installing `@drzl/template-standard` now installs one package instead of two.

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
  - @drzl/analyzer@1.21.1

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

- Updated dependencies [cf19c30]
- Updated dependencies [c56125f]
- Updated dependencies [2c8b20b]
- Updated dependencies [02fc84a]
  - @drzl/analyzer@1.21.0

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

- Updated dependencies [8cc4de8]
- Updated dependencies [f019b03]
  - @drzl/analyzer@1.18.0

## 2.2.0

### Minor Changes

- 839cd23: Generated oRPC routers now compile. They did not, with any built-in template, for as long as the
  package has existed.

  `create` and `update` declared `.output(SelectSchema)` and then returned the input. The input is
  the _insert_ shape, where generated and defaulted columns are optional, while select requires
  them, so `tsc --strict` rejected every generated router: three errors on a two-table schema. It
  went unnoticed because nothing ever compiled the output.

  Returning the input was not merely mistyped, it was the wrong answer. A created row carries
  generated columns the input never had, so no cast would have made it correct. Both stubs now
  throw a `Not implemented` error naming the table and what to do. That satisfies the declared
  contract, since a body which only throws has type `never`, and an unimplemented endpoint now
  fails loudly instead of silently returning a malformed object.

  `list`, `get` and `delete` are unchanged: `[]`, `null` and `true` are each a truthful value of
  the declared output type. `@drzl/template-orpc-service` is also unchanged, because it delegates
  to a service layer and already returns the select shape; the fix belongs in the stub templates,
  not in the generator, which must never rewrite a real implementation.

  **If you have generated routers and filled in the handlers, nothing changes.** If you were
  relying on the stub bodies, `create` and `update` now throw rather than echoing the input back.

  Also fixes `@drzl/cli` never passing `servicesDir` to the oRPC generator. The option is declared
  on the generator and read by `@drzl/template-orpc-service`, which fell back to `src/services`
  whatever the service generator was configured to use. Pairing that template with, say,
  `{ kind: 'service', path: './src/api/services' }` emitted a router importing a module that was
  never created. The CLI now passes the service generator's actual path.

## 1.1.0

### Minor Changes

- c48d79a: sponsor initiatives

### Patch Changes

- Updated dependencies [c48d79a]
  - @drzl/analyzer@1.2.0

## 1.0.0

### Major Changes

- 5da6f6b: support MySQL, SingleStore, and Gel; expand Postgres/SQLite; add tests (fixes #13)

### Patch Changes

- Updated dependencies [5da6f6b]
  - @drzl/analyzer@1.0.0

## 0.3.0

### Patch Changes

- @drzl/analyzer@0.3.0

## 0.2.0

### Patch Changes

- @drzl/analyzer@0.2.0

## 0.1.0

### Patch Changes

- @drzl/analyzer@0.1.0

## 0.0.3

### Patch Changes

- @drzl/analyzer@0.0.3

## 0.0.2

### Patch Changes

- @drzl/analyzer@0.0.2

## 0.0.1

### Patch Changes

- @drzl/analyzer@0.0.1
