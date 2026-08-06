# `point({ mode: 'xy' })` and `line({ mode: 'abc' })` were typed wrong on both majors

Addendum AI, the last Tier A tuple case. Fixed, on branch `fix/point-object-mode`.

Status: **done**. `pnpm build`, `pnpm -r test`, `pnpm typecheck`, `pnpm lint` and `pnpm verify:packed`
all pass. The verify-packed ledgers did not move; the measurement is at the bottom.

---

## The defect, in one paragraph

`point()` and `line()` have two modes each, and they return different JavaScript values. The tuple
modes return `[x, y]` and `[a, b, c]`; the object modes return `{ x, y }` and `{ a, b, c }`. Neither
drizzle major's description separated them, and each got it wrong in its own way. On 0.4x a coarse
`/Point|Line/i` over the class name answered `string` for all four classes, a regex written for two
that was catching four. On v1 the column states `dataType: 'object point'` where the tuple mode
states `'array point'`, and the analyzer read only the second word, so both modes reached one arm
and came back as tuples. The consequence is the same on both: the emitted select schema rejected
every row the driver returned for an object-mode column, and the insert schema promised a write the
server refuses.

## What a real Postgres says

PGlite through `drizzle-orm/pglite`, on `CREATE TABLE t (id integer primary key, p point, l line)`,
run once on drizzle-orm 0.45.2 and again on 1.0.0-rc.4. The two runs agree line for line.

| value passed to `db.insert()` | rendered by `mapToDriverValue` | server                                 |
| ----------------------------- | ------------------------------ | -------------------------------------- |
| `{ x: 1.5, y: -2.25 }`        | `(1.5,-2.25)`                  | stored; `db.select()` returns `{ x, y }` |
| `{ a: 1, b: 2, c: 3 }`        | `{1,2,3}`                      | stored; returns `{ a, b, c }`          |
| `[1, 2]`                      | `(undefined,undefined)`        | `invalid input syntax for type point`  |
| `'1,2'`                       | `(undefined,undefined)`        | `invalid input syntax for type point`  |
| `'(1,2)'`                     | `(undefined,undefined)`        | `invalid input syntax for type point`  |
| `{ x: 1 }`                    | `(1,undefined)`                | `invalid input syntax for type point`  |
| `{ x: 1, y: 2, z: 3 }`        | `(1,2)`                        | stored: the unlisted key is ignored    |
| `{ a: 0, b: 0, c: 1 }`        | `{0,0,1}`                      | `invalid line specification: A and B cannot both be zero` |
| `{ a: 0, b: 1, c: 0 }`        | `{0,1,0}`                      | stored                                 |

Three things follow, and each one decided a line of the fix:

1. **Every named field is required.** `{ x: 1 }` renders `(1,undefined)` and is refused.
2. **Unlisted keys are ignored, not refused.** `mapToDriverValue` reads `.x` and `.y` off whatever
   object it is handed. So the emitted object is `z.object`, not `z.strictObject`: the strict form
   would turn away a write the column takes. This is the opposite choice from the tuple modes,
   where valibot's `strictTuple` is used precisely because the plain `tuple` accepts a third
   element the column never produces. Both follow the column.
3. **A tuple and a string are not rejected in JavaScript.** They pass drizzle's mapper and become a
   literal the server rejects, which is why the old `string` typing looked plausible and was not.

What drizzle states about each builder, read off real columns on 1.0.0-rc.4:

| builder                                   | `dataType`        | `codec`                 | class              |
| ----------------------------------------- | ----------------- | ----------------------- | ------------------ |
| `point()`                                 | `array point`     | `point:tuple`           | `PgPointTuple`     |
| `point({ mode: 'xy' })`                   | `object point`    | `point`                 | `PgPointObject`    |
| `line()`                                  | `array line`      | `line:tuple`            | `PgLineTuple`      |
| `line({ mode: 'abc' })`                   | `object line`     | `line`                  | `PgLineABC`        |
| `geometry({ type: 'point' })`             | `array geometry`  | `geometry(point):tuple` | `PgGeometry`       |
| `geometry({ type: 'point', mode: 'xy' })` | `object geometry` | `geometry(point)`       | `PgGeometryObject` |

