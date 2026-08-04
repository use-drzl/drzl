---
'@drzl/cli': patch
---

`drzl --version` and `drzl -V` report the version you actually installed.

Both printed `0.0.1` on every release the CLI has ever had. The registry lists 29 versions of
`@drzl/cli` and 28 of them were wrong, so every version number in every bug report filed against
this CLI has been `0.0.1` and none of them identified anything.

**Where it came from.** `program.version('0.0.1')` in `src/cli.ts`, a literal written when the CLI
was scaffolded. It was accurate for the first publish and for nothing after it. There was no
manifest lookup to go wrong and no bundling involved: the number was simply typed into the source
and left there while `package.json` moved on to `4.14.1`.

**What it does now.** The version comes from the `version` field of the package's own
`package.json`, read at startup from beside the running build. That file is the one the registry
took the version from, so the two cannot disagree, including for anyone running a build from a
branch or a tarball.

Nothing falls back. If the manifest is missing, belongs to another package, or has no `version`,
the CLI throws and names the path it looked at, because a placeholder standing in for a failed
lookup is exactly what made this defect survive 28 releases.

**Verified from an installed tarball**, not from the source tree: `pnpm pack`, `npm install` of the
resulting `.tgz` into an empty directory, then the installed `drzl` binary, which prints `4.14.1`
for `--version` and for `-V`. The published `@drzl/cli@4.14.1` prints `0.0.1` for both.

The bin test in `packages/cli/test/every-entry-loads.spec.ts` ran the built binary throughout and
asserted only that it printed something, which `0.0.1` did. It now asserts equality with the
manifest, for `--version` and `-V`, from the ESM and CommonJS builds alike.

One build change comes with this. `src/version.ts` locates the manifest through `import.meta.url`,
which esbuild rewrites to `undefined` in a CommonJS output while warning `empty-import-meta`. The
new `packages/cli/tsup.config.ts` gives the CommonJS build a real value for it, derived from
`__filename`, rather than silencing the warning: that is the same shape as the
`createRequire(import.meta.url)` defect in `@drzl/validation-core`, and leaving it silenced would
have left the next unguarded use in this package resolving to `undefined` with nothing printed to
say so. The banner repeats `"use strict"` so that the CommonJS bundles stay in strict mode.
