---
'@drzl/cli': major
'@drzl/analyzer': patch
---

Dependencies updated to their latest stable releases.

**Breaking for `@drzl/cli`: Node 22 or newer is now required.** It declared `>=18.17.0`, which had
become untrue: chalk 6 requires `>=22` and chokidar 5 requires `>=20.19`, so installing on Node 18
produced a package whose own dependencies could not run. The other packages keep the lower floor,
since none of them pull those in and raising it would exclude consumers for no reason.

Runtime dependencies: chokidar 4 to 5 (now ESM only), chalk 5 to 6, ora 8 to 9, commander 14 to
15, zod 4.1 to 4.4, jiti 2.5 to 2.7.

Tooling: vitest 3 to 4, eslint 9 to 10, typescript-eslint 8.42 to 8.65, tsup, prettier,
@changesets/cli, @types/node, sharp. GitHub Actions bumped to checkout v7, setup-node v7,
configure-pages v6, deploy-pages v5, upload-pages-artifact v5.

ESLint 10 no longer supports `/* eslint-env */`, and it surfaced a `.eslintrc.cjs` and
`.eslintignore` that had been dead since the flat config was added: ESLint was reading
`eslint.config.js` and linting the stale `.eslintrc.cjs` as an ordinary source file. Both are
removed, `--ext .ts` is dropped from the lint script since flat config does not accept it, and the
flat config is renamed to `eslint.config.mjs` so Node stops reparsing it.

**TypeScript stays on 5.9.** 7.0 is the current `latest`, but it is the native rewrite: it exposes
no `main`, publishes its API under `./unstable/*` subpaths, and `ts.ModuleKind` is simply absent,
so the compiler-API assertions in this repo do not resolve. 6.0 fails too, in tsup's `--dts` step,
which errors on a deprecated `baseUrl` it sets itself and cannot resolve Node's types. Neither is
a defect in this repo and neither is fixable here, so the bump waits for tsup to support them.
