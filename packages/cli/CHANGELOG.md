# @drzl/cli

## 2.0.0

### Major Changes

- 6903012: **Breaking:** every relative specifier DRZL generates now ends in `.js`, so the generated
  tree compiles under `moduleResolution: node16` and `nodenext`.

  ### What you will see

  Regenerate and the specifiers gain an extension. Nothing else about the output changes, and
  no file is renamed:

  ```diff
    // src/validators/zod/index.ts
  - export * from './users.zod';
  + export * from './users.zod.js';

    // src/api/index.ts
  - import { users } from './users';
  + import { users } from './users.js';

    // src/services/userService.ts
  - import type { Insertusers, Updateusers, Selectusers } from './types/users';
  + import type { Insertusers, Updateusers, Selectusers } from './types/users.js';
  ```

  If your build already worked, it still works: `./users.zod.js` resolves to `users.zod.ts`
  under `bundler` and `node10` exactly as the extensionless form did, and it is what Vite,
  esbuild, Rollup, Bun, Vitest and Next.js expect. It will show up in your next diff, and it
  is a good idea to regenerate in one commit of its own.

  ### Why

  Generated files land in your own source tree, so your `tsconfig.json` decides which
  specifiers resolve. Measured against tsc 5.9.2 and 7.0.2, for a specifier naming a sibling
  `.ts` file:

  | specifier        | `bundler` | `node10` | `node16`/`nodenext`, CommonJS | `node16`/`nodenext`, ESM |
  | ---------------- | --------- | -------- | ----------------------------- | ------------------------ |
  | `./users.zod.js` | resolves  | resolves | resolves                      | resolves                 |
  | `./users.zod`    | resolves  | resolves | resolves                      | **does not resolve**     |

  The extensionless form DRZL emitted before this release cannot be imported from an ES module
  under `node16` or `nodenext`. `tsc` reports `TS2307: Cannot find module './users.zod'` on the
  barrel and the build stops, and that was true of the default `fileSuffix`, not only of custom
  ones. That combination is now the common one: `tsc --init` has emitted `"module": "nodenext"`
  since TypeScript 5.9, every `@tsconfig/node*` base sets `"moduleResolution": "node16"`, and
  TypeScript 7 removed `node10` altogether, leaving `bundler`, `node16` and `nodenext` as the
  only three settings that exist.

  ### If `.js` is wrong for you

  Set `importExtension`, at the top level for every generator or on a single generator to
  override it:

  ```ts
  export default defineConfig({
    schema: 'src/db/schema.ts',
    importExtension: 'none', // 'js' (default) | 'none' | 'ts'
    generators: [{ kind: 'zod', path: 'src/validators/zod' }],
  });
  ```

  - `'none'` restores the pre-2.0 output byte for byte. Use it if your pipeline cannot map
    `.js` back to `.ts`: webpack without `resolve.extensionAlias`, or Jest with `ts-jest` and
    no `moduleNameMapper`.
  - `'ts'` emits `./users.zod.ts`, which needs `"allowImportingTsExtensions": true`. It is the
    only form Node's own type stripping accepts, so it suits running the generated `.ts`
    unbuilt.

  `importExtension` only touches specifiers DRZL invents. Paths you write yourself are still
  emitted verbatim, so on `node16`/`nodenext` in an ES module an `orpc` generator's
  `validation.importPath` has to name the barrel file rather than its directory
  (`'../validators/zod/index.js'`, not `'../validators/zod'`), and the `service` generator's
  `dbImportPath` and `schemaImportPath` need their own `.js`.

  `@drzl/validation-core` exports `ImportExtension`, `DEFAULT_IMPORT_EXTENSION`,
  `IMPORT_EXTENSIONS` and `importSpecifier`, and `moduleSpecifier` takes the extension as a
  third argument, so the five generators cannot disagree about how a module is spelled.
  `@drzl/generator-service` gains a dependency on `@drzl/validation-core` for that reason.

### Minor Changes

- 2f9214e: Add `affix`, so generated identifiers are not stuck on `Insert<Table>Schema`.

  Resolves #16. Set `affix` on a `zod`, `valibot` or `arktype` generator to choose
  the prefix and suffix of the exported schema constants and of the type aliases,
  separately, and either as one string for all three modes or per mode:

  ```ts
  {
    kind: 'zod',
    path: 'src/validators/zod',
    affix: {
      tableCase: 'pascal',
      schema: { suffix: 'Schema' },
      type: {
        prefix: { insert: 'Create', update: 'Edit', select: '' },
        suffix: { insert: 'Input', update: 'Input', select: '' },
      },
    },
  }
  ```

  which emits `InsertUsersSchema`, `CreateUsersInput`, `EditUsersInput` and a bare
  `Users` instead of `InsertusersSchema` and `SelectusersOutput`.

  `tableCase` addresses the second half of that issue. Generated identifiers
  interpolate the Drizzle export name exactly as written, so a table exported as
  `users` produces `Insertusers`. `tableCase: 'pascal'` upper-camels it first,
  splitting on `_`, `-` and camel boundaries, so `user_profiles` and `userProfiles`
  both give `InsertUserProfilesSchema`. The default is `preserve`, which keeps the
  existing behaviour; changing the default is a major-version decision.

  Naming now comes from one resolver in `@drzl/validation-core`
  (`resolveAffix`, `schemaName`, `typeName`, `validateAffix`, `pascalCase`) instead of
  template literals repeated in four packages, which is what lets both sides of an
  import agree. When an `orpc` generator uses `validation.useShared` and exactly one
  sibling generator produces that library, the sibling's `affix` is copied onto it,
  so the router imports the names the validation generator actually exported.
  A `validation.affix` that is set explicitly and disagrees with that sibling now
  fails the run, listing both sets of names, rather than writing a router that does
  not compile.

  Configs are checked before anything is written: an affix that could not appear in
  a TypeScript identifier, or that would put two same-named exports in one file, is
  rejected with the path to the offending option.

  Nothing changes for existing configs. Omitting `affix` reproduces the previous
  output byte for byte, `schemaSuffix` still works and is the default for
  `affix.schema.suffix`, and affixes rename identifiers only, never files or module
  specifiers.

