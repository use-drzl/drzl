# Ten packages ship a `dist/index.cjs` that cannot be required below Node 22.12

Addendum A. Branch `fix/unreachable-cjs`. Status: fixed, with the fix verified against real Node
18, 20.18, 20.19, 22.11, 22.22 and 24 on a real npm install of the packed tarballs.

## What was actually wrong

Not what the filing guessed. The filing expected "a CJS bundle whose transitive import is ESM".
That is real and it is the second layer, but it is not the layer a consumer hits first.

The first layer is resolution. Ten packages had no `exports` map at all, so
`require('@drzl/generator-zod')` fell through to `main`, which said `dist/index.js` beside
`"type": "module"`. Node resolved the **ES module**. The `dist/index.cjs` sitting beside it was
never the file that answered, on any Node version, ever. It was published dead weight from the day
each package was first released.

```
FAIL  @drzl/generator-zod  ERR_REQUIRE_ESM: require() of ES Module
      /tmp/app/node_modules/@drzl/generator-zod/dist/index.js from /tmp/app/probe.cjs not supported.
```

The transitive layer is underneath it and only becomes visible once you reach past the manifest by
file path. `require('@drzl/generator-zod/dist/index.cjs')` on node:18 failed too, at
`require("@drzl/validation-core")` inside the bundle, for exactly the same reason one level down.
So fixing a leaf package alone would have fixed nothing: `@drzl/validation-core` had to gain a
`require` condition or every generator's CJS bundle would still break on its first sibling call.

Both layers are one root cause. Every DRZL package is `"type": "module"` with an ESM `main` and no
`exports` map, so no `require` anywhere in the graph could reach CommonJS.

## Measurement, before the fix

Packed all twelve publishable packages with `pnpm pack`, installed the tarballs with `npm install`
into an empty project inside a stock `node:<tag>` container, and required each by package name from
a `.cjs` file.

| Node | require by package name |
| --- | --- |
| 18.20.8 | 10 of 11 fail, ERR_REQUIRE_ESM |
| 20.18.3 | 10 of 11 fail, ERR_REQUIRE_ESM |
| 20.19.6 | all 11 load |
| 22.11.0 | 10 of 11 fail, ERR_REQUIRE_ESM |
| 22.22.0 | all 11 load |
| 24.19.0 | all 11 load |

The boundary is **two** versions, not one. `require(esm)` was backported to 20.19.0 as well as
landing in 22.12.0, so the broken windows were `<20.19.0` and `22.0.0 – 22.11.x`. The filing named
only 22.12.

The ten, all of which declared `engines.node: ">=18.17.0"`:

`@drzl/generator-arktype`, `@drzl/generator-json-schema`, `@drzl/generator-orpc`,
`@drzl/generator-service`, `@drzl/generator-typebox`, `@drzl/generator-valibot`,
`@drzl/generator-zod`, `@drzl/template-orpc-service`, `@drzl/template-standard`,
`@drzl/validation-core`.

The eleventh, `@drzl/analyzer`, was the only one with an `exports` map naming its `.cjs`, and it
loaded on node:18. Its own defect was in the type system rather than the runtime; see below.

Reaching past the manifest, on node:18.20.8:

| deep path `@drzl/X/dist/index.cjs` | result |
| --- | --- |
| analyzer | ERR_PACKAGE_PATH_NOT_EXPORTED (its `exports` map gates subpaths) |
| the 8 generators and template-orpc-service | ERR_REQUIRE_ESM at `require("@drzl/validation-core")` |
| template-standard, validation-core | loads (neither requires a `@drzl` sibling) |

## Which resolution, and why

Two honest options. **Make the CJS build work below the declared floor**, or **raise
`engines.node`**. The deciding evidence is whether the packages actually run on Node 18 by the path
that does work.

They do. On node:18.20.8, with the tarballs installed by npm, an ESM consumer analysed a real
Drizzle SQLite schema and ran every one of the seven generators:

```
node v18.20.8 (ESM, end to end)
  analyze -> 2 table(s): posts, users
  zod -> 3 file(s)      valibot -> 3 file(s)    arktype -> 3 file(s)
  typebox -> 3 file(s)  json-schema -> 3 file(s)
  service -> 3 file(s)  orpc -> 3 file(s)
ESM path works on this runtime
```

So `>=18.17.0` was not an aspirational floor that the code had outgrown. It was accurate for
`import` and wrong only for `require`. Raising it would have withdrawn support from a runtime the
library demonstrably serves, in order to paper over a manifest that was simply incomplete. **Fix
the manifests. Keep the floor.**