On 0.45.2 the same six classes exist with `dataType: 'json'` or `'array'` and no codec at all.
`line({ mode: 'abc' })` builds a `PgLineABC`, not a `PgLineObject`, and any mode string other than
`'tuple'` selects the object class: `point({ mode: 'abc' })` is a `PgPointObject`.

Probe scripts, re-runnable:
`/tmp/claude-1000/-home-user-projects/758528dc-2db4-465e-a564-2d35ad9cf2af/scratchpad/ptobj/04x/probe.mjs`,
`probe2.mjs`, `classes.mjs`, and `../v1/probe.mjs`, `../v1/geom.mjs`.

## The fix

A new `ColumnShape` variant, as the brief expected:

```ts
| { kind: 'numberObject'; fields: string[] }
```

The field names are carried rather than derived from a length, because the two arities have
different keys (`x, y` against `a, b, c`) and nothing else on the column states them.

**Analyzer.** On v1 the three arms split on `js`, the first half of `dataType`, which is the half
that already carried the answer. `js` rather than the codec because three dialects state a semantic
with no codec at all on 1.0.0-rc.4, so the codec is the weaker signal, and this file already prefers
`js` elsewhere for that reason. On 0.4x, `PgPointObject` and `PgLineABC` are named outright in the
class switch and in the shape table, and the `/Point|Line/i` arm is **deleted**. It was not narrowed:
swept over every builder `pg-core` exports on 0.45.2 in every mode, the only class names it matches
are those four, and `string` is wrong for all four. That sweep is an assertion in
`floats-and-tuples-0.4x.spec.ts`, not a sentence here.

**Generators**, one arm each:

| generator     | emitted for `point({ mode: 'xy' })`                     |
| ------------- | ------------------------------------------------------- |
| zod           | `z.object({ x: z.number(), y: z.number() })`            |
| valibot       | `v.object({ x: v.number(), y: v.number() })`            |
| typebox       | `Type.Object({ x: Type.Number(), y: Type.Number() })`   |
| arktype       | `type({ "x": "number", "y": "number" })`, a Type instance |
| JSON Schema   | `{ type: 'object', properties: {...}, required: [...] }` |
| service types | `{ x: number; y: number }`                              |
| oRPC          | the zod/valibot form; `unknown` for arktype             |

ArkType is the one that is not a one-line arm. Its definition DSL cannot state an object at all:
`type({ p: '{ x: number, y: number }' })` throws `'{' is unresolvable`, measured, and it throws at
import, so an approximation there is a module nothing can load. The field is emitted as a `type(...)`
instance instead, through a new `atNumberObjectField` that builds the whole line. Every wrapper was
run before being emitted: `.array()` per dimension, `.or("null")` for a nullable column, `?` on the
key for an optional one, `.atLeastLength`/`.moreThanLength`/`.atMostLength`/`.lessThanLength`/
`.exactlyLength` for a cardinality CHECK, and `.default(() => (...))` for an applied default (a
non-primitive default must be a thunk, `.default({x:0,y:0})` throws
`Non-primitive default must be specified as a function`).

In the oRPC generator ArkType keeps `unknown`, for the same measured reason it already keeps it for
a tuple: every field value there is a quoted DSL fragment that has to compose with the `nullable`
and `optional` wrappers, and a Type instance is not a string.

## Tests: red first, and what they run

Two new end-to-end files, each taking a real drizzle table through the real analyzer and the real
zod generator and then **importing and running** the emitted module.

- `packages/cli/test/point-object-mode.e2e.spec.ts` covers 0.4x. It lives in `@drzl/cli` because that
  is the only package where `drizzle-orm` and a validator library both resolve, which is the reason
  `decimal-modes.e2e.spec.ts` and `gel-emitted-schemas.spec.ts` live there too.
