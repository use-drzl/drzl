# silent-unformatted (addendum E): fixed

One commit on top of `e3ca958`. Status: **done**. Chose **warn**, not throw, for reasons measured
rather than argued; the measurements are below. One pre-existing defect found in passing and filed
here rather than fixed.

**On the branch name.** `fix/silent-unformatted` was already taken, by an earlier attempt at this
same defect (`a3e26e1`, "refuse format.engine 'prettier' when prettier is not installed", based on
`18317c2`) that is checked out in a different worktree, `.claude/worktrees/wf_cfc4874a-a66-2`. Git
will not let a second worktree take a branch that another one holds, and removing someone else's
worktree or force-moving their branch is not a call I get to make. So this commit sits on this
worktree's own branch, `worktree-agent-a9dfe27439cb0ff87`, with `fix/silent-unformatted-warn`
pointing at it as well so it can be found by intent. Move the name over with `git branch -f` after
retiring the old worktree, if that is what is wanted. Worth knowing before that happens: the older
attempt chose to throw, which is the option this one rejects, with the measurements in the next
section as the reason.

## What was wrong

`formatCode` in `packages/validation-core/src/index.ts` had two `try {} catch {}` blocks and one
exit, `return code`. Every way of failing to format arrived at the same place as every way of
choosing not to, so a consumer who wrote `format: { engine: 'prettier' }` with no prettier
installed got their files exactly as rendered and nothing on any stream. The output is valid
TypeScript, so nothing downstream failed either. The request simply evaporated.

Reproduced end to end before touching anything, with the built CLI against a sandbox project
outside the repo:

```
config: { kind: 'zod', path: './src/zod', format: { engine: 'biome' } }
EXIT=0
stderr: ✔ Analysis complete in 91ms
        ✔ Generated (zod): 2 files
src/zod/index.ts:  export * from './users.zod.js';     <- single quotes, nothing formatted it
```

## The judgement: warn, not throw

Both were defensible on the brief. The case for throwing is that an explicit request that cannot be
met is not a state to continue from. Three measurements moved me off it.

**1. A throw does not arrive as "your formatter is missing".** I wired a throw into `formatCode`
for exactly this case, rebuilt, and ran the real CLI:

```
EXIT=1
Zod generator missing.
Install with: npm install @drzl/generator-zod
Error details: EXPERIMENT: formatter "biome" was requested and could not be loaded
--- files ---            (empty)
```

Every generator branch in `packages/cli/src/cli.ts` except the oRPC one wraps its `generate()` in a
catch that prints `<name> generator missing. Install with: npm install @drzl/generator-<name>`, and
the real reason is demoted to a trailing detail line. The headline names a package the consumer
already has and prescribes an install that changes nothing. The same shape is at cli.ts:159, :179,
:199, :219, :242, :266 and again in the watch pipeline at :525, :554, :583, :612. So the honest
comparison is not "throw versus warn" but "a wrong error message and no files, versus a right
warning and the files".

**2. The files were gone.** `--- files ---` above is empty: the throw came from the first
`formatCode` call, before the first write. With several generators configured, the earlier ones
have already written and the tree is left half regenerated. Whitespace is not worth that, and
`scripts/verify-packed.sh` already asserts the point it turns on, that output emitted with no
formatter is complete and typechecks under nodenext.

**3. For biome, throwing would be unfixable by the consumer.** See below. Since the brief says to
treat both engines the same unless I can say why they differ, and the only real asymmetry
(whether the user can act on the message) argues against throwing on biome, warn is the setting
that is right for both.

There is also a compatibility argument, which I rank lowest because it would not on its own justify
staying silent: `engine: 'prettier'` with no prettier is a configuration that works today, in the
sense that it completes, and turning it into a hard failure in a patch release breaks installs that
are not broken.

What the warning does not do is treat the absence as a value. It is announced, on stderr, naming
the setting that produced it, the package, the remedy and the underlying error, once per run.

## `engine: 'biome'` is supported, and cannot currently work at all

Checked rather than assumed. `packages/cli/src/config.ts:120` accepts
`z.enum(['auto', 'prettier', 'biome'])`, so it is a supported configuration.

`formatCode` reaches it with `import('@biomejs/biome')`. Measured against a real install:

```
npm i @biomejs/biome            -> 2.5.7
import('@biomejs/biome')        -> REJECTED ERR_MODULE_NOT_FOUND
                                   Cannot find package '.../node_modules/@biomejs/biome/index.js'
package.json main/module/exports -> undefined undefined undefined   (it declares only `bin`)
```

The published `@biomejs/biome` is a CLI wrapper with no module entry, so that import rejects whether
or not biome is installed; the Node API lives in the separate `@biomejs/js-api`. So `engine: 'biome'`
has never formatted anything, for anyone, and the silence is the only reason that was not obvious.
The fix does not repair the biome integration, which is a different piece of work, but it does make
the failure visible, and the biome message deliberately does not say "install @biomejs/biome",
because that is advice I have measured cannot help. It points at the Biome CLI and at the other
engines instead.

