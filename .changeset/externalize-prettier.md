---
'@drzl/validation-core': minor
'@drzl/generator-orpc': minor
'@drzl/generator-service': minor
---

Stop shipping prettier inside three packages, and make the CommonJS build format at all

`@drzl/validation-core`, `@drzl/generator-orpc` and `@drzl/generator-service` each published at
about 2.8 MB packed and 11 MB unpacked. All three carried a copy of `formatCode` built on
`await import('prettier')`, which is a specifier tsup resolves statically, so esbuild inlined the
whole formatter behind it: prettier's Flow parser, its TypeScript parser, babel, postcss, yaml and
the rest. Installing `@drzl/cli` pulled in roughly 32 MB of duplicated parsers.

Prettier is now an optional peer dependency, marked external in every build that can reach it.
The two private copies of `formatCode` are gone; both packages use the one exported by
`@drzl/validation-core`, which they already depended on. The three packages now publish at 34 KB,
15 KB and 8 KB packed, and 88 KB, 59 KB and 18 KB unpacked.

**What changes for you.** DRZL formats with the prettier already in your project, using your
config, exactly as before. If your project has no prettier and no biome, generated files are
written as rendered: the same valid TypeScript with worse whitespace, rather than nothing at all.
Add `prettier` as a dev dependency if you want it formatted.

Along the way this fixes formatting for CommonJS consumers, where it never worked. The bundled
prettier in `dist/index.cjs` called `createRequire(import.meta.url)`, and `import.meta.url` is
undefined in a CJS bundle, so the first call threw, the `catch` swallowed it and the code came
back unformatted. Every `require('@drzl/validation-core')` consumer carried 5.5 MB of formatter
that could not run. Resolving the real prettier fixes it.