- `packages/generator-zod/test/point-object-mode-v1.spec.ts` covers v1, through the `drizzle-orm-v1`
  alias held as a devDependency of that package, exactly as `mssql-cockroach-types.spec.ts` does.

Both were run against master with the fix stashed out, and both are red there:

```
cli/test/point-object-mode.e2e.spec.ts        7 failed | 1 passed
  p_obj.tsType is 'string', dbType 'TEXT'; the emitted schema ACCEPTED '1,2', which the
  server refuses, and REJECTED { x: 1.5, y: -2.25 }, which the column returns
generator-zod/test/point-object-mode-v1.spec.ts   3 failed | 2 passed
  p_obj.tsType is '[number, number]'; the emitted schema REJECTED { x: 1, y: 2 }
```

The passing tests in each red run are the controls: the tuple modes were already right and stayed
right, so neither file can pass by matching nothing.

The two pinned "this is a filed defect" tests are replaced by the real expectation rather than
deleted: `analyzer/test/floats-and-tuples-0.4x.spec.ts` (0.4x half) and
`analyzer/test/v1-column-types.spec.ts` (v1 half, `DEFECT: calls the object modes tuples too`).

One existing test had to change for a reason worth naming. `analyzer/test/pg-types.spec.ts` built
fake classes called `PgPoint` and `PgLine` to exercise the coarse regex. Those are names drizzle
builds on neither major, a fact the tuple fix had already written down one file away. With the regex
gone they fell to `unknown`, so the fixture now uses the four names drizzle really builds and
asserts the four real answers.

Per-generator executable coverage was added to each `structured-columns.spec.ts`
(zod, valibot, typebox, arktype), `against-ajv.spec.ts` (compiled by ajv in strict mode, both
targets), `tuple-types.spec.ts` (service) and `tuple-columns.spec.ts` (oRPC).

Two smaller things found while writing those:

- The oRPC spec's existing negative assertions are written `expect(content).not.toContain('"at": z.string()')`,
  and prettier drops the quotes from a bare identifier key, so they match nothing and pass whatever
  the generator does. The new assertions use the unquoted form. The old ones are left alone; they are
  not this defect.
- The service generator's emitted types are spliced into a `.ts` file, so a shape spelled wrong is a
  module the consumer cannot build. The new test compiles the emitted file with `ts.transpileModule`
  under `strict` and asserts no diagnostics, rather than reading the text.

## Scope decisions

**geometry.** `geometry({ type: 'point', mode: 'xy' })` is the same defect through the same arm and
is fixed on v1, where the split is on `dataType` and covers all three builders. It is **not** fixed
on 0.4x, and that is deliberate: 0.4x names no geometry class at all, in either mode, and that gap is
already filed and waived by name in `scripts/verify-packed.sh`
(`matrix.c_geometry.tsType: 'unnamed on 0.4x: no PgGeometry arm in the class-name path'`). Naming
only the object half would half-close someone else's filing and leave the two modes of one builder
answered from two different paths. No fixture uses a geometry object mode, so nothing moves either way.

**The line rule Postgres has and no shape can state.** Postgres refuses a line whose A and B are both
zero and accepts `{ a: 0, b: 1, c: 0 }` beside it. No `ColumnShape` carries a cross-field rule and
none of the five generators has a place to put one, so the insert schema still promises that write.
Filed, not fixed, and pinned as a measured gap in the cli e2e file so the day a shape can express it,
a test changes rather than a memory.

**A pre-existing arktype defect, found and not fixed.** The DSL path emits a default inline, and for
a tuple column carrying an applied default that is `"number[] == 2 = [0,0]"`, which throws
`Expected an expression before '[0,0]'` at import. Measured. It predates this change, it is the same
family as the `.default(null)` hole the generator's own comment already documents, and fixing it
means moving the whole `applyDefaults` path off the DSL. The new object path avoids the trap by
emitting a default only when it is an object of the declared number fields, or `null` on a nullable
column, and falling back to an optional key otherwise, which is what the column emits without
`applyDefaults` anyway.

## Verification