- 549ee51: Type `numeric` and `decimal` columns as strings, matching what Drizzle returns.

  Generated validators previously typed them as numbers, so a select schema
  rejected every row the database returned ("expected number, received string"),
  and an insert schema rejected the string the driver wants while accepting a
  number it does not.

  `bigint({ mode: 'number' })` is now read as a number rather than a bigint, and
  `real`/`doublePrecision` are separated from `numeric` since those really are
  JS numbers.

  If you were working around the old behaviour by coercing numeric values, that
  workaround should be removed.

### Patch Changes

- Updated dependencies [2f9214e]
- Updated dependencies [6034a24]
- Updated dependencies [6903012]
- Updated dependencies [549ee51]
- Updated dependencies [20a5b9d]
  - @drzl/validation-core@2.0.0
  - @drzl/generator-zod@2.0.0
  - @drzl/generator-valibot@2.0.0
  - @drzl/generator-arktype@2.0.0
  - @drzl/generator-orpc@2.0.0
  - @drzl/generator-service@2.0.0
  - @drzl/analyzer@1.3.0

## 1.1.0

### Minor Changes

- c48d79a: sponsor initiatives

### Patch Changes

- Updated dependencies [c48d79a]
  - @drzl/generator-arktype@1.2.0
  - @drzl/generator-service@1.1.0
  - @drzl/generator-valibot@1.1.0
  - @drzl/generator-orpc@1.1.0
  - @drzl/generator-zod@1.1.0
  - @drzl/analyzer@1.2.0

## 1.0.0

### Major Changes

- 5da6f6b: support MySQL, SingleStore, and Gel; expand Postgres/SQLite; add tests (fixes #13)

### Patch Changes

- Updated dependencies [5da6f6b]
  - @drzl/analyzer@1.0.0
  - @drzl/generator-arktype@1.0.0
  - @drzl/generator-orpc@1.0.0
  - @drzl/generator-service@1.0.0
  - @drzl/generator-valibot@1.0.0
  - @drzl/generator-zod@1.0.0

## 0.3.1

### Patch Changes

- Updated dependencies [811dd61]
  - @drzl/generator-service@0.4.0
  - @drzl/generator-orpc@0.4.0

## 0.3.0

### Minor Changes

- b2b8e35: fix(cli-config): improve watch and config loading

### Patch Changes

- @drzl/analyzer@0.3.0
- @drzl/generator-arktype@0.3.0
- @drzl/generator-orpc@0.3.0
- @drzl/generator-service@0.3.0
- @drzl/generator-valibot@0.3.0
- @drzl/generator-zod@0.3.0

## 0.2.0

### Minor Changes

- f007329: fix(cli): correct config types and update readme

### Patch Changes

- @drzl/analyzer@0.2.0
- @drzl/generator-arktype@0.2.0
- @drzl/generator-orpc@0.2.0
- @drzl/generator-service@0.2.0
- @drzl/generator-valibot@0.2.0
- @drzl/generator-zod@0.2.0

## 0.1.0

### Minor Changes

- 250f5fd: Ensure @drzl/cli builds and exports its config module so consumers can import it directly.

### Patch Changes

- @drzl/analyzer@0.1.0
- @drzl/generator-arktype@0.1.0
- @drzl/generator-orpc@0.1.0
- @drzl/generator-service@0.1.0
- @drzl/generator-valibot@0.1.0
- @drzl/generator-zod@0.1.0

## 0.0.3

### Patch Changes

- 4227090: Fix missing generator dependencies and improve error messages
  - Add all generator packages (@drzl/generator-zod, @drzl/generator-service, @drzl/generator-valibot, @drzl/generator-arktype) as dependencies in CLI package.json
  - Update error handling to provide clearer installation instructions when generators are missing
  - Separate error details for better readability

  This resolves the "Cannot find package" errors when using generators other than ORPC.
  - @drzl/analyzer@0.0.3
  - @drzl/generator-arktype@0.0.3
  - @drzl/generator-orpc@0.0.3
  - @drzl/generator-service@0.0.3
  - @drzl/generator-valibot@0.0.3
  - @drzl/generator-zod@0.0.3

## 0.0.2

### Patch Changes

- Fix missing generator dependencies and improve error messages
  - Add all generator packages (@drzl/generator-zod, @drzl/generator-service, @drzl/generator-valibot, @drzl/generator-arktype) as dependencies in CLI package.json
  - Update error handling to provide clearer installation instructions when generators are missing
  - Separate error details for better readability

  This resolves the "Cannot find package" errors when using generators other than ORPC.
  - @drzl/analyzer@0.0.2
  - @drzl/generator-arktype@0.0.2
  - @drzl/generator-orpc@0.0.2
  - @drzl/generator-service@0.0.2
  - @drzl/generator-valibot@0.0.2
  - @drzl/generator-zod@0.0.2

## 0.0.1

### Patch Changes

- 6130ad2: Initial public release setup: lockstep versioning, CI publish, and branding.
  - @drzl/analyzer@0.0.1
  - @drzl/generator-orpc@0.0.1
