---
---

Delete the ambient declarations that were switching off type checking across the CLI.

`packages/cli/src/shims.d.ts` declared all twenty-five `@drzl/generator-*` packages as `any`, plus
`cli-progress`. Every one of those generator packages ships a real `dist/index.d.ts`, and an ambient
`declare module` beats a package's own types, so the CLI's entire generator dispatch layer
typechecked as `any`: wrong argument counts, wrong option shapes and renamed exports would all have
passed `pnpm typecheck` in silence.

Measured rather than reasoned about. A deliberately wrong constructor call was put behind
`@ts-expect-error`; with the shims present tsc reported the directive as *unused*, meaning it saw
nothing wrong, and with them removed it honoured the directive. Removing all twenty-five leaves the
monorepo typecheck green and the full test suite passing, so nothing was depending on the looseness.

Three more files went the same way. `packages/analyzer/src/shims.d.ts` and
`packages/generator-orpc/src/shims.d.ts` declared `jiti`, which needs no shim, and the latter also
declared `@drzl/template-standard`; `packages/template-standard/src/shims.d.ts` declared
`@drzl/analyzer`. All three are deleted. `types/orpc-server.d.ts` declared `@orpc/server` as `any`
and was in no tsconfig at all, so it had no effect on anything and is gone with its directory.

What remains in `shims.d.ts` is the one declaration that is load-bearing: `cli-progress`, which ships
no types and has no `@types` package. Emptying the file proves it, with
`TS7016: Could not find a declaration file for module 'cli-progress'`.

No published artefact changes. `src` is not in any package's `files`, so this is repo-internal.
