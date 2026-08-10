# How it is verified

One script, `scripts/verify-packed.sh`, runs in CI on every pull request and on every push that
touches anything outside `docs/`. It is its own job rather than another step in the test job, so a
green `pnpm -r test` can never be mistaken for a shippable artefact.

That script is the stage order and nothing else. Each stage is a file under `scripts/verify/stages`,
the TypeScript it runs is under `scripts/verify/harness`, and the schemas and configs it generates
from are under `scripts/verify/fixtures`, so any single check here can be read on its own.

Run the whole thing yourself:

```bash
pnpm verify:packed
```

Postgres and SQLite run in-process, so a local run needs nothing installed and nothing running.
MySQL has no in-process engine, so it is the one dialect that needs a server. Point `MYSQL_URL` at
one and the MySQL stages run; leave it unset and they skip, print that they skipped, and stop
comparing the lines of documentation they would otherwise have checked.

```bash
MYSQL_URL=mysql://root:root@127.0.0.1:3306/drzl pnpm verify:packed
```

## It measures the tarball, not the workspace

`pnpm -r test` imports from `src`. Nothing a consumer installs looks like that. They get a tarball
filtered by `files`, installed into a tree holding none of this repo's `node_modules`, and read by
a compiler whose `moduleResolution` this project does not choose.

That gap is where the defects were. A `files` rule omitting a required file, a build that silently
emitted nothing, a generated import specifier that did not resolve under the consumer's compiler:
none of those are visible in a working tree, because in a working tree every one of those paths has
`src` sitting next to `dist` to fall back on.

So the gate packs every publishable package and then, before installing anything:

- reads each manifest **out of the tarball** rather than off disk, because pnpm rewrites
  `workspace:` ranges on the way past and the tarball's copy is the one npm serves
- checks every path the manifest names, at any depth of `exports`, against what the tarball
  actually holds, plus the CommonJS twin beside every ESM entry
- fails any tarball shipping sources, tests, tooling configuration or a `node_modules` tree

Then it installs the tarballs with **npm**, not pnpm, into an empty project. A consumer is unlikely
to share this repo's package manager, and npm's flat layout is the harsher test of whether
dependencies are really declared. It runs the command the README tells you to run, loads the
generated router graph, and typechecks the emitted tree under `bundler`, `node16` and `nodenext`,
which are the three `moduleResolution` settings TypeScript still supports. That last part is the
point of emitting `.js` specifiers, and nothing else in CI would notice if it regressed.

Every runnable config block in these docs is extracted and run in the same tree. Two rounds of
defects were "the documentation shows a config that does not work", both found by hand.

## Three real databases

A validator is right or wrong about a specific database, so the emitted schemas are asked about
specific databases:

| Database | How it runs                       | What it settles                                                     |
| -------- | --------------------------------- | ------------------------------------------------------------------- |
| Postgres | PGlite, in-process                | column types, `CHECK` constraints, what a read hands back, defaults |
| SQLite   | `node:sqlite`, built into Node 22 | `CHECK` constraints under a second SQL parser                       |
| MySQL    | a service container in CI         | byte caps, the narrow integer widths, its own float edge            |

Both directions are asked of Postgres, because a column's write type and its read type are not the
same type. One block sends each probe through an `INSERT` and grades the Insert schema on the
answer. Another writes a row, reads it back through the driver, and grades the Select schema on the
value a caller actually receives. `geometry` is written as `point(1 2)` and read back as `[1, 2]`;
`char(4)` takes `'ab'` and returns `'ab  '`; `boolean` takes the string `'yes'` and returns `true`.

The read direction is graded absolutely rather than against another validator. Elsewhere a
validator is allowed to be stricter than a coercing driver, since that is what a validator is for,
but that reasoning is about untrusted input. A row read back came out of the database through the
very driver the schema describes, so a schema refusing it fails on real rows and no amount of
agreement with anyone else makes it correct.

SQLite is not asked about types on purpose. Its type checking is famously weak and a non-STRICT
column takes almost anything, so measuring against it would say nothing. Its `CHECK` enforcement is
not weak at all, and that is what it is used for.