Run with `FORCE_COLOR` unset. All from the worktree at
`/home/user/projects/drzl/.claude/worktrees/wf_cfc4874a-a66-3`.

| command             | result                                                          |
| ------------------- | --------------------------------------------------------------- |
| `pnpm build`        | pass                                                              |
| `pnpm -r test`      | pass, 12 packages, 1093 tests                                     |
| `pnpm typecheck`    | pass                                                              |
| `pnpm lint`         | pass, 0 problems                                                  |
| `pnpm verify:packed`| pass, read-only, no ledger movement (below)                       |

### `pnpm verify:packed`, and one environment trap worth recording

**The script was not touched.** It was run read-only, before the change and after.

The first baseline run *failed*, on master, with no edits in the tree:

```
FAIL: src/carve-probe/pg-c_numeric.ts fails, but not with the TS2589 this carve-out exists for
```

That is not a regression and not the script's fault. This environment sets `FORCE_COLOR=3`, so
`tsc` emits ANSI escapes even when its output is captured into a variable, and the stage matches its
output against the literal `*"error TS2589"*`. The escapes land between `error` and `TS2589`, the
glob misses, and three healthy carve probes are reported as failures. Re-run with `FORCE_COLOR`
unset, the same commit passes. **Anyone running this script under a colour-forcing environment will
see three false failures at the carve-probe stage.** Reported here rather than worked around, since
the script belongs to the controller.

Baseline (master, `18317c2`) and after, diffed line by line. Both exit 0. The whole diff, with
nothing elided, is:

- eleven lines of the form `Analysis complete in 38ms` against `39ms`, which is the timing the CLI
  prints;
- one line in the provenance stage, `@drzl/analyzer@1.17.0` against `@drzl/analyzer@1.17.1`. That
  stage reads the registry, and 1.17.1 was published between the two runs by work outside this
  worktree.

Nothing else. Every parity row is identical entry for entry, including
`pg matrix zod select 40/40 cols compared, parity (6 waived)` and the other 47 rows, every ledger
count, every emitted-size figure and every waiver list.
- No fixture in either parity pass declares an object-mode column, which is why neither gate has
  ever seen this defect, and it is also why the counts cannot move: the columns that changed are
  not in any fixture. The `c_point`, `n_point`, `c_line`, `c_geometry` and `n_geometry` fixtures all
  use the default tuple mode, which this change leaves alone.

The one thing that would move a ledger is adding an object-mode column to the parity fixtures. That
is an edit to `scripts/verify-packed.sh` and is left to the controller. It is worth doing: this
defect survived two rounds of parity fuzzing precisely because the pool has no such column, and
`drizzle-orm/zod` 0.8.3 does describe an object-mode point, so the comparison would be live.

## Files

Source:

- `packages/analyzer/src/index.ts` (`ColumnShape`, `GEOMETRIC_CLASS_SHAPES`, `describeV1Column`,
  the class switch, the `/Point|Line/i` deletion)
- `packages/generator-zod/src/index.ts`, `packages/generator-valibot/src/index.ts`,
  `packages/generator-typebox/src/index.ts`, `packages/generator-json-schema/src/index.ts`
- `packages/generator-arktype/src/index.ts` (new `atNumberObjectField`)
- `packages/generator-service/src/index.ts`, `packages/generator-orpc/src/index.ts`

Tests:

- new: `packages/cli/test/point-object-mode.e2e.spec.ts`,
  `packages/generator-zod/test/point-object-mode-v1.spec.ts`
- changed: the analyzer's `floats-and-tuples-0.4x`, `v1-column-types`, `pg-types`; each generator's
  `structured-columns`; `against-ajv`; service `tuple-types`; oRPC `tuple-columns`

Docs and changeset:

- `docs/generators/{zod,valibot,typebox,arktype,json-schema}.md`, `packages/analyzer/README.md`
- `.changeset/point-object-mode.md`, `minor` on all eight packages, for the same reason the tuple fix
  was a minor: the emitted TypeScript type of a column changes and code written against the old
  output does not compile against the new.