The counter-argument, which I weighed and rejected: Node 18 went EOL 2025-04-30 and Node 20 on
2026-04-30, so today's floor claims two dead lines. That is an argument for a deliberate,
separately-reasoned deprecation, not for shipping a fix whose side effect is dropping them. If the
project wants the floor raised, that decision should be made on its own merits and announced;
it should not arrive as the consequence of a packaging bug.

## The fix

One shape, applied to all eleven library manifests:

```json
"main": "./dist/index.cjs",
"module": "./dist/index.js",
"types": "./dist/index.d.ts",
"exports": {
  ".": {
    "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
  }
}
```

No build change and no source change. Every file this now names was already being built and
published; `files: ["dist"]` shipped all of it. No new file enters any tarball, only a longer
manifest.

`main` moves to the `.cjs` so a resolver that ignores `exports` also gets something requireable,
and `module` is added so a bundler that predates `exports` still prefers the ESM build.

### `@drzl/analyzer`, found while verifying

The analyzer already had a working `require` condition, so it was outside the filing. Typechecking
a CommonJS consumer against the tarballs found the same defect one layer up:

```
--- moduleResolution=node16 (src/esm.mts src/cjs.cts)
src/cjs.cts(1,32): error TS1479: The current file is a CommonJS module whose imports will produce
'require' calls; however, the referenced file is an ECMAScript module and cannot be imported with
'require'. Consider writing a dynamic 'import("@drzl/analyzer")' call instead.
```

Its map had one flat `types` shared by both conditions, pointing at `dist/index.d.ts`, which
belongs to a `"type": "module"` package. Under `moduleResolution: node16` TypeScript follows the
`require` condition and then refuses those declarations. It gets the same nested shape as the other
ten, and the `.d.cts` it needs was already in the tarball.

Worth noting for anyone auditing this later: `nodenext` does **not** report TS1479 here, because
TypeScript 5 models `require(esm)` there. Only the `node16` leg sees it. A sweep that ran the newer
setting alone would have called this clean.

After the fix, from both a `.cts` and an `.mts` consumer against the packed tarballs:

```
--- moduleResolution=node16     ok
--- moduleResolution=nodenext   ok
--- moduleResolution=bundler    ok
--- moduleResolution=node10     ok
```

## Proof the fix works, on real runtimes

A CommonJS consumer, npm-installed tarballs, real containers, driving actual generation rather than
just loading:

```
node v18.20.8 (CJS require, end to end)
  analyze -> 2 table(s): posts, users
  zod -> 3 file(s), first is index.ts (230 bytes)
  valibot -> 3 file(s), first is index.ts (238 bytes)
  arktype -> 3 file(s), first is index.ts (238 bytes)
  typebox -> 3 file(s), first is index.ts (238 bytes)
  json-schema -> 3 file(s), first is index.ts (114 bytes)
  service -> 3 file(s), first is postService.ts (678 bytes)
  orpc -> 3 file(s), first is index.ts (298 bytes)
CJS path works on this runtime
```

Same result on node:20.18.3, node:22.11.0 and node:24.19.0. The ESM path still works on node:24.

## The tests

### New: `packages/validation-core/test/require-entry.spec.ts`

Written first, watched fail, for the right reason: the same ten packages with the same error code
as the container run.

It builds every publishable non-`bin` package with its own build script into a `node_modules` tree
outside the workspace, then requires each **by package name** from a child process run with
`--no-experimental-require-module`. Resolution by name is the point: the existing suite loads
`dist/*.cjs` by absolute path, which cannot see a manifest that routes `require` to the wrong file,
and that is precisely why ten packages shipped broken for their whole lives.

`--no-experimental-require-module` is not a stand-in for an old runtime. It disables the exact
feature whose absence is the defect, and it reproduced node:18.20.8 identically: same ten packages,
same `ERR_REQUIRE_ESM`, same resolved path. A canary package that must fail to require guards the
flag actually being in effect, so the suite cannot pass by testing nothing.

Five assertions: the flag is in effect; discovery found the packages; every package exports a
non-empty API both ways; every package loads under `require`; the `require` and `import` surfaces
name the same exports; a `.cts` consumer typechecks under `moduleResolution node16`.

One assertion I wrote and then deleted. "Resolves to a file ending in `.cjs`" looked like an
independent guard. I mutated a `require` condition to point at `dist/index.js` to see it fire, and
it did not: the `loads` assertion caught that, and `loads` catches every mutation I could construct,
because with `require(esm)` off anything that loads *was* CommonJS. Worse, the extension check
would fire wrongly on a package that legitimately shipped CommonJS as `.js`. It went, and the
resolved path now rides along in the `loads` failure message instead.