## Differential parity against the first-party validators

DRZL's claim is not that its generated schemas are stricter than `drizzle-orm`'s own validator
modules. It is that **every difference between them is known, named and measured**.

That is a claim about behaviour, so it is measured by behaviour. The same table is generated by
both, and then the same pool of values is pushed through both, column by column, in all three modes
and on all three dialects, and the verdicts are compared. Reading the emitted source could not do
this: a schema that parses and a schema that validates look identical as text.

Where the two disagree, the database decides which is right, and the answer goes in a ledger with
its measurement. See [Compared with the first-party validators](/guide/comparison) for what those
differences are, in both directions.

## Both drizzle-orm majors

`npm install drizzle-orm` still serves 0.45.2. The `rc` tag serves 1.0.0-rc.4. The two majors do
not model schemas the same way, and reading only one of them is a real defect with no symptom in a
green test run: 0.4x wraps an array column in a `PgArray` whose `baseColumn` is the element, while
v1 leaves the class alone and raises `dimensions`. The analyzer read only the v1 signal, so on the
major most people have, every `.array()` column came back `unknown` in all five generators, with
four array columns in the fixture and the gate green throughout.

Two stages cover this now:

- **the cross-major description diff.** The same schema files are analyzed under both majors and
  every field of every column is compared. A difference is either in an `ALLOWED` map, meaning the
  majors really do differ and DRZL reflects each one faithfully, or in a `DEFECTS` map, meaning the
  analyzer reads one major and not the other and it is filed rather than fixed.
- **the parity pass, twice.** The comparison above is relative: it sees the two majors disagreeing
  and cannot see either of them being wrong. So the value-by-value comparison against the
  first-party validators runs once against 1.0.0-rc.4 and again against 0.45.2 with the separate
  `drizzle-zod`, `drizzle-valibot`, `drizzle-arktype` and `drizzle-typebox` packages.

Each side records the version it ran under and the two are compared before any field is. That check
exists because the v1 side used to be the consumer tree, whose `drizzle-orm` is deliberately
unpinned, and `latest` is 0.45.2: this stage compared 0.45.2 with 0.45.2 for months and passed for
the same reason a diff of a file against itself passes.

The differences these two stages measure, and what each one does to your generated files, are on
[drizzle-orm 0.4x and v1](/guide/drizzle-majors).

## A ledger fails when a defect stops reproducing

Every ledger in the gate is asserted **in both directions**, and that is the part that makes them
worth reading:

- a difference in no ledger fails the run
- an entry that suppresses nothing fails the run
- an entry whose libraries, modes, pairing count or exact set of probes no longer match what was
  measured fails the run, with the observed signature printed

A list checked only for additions turns into a graveyard of sentences describing things nobody can
observe any more. Checked in both directions, a fix reports itself. The insert-side ledger held six
pins on two date columns, all strings `new Date()` turns into a real date that Postgres then
refuses, so validation passed and the `INSERT` failed at the server. The round-trip ledger held
five, all of them values Postgres stores, returns, and the emitted schema refused. Narrowing what a
coerced string may be, and accepting the non-finite numbers a float column really holds, made every
one of those pins stop firing, and a pin that stops firing fails the run. Both maps are empty
today, and they are kept rather than deleted so the next one has somewhere to go that is asserted
both ways.

## Things that share no code, cross-checked

`drzl doctor` and `drzl explain` answer the same question from opposite ends and share none of the
code that answers it: `doctor` calls the CHECK parser itself and filters the analyzer's issues,
while `explain` reads the constraint ledger the emitted modules are built from. The gate asserts
that what `explain` lists as not understood about a table is exactly what `doctor` reports about
it, so a drift in either one is a drift between them.

The same shape appears elsewhere. `doctor` is held to the analyzer: the set of columns it calls
untypeable has to be exactly the set the analyzer raised `DRZL_ANL_UNKNOWN_COLUMN` for, because a
doctor that under-reports is worse than none. The JSON Schema output is compiled by ajv in strict
mode and then asked the same `CHECK` questions as the four validator generators, so it speaks as a
fifth voice rather than being taken on trust. `applyDefaults` is compared against what the database
actually writes.

