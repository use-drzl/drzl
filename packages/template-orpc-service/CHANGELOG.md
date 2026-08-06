# @drzl/template-orpc-service

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