## What changed

`packages/validation-core/src/index.ts`

- `reportedEngines`, a module-level `Set`, and `reportUnusableFormatter(engine, cause)`. One
  `console.warn` per engine per process: whether a formatter loads is a fact about the environment,
  and `drzl generate` reaches `formatCode` once per table per generator, so per-file would mean
  dozens of identical lines.
- The two `try/catch` blocks now scope to their own branch and report only when `engine` names that
  branch. `auto` is untouched and still silent.
- The biome branch no longer swallows its own import rejection with `.catch(() => null)`, and no
  longer returns `code` silently when a loaded biome hands back something with no content. Both now
  raise into the branch's catch, which reports only for `engine: 'biome'` and otherwise falls
  through to the same `return code` as before.
- `return prettier.format(...)` is still returned without `await`, on purpose. Measured: an async
  function adopts a returned promise outside its own `try`, so a prettier that loads and then
  rejects on the code still propagates to the caller, exactly as before this change. That is an
  error rather than an absence and is not this function's to swallow. Adding `await` would have
  quietly converted a formatter crash into unformatted output under `engine: 'auto'`, which is the
  defect being fixed, in a new place.

`packages/cli/README.md` gains the distinction between naming an engine and asking for `auto`.

The changeset is a patch on `@drzl/validation-core`; the generators pick it up through
`updateInternalDependencies: patch`.

## Tests, and watching them fail

Every assertion below was run against the unfixed code first.

| spec | absence arranged by | red before the fix |
| --- | --- | --- |
| `test/format-without-prettier.spec.ts` | `vi.mock('prettier')` throwing factory | `expected "warn" to be called 1 times, but got 0 times` |
| `test/format.spec.ts` (biome) | biome not installed in the workspace | same, 0 calls |
| `test/no-bundled-formatter.spec.ts` | real build, copied outside the workspace, run in a child process with no node_modules | `expected [] to have a length of 4` |

The third is the one that matters, and it is the spec the brief pointed at: it builds
validation-core with its own build script, copies `dist` to a temp directory Node's resolver cannot
walk out of, and runs both the ESM and CJS entries in a child process. Both `prettier` and
`@biomejs/biome` fail there the way they fail for a consumer who has not installed them, and the
assertion is on the child's **stderr**, so it covers the stream as well as the text. I factored the
existing sandbox out of the older test rather than building a second one.

Three things kept the new assertions from being able to pass by matching nothing:

- The expected *reason* is taken from a run, not written down. Under vitest a throwing `vi.mock`
  factory is replaced by vitest's own message, and the `Function`-built biome import fails as
  `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` rather than `ERR_MODULE_NOT_FOUND`. Hardcoding either
  would have asserted the harness. The specs capture the real error and require the warning to
  contain it; the child-process spec, which is real Node, asserts the resolver's own
  `Cannot find package 'prettier'` and `Cannot find package '@biomejs/biome'`.
- The per-engine line is matched on `is "<engine>"`, not the bare name, because the biome message
  mentions prettier too, as one of the things to switch to.
- The expected warning count is derived from the entry and engine lists the probe is built from,
  not restated as a literal.

Then three mutations, each reverted:

| mutation | result |
| --- | --- |
| drop `Reason: ${reason}` from the message | 3 specs red |
| remove the once-per-engine guard | 3 specs red |
| report for `auto` as well as for a named engine | 2 specs red, including the "says nothing" one |

## Verification

| gate | result |
| --- | --- |
| `pnpm build` | pass, 12 packages |
| `pnpm -r test` | pass, 12 packages, 1071 tests, 0 failures |
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm exec prettier --check` on the changed files | pass |
| `pnpm verify:packed` (read only) | **pass**, exit 0 |

`scripts/verify-packed.sh` was not edited and none of its counts moved. Its "generating with no
formatter installed" stage writes a config with no `format` key at all, so the engine there is
`auto`, which this change leaves byte for byte as it was: no warning, same unformatted output, same
`export * from './users.zod.js'` assertion, same typecheck. Nothing else in that script names an
engine, and the ledgers it prints are about validator output, which formatting does not touch. It
ended with `OK: 12 packages packed, installed into an empty project, generated, and the output
typechecks under bundler, node16 and nodenext`.

## Found and not fixed

1. **`engine: 'biome'` cannot format anything**, at any Biome version that ships `@biomejs/biome`
   as it is published today, because the package has no module entry. Repairing it means going
   through `@biomejs/js-api`, which is a new optional peer and a different change. This fix makes it
   loud instead of silent, which is the precondition for anyone noticing.
2. **The CLI mis-reports any error out of a generator** as `<library> generator missing. Install
   with: npm install @drzl/generator-<library>`, in ten places. Measured above. Anything that throws
   inside a generator, not only a formatter, gets that headline. Out of scope here, and worth its
   own fix, since it is the reason throwing was the worse of the two options rather than merely the
   harsher one.