## The numbers on this site, against the run

Until recently nothing in this project checked a number in its own documentation. That was measured
rather than assumed: substituting a wrong float bound into the shipped TypeBox page left the lint,
typecheck, package test, docs build and config extraction steps all at exit 0.

Three blocks are checked now, each one a place where a page quotes this script's own output:

- [Benchmarks / What is not measured here](/guide/benchmarks#what-is-not-measured-here)
- [What one run printed](#what-one-run-printed), on this page
- [Compared with drizzle-orm](/guide/comparison), the block under "the run behind this page
  printed"

Each is found by a phrase in the prose above it and compared against what this run printed, line by
line and literally. A fabricated digit fails the run and names the line. Lines mentioning MySQL are
skipped by name, out loud, when `MYSQL_URL` is not set, because that stage did not run. If the
prose an extraction anchors on is reworded so that nothing is found, the run fails rather than
reporting that everything matched, and that guard is per block rather than once at the end, so a
dead anchor in one page cannot hide behind another page's matches.

One block that looks like it belongs here deliberately does not: the defect table on the comparison
page is assembled from this script's own ledger rather than quoted from its output, because a
ledgered defect reproducing is the quiet case and no run prints those column names. Listing it
would fail every run over lines nothing ever prints.

Every other number in these docs is quoted from a run and is not compared by anything.

## The checks are themselves measured

A check nobody has ever seen fail is a check nobody has evidence about. The gate's own guards are
verified by sabotage, and the working is kept in the script beside each one: a generator is made to
answer something known to be wrong, the run is repeated, and the outcome is recorded. Several
guards were found to be inert exactly this way. Making the TypeBox Insert and Update schemas accept
`null` on a `NOT NULL` column left the run **byte identical to green**, because the pass that would
have seen it read the Select schema and nothing else. Doing the same to a `bit(3).notNull()` column
also left the whole run byte identical to green, because a value the first-party module crashed on
was being dropped from the comparison entirely, which made a crashing module a licence for DRZL to
answer anything. Both holes are covered now, and both were found by sabotage rather than by
reading.

The same discipline applies to the fixtures. Adding a value to the probe pool is checked for having
changed something: an enum column whose members were absent from the pool was rejected by both
sides for every value, so the comparison agreed while measuring nothing.

## A failure names its own stage

The gate has 62 places it can exit and 159 lines that can carry a FAIL, and none of them used to
reach GitHub's checks page: a failed step showed `Process completed with exit code 1`, and the line
that said what went wrong sat somewhere inside about 670 lines of output. CI now lifts the stage
heading and the FAIL line onto the failure annotation and the job summary, so the first thing a
reader sees names the stage that died.

## Nightly, against what the registry serves

Everything above pins the versions it measures, on purpose, so a claim on these pages is exactly
true of a named version. The cost is that an upstream release is invisible until somebody opens a
pull request, and then it lands on that pull request rather than on its own. A nightly workflow is
the other half of that trade: it resolves drizzle-orm's `latest` and `rc` tags, runs the same gate
against them, runs the runtime checks against whatever Bun and Deno ship that day, and prints the
per-version download split the deprecation policy keys on.

When it breaks it opens one issue, assigned, and a later failure comments on that issue rather than
opening a second. The run that goes green again closes it, so the issue's state is the current
state rather than a history. The gate itself is unchanged by any of this: with no overrides it runs
the pinned versions, which is what every number on this site was measured against.

## What one run printed

Lines from the run behind this page, verbatim: commit `74def57`, Node 22.22.0, `MYSQL_URL` set to a
local MySQL 8.4.11 on utf8mb4 in strict mode.

One line has moved since that run: the documented-config count is a count of runnable blocks in
these docs rather than a measurement of the code, and it went from 35 to 36 when the
[Recipes](/examples/recipes) page added one. It is updated in place rather than left stale, because
this block is one of the three the gate compares against every run and a stale line fails it.
Nothing else here is affected by a documentation change.

```
    packed 19 package(s)
    bundler ok
    node16 ok
    nodenext ok
    all 36 documented configs generate and typecheck
    drizzle-orm 1.0.0-rc.4, with its own zod, valibot, arktype and typebox-legacy modules
    1548 column comparisons
    60 documented divergence(s), 30 of them with DRZL accepting something official refuses, 0 stated as a rejection count and a complement
    1476 probes against a real Postgres (41 columns)
    agree with the database: DRZL 1103, drizzle-orm 1041
    DRZL closer than drizzle-orm on 62, further on 0
    403 rows read back through the driver (41 columns)
    rejected by DRZL: 66, of which drizzle-orm also rejects: 66
    59 CHECK probes against a real Postgres (15 constrained columns)
    rows Postgres rejects and the validator accepts: DRZL 0, drizzle-orm 24
    32 CHECK probes against a real SQLite (10 constrained columns)
    37 probes against a real MySQL
    9 defaulted columns, 9 reproduced by applyDefaults
    119 columns and 11 tables compared, drizzle-orm 0.45.2 against 1.0.0-rc.4
    drizzle-orm 0.45.2 against drizzle-zod 0.8.3, drizzle-valibot 0.4.2, drizzle-arktype 0.1.3, drizzle-typebox 0.3.3
    1500 column comparisons across 72 pairings
    54 documented divergence(s), 27 of them with DRZL accepting something official refuses; 6 known-defect column(s), 0 already filed and 6 first seen by this stage
```

## What it does not cover

Named rather than papered over, because a stage that quietly does not reach something is
indistinguishable from one that passes.

- **Two of the CLI's generator kinds miss part of the sweep.** `typebox` and `json-schema` are
  generated and compiled by the parity stage under `module nodenext` alone, so neither reaches the
  `bundler` and `node16` legs of the moduleResolution sweep.
- **One MySQL cap cannot be probed at all.** Telling a byte budget from a character count needs a
  string over the cap in bytes and under it in characters, and UTF-8 spends at most three bytes per
  UTF-16 unit. For `longtext` that needs more units than V8 will put in a string. The run prints
  the column by name as unprobeable rather than omitting it.
- **Throughput is not in CI.** A benchmark on a shared runner measures the runner. It is run by
  hand, with the machine named, on the [Benchmarks](/guide/benchmarks) page.
- **The Effect Schema and JSON Schema generators are not in the parity comparison.** There is no
  official JSON Schema module to compare against at all, and `drizzle-orm/effect-schema` exists on
  1.0.0-rc.4 but is not yet compared. Both are covered by their own package tests and, for JSON
  Schema, by ajv and by the Postgres ground-truth stage.
- **On MySQL, "the insert succeeded" means less than it looks like.** The MySQL truth stage asks the
  server through the text path, and the binary prepared path that `mysql2`'s `execute()` uses, which
  is what an application hits, answers differently on the non-finite doubles. Measured on 8.4.11 in
  `STRICT_TRANS_TABLES`, through `execute()`:

  ```
  float, double     NaN and both infinities refused, "Out of range value"
  decimal(10,2)     all three stored as 0.00, silently, SHOW WARNINGS empty
  int               NaN stored as 0 silently; both infinities refused
  bigint            NaN stored as the int64 minimum silently; both infinities refused
  ```

  A control rules out ordinary overflow: a finite `1e308` into the same `decimal(10,2)` is refused.
  Relaxing `sql_mode` does not help and is worth knowing before anyone tries: with `sql_mode = ''` a
  `double` clamps infinity to `DBL_MAX`, `NaN` becomes NULL and every string literal becomes `0`, all
  without warnings, which turns the refusals into a fourth set of silent corruptions. None of this is
  a DRZL defect and none of it is fixable in a validator, but a test that writes to MySQL and checks
  only that the write succeeded is weaker than the same test against Postgres. The emitted schemas
  refuse all three regardless, which is why this is a caveat about tests rather than about rows.
