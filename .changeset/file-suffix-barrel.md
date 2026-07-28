---
'@drzl/validation-core': minor
'@drzl/generator-zod': patch
'@drzl/generator-valibot': patch
'@drzl/generator-arktype': patch
---

Make the generated barrel follow `fileSuffix` instead of the default suffix.

The zod, valibot and arktype generators named each emitted file from `fileSuffix` but wrote
the barrel with the default suffix hardcoded, so any custom value produced an `index.ts`
full of imports that pointed at nothing:

```ts
// drzl.config.ts
{ kind: 'zod', path: 'src/validators/zod', fileSuffix: '.schema.ts' }
```

```ts
// src/validators/zod/index.ts, next to users.schema.ts and posts.schema.ts
export * from './users.zod'; // TS2307: Cannot find module './users.zod'
export * from './posts.zod';
```

The consumer's build failed on the unresolved imports, and so did anything importing the
barrel, including an `orpc` generator pointed at it through `validation.importPath`. The
only `fileSuffix` that worked was the default one. Both halves now come from the same
value, so the barrel renames along with the files.

Suffixes that are not simply `.<name>.ts` are handled too. A suffix with no leading dot
runs straight onto the table name (`Schema.ts` gives `usersSchema.ts` and
`./usersSchema.js`), a suffix that is only an extension leaves the bare table name (`.ts`
gives `users.ts` and `./users.js`), and `.mts` and `.cts` are written as `.mjs` and `.cjs`,
which is the only form TypeScript resolves for them.

Leaving `fileSuffix` unset no longer reproduces the pre-2.0 barrel byte for byte, but that
is down to the separate `importExtension` change in this same release, which puts a `.js` on
every specifier DRZL generates. Set `importExtension: 'none'` and the default output is what
it always was.

`@drzl/validation-core` exports the two helpers the generators share, `moduleFileName` and
`moduleSpecifier`, so the file name and the import specifier cannot drift apart again.