### Updated: `packages/cli/test/every-entry-loads.spec.ts`

This file already carried a ledger of the defect, `ON_THE_ADVERTISED_ENGINE_FLOOR`, with an
instruction to update it when the set shrank. Two changes:

Its `entryPoints()` read `exports['.'].import` as a string. The nested condition objects broke it
with `TypeError: p.replace is not a function`. It now follows conditions to any depth, skipping
`types`.

The ledger went from ten failures to one. The survivor is `cli .`, and not for a reason DRZL owns:
`@drzl/cli`'s bundle requires `chalk@6`, which is ESM only (`"type": "module"`, a single
unconditional `exports` target, `engines.node: ">=22"`). No manifest change here can make that
requireable, and it is the one entry no consumer reaches by `require`: it is the bin, run as a
program. `cli ./config` moved to `loads`, as a free consequence of `@drzl/validation-core` becoming
requireable.

I also rewrote the prose in that file that my change falsified, rather than leaving sentences that
now assert the wrong counts.

## Adjacent defect found and NOT fixed: `@drzl/cli`'s CommonJS entries are unreachable on every Node

Reported rather than fixed, to keep this diff to the filed defect.

`@drzl/cli` ships `dist/cli.cjs` and `dist/config.cjs`. Its `exports` map declares only `import`
conditions, so on **every** Node version, including 24:

```
node v24.19.0 (@drzl/cli)
FAIL  require('@drzl/cli/config')  ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath './config'
      is not defined by "exports" in /tmp/app/node_modules/@drzl/cli/package.json
FAIL  require('@drzl/cli')         ERR_PACKAGE_PATH_NOT_EXPORTED: No "exports" main defined
```

This matters because `drzl.config.cjs` is a config filename the CLI itself supports
(`packages/cli/src/config.ts`, in both the candidate lists). The natural way to write one is
`const { defineConfig } = require('@drzl/cli/config')`, and that has never worked. As of this
branch the file it should reach, `dist/config.cjs`, now loads cleanly under
`--no-experimental-require-module`; only the manifest gate stands between it and a consumer. The
fix is a `require` condition on the `./config` subpath, pointing at `./dist/config.cjs` with
`./dist/config.d.cts` as its `types`. The `.` entry should be left alone: it is a bin that parses
argv at module scope.

## Verification

| Gate | Result |
| --- | --- |
| `pnpm build` | pass |
| `pnpm -r test` | pass, 1075 tests across 12 packages |
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm verify:packed` | pass, read-only, script untouched |

### One note on running `verify:packed` locally

The first run failed in the arktype carve-probe stage, and it was my shell, not this change.
`scripts/verify-packed.sh` matches `case "$out" in *"error TS2589"*)` against tsc's output. With
`FORCE_COLOR=3` exported, tsc emits `\e[91merror\e[0m\e[90m TS2589:` and the substring never
matches, so three probes that fail correctly get reported as failing for the wrong reason. Re-run
with `FORCE_COLOR` unset and the whole script passes. I have not touched the script; the controller
owns it. If it is worth hardening, the change is to strip ANSI from `$out` before the `case`, or to
export `NO_COLOR=1` for that `npx tsc` call. Note that `NO_COLOR=1` alone does not work: Node warns
`The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.`

### Effect on `verify:packed`'s own checks

Its tarball inspector walks `exports` to any depth and checks every path a manifest names exists in
the tarball, and separately that every `.js` it names has a `.cjs` twin beside it. My change adds
named paths (`module`, and the nested `types`/`default` pairs), all of which were already published,
so the referenced-path set grows and the twin check still holds. No count or ledger in that script
moves.

## Changeset

`.changeset/require-reaches-the-cjs-build.md`, **minor** for all eleven library packages.
`@drzl/cli` picks up a patch through the internal dependency cascade.

Minor rather than patch because an `exports` map is a gate. Deep paths such as
`@drzl/validation-core/dist/index.js` were importable before and are not now. Nothing in this repo
or its docs ever used one, and a workspace-wide grep for `@drzl/<pkg>/<subpath>` found none, but
a consumer could have. `main` also moves from the ESM file to the CJS file, which changes what a
bundler old enough to ignore `exports` resolves; the added `module` field is what keeps that from
mattering to any bundler that reads it.

Not a major, and the floor is not raised, so nobody on Node 18 or 20 loses support. The changeset
says all of this plainly.
