---
'@drzl/validation-core': major
'@drzl/generator-zod': major
'@drzl/generator-valibot': major
'@drzl/generator-arktype': major
'@drzl/generator-orpc': major
'@drzl/generator-service': major
'@drzl/cli': major
---

**Breaking:** every relative specifier DRZL generates now ends in `.js`, so the generated
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
