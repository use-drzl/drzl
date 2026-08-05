# views-not-relations-0-4x: fixed

Branch `fix/views-on-0-4x`, one commit on top of `b0822df`. Status: **done**, with two inherited
defects filed rather than fixed and one pre-existing generator gap filed.

## What was wrong

A drizzle-orm 0.x view answers `undefined` to all three of `drizzle:Columns`, `drizzle:Name` and
`drizzle:Schema`. Its columns and its name live only in `Symbol.for('drizzle:ViewBaseConfig')`. On
1.0.0 the `View` class declares those three as prototype getters over that same config
(`node_modules/drizzle-orm/sql/sql.js`, the `View` class: `[TableName]`, `[TableSchema]` and
`[TableColumns]` return `this[ViewBaseConfig].name / .schema / .selectedFields`), so a view answers
exactly as a table does. It is prototype getters, not a Proxy as the salvaged measurement said; the
observable behaviour is the same.

The analyzer identifies a table-like export by asking for `drizzle:Columns`, so on 0.x it skipped
every view and raised no issue. `packages/analyzer/package.json` and `packages/cli/package.json`
both pin `drizzle-orm@^0.45.2`, so the broken major was the default one.

## The read sites: the measurement named four, and four is the number

Verified by enumerating every `drizzle:Columns`, `drizzle:Name` and `drizzle:Schema` read in
`packages/analyzer/src/index.ts`, and every `Symbol.for(` read in every other package.

| site | before | reached by a resolver-only fix |
| --- | --- | --- |
| discovery gate, `analyze()` | `this.getSymbol(val, 'drizzle:Columns')` | yes |
| `analyzeTable` columnsObj | `this.getSymbol(tbl, 'drizzle:Columns')` | yes |
| `analyzeTable` name and schema | `this.getSymbol(tbl, 'drizzle:Name' / 'drizzle:Schema')` | yes |
| dialect loop | `(val)[Symbol.for('drizzle:Columns')]` **direct** | **no** |

There is no fifth. `grep -n "Symbol.for(" packages/analyzer/src/index.ts` returns exactly one other
`drizzle:Columns` read, which is the dialect loop above; the remaining hits are
`drizzle:entityKind` on a column's constructor, which a view's columns answer normally because they
are the base table's column objects. `grep -rn "Symbol.for(" packages/*/src/*.ts` outside the
analyzer returns nothing at all: no other package reads a Drizzle symbol. The enum capture inside
the discovery loop reads the `cols` local the gate produced, so it follows the gate.

`getSymbolOf` at `:704`/`:717`/`:718` (relations v2) and `this.getSymbol` at `:841`/`:895` (foreign
tables, `relations()` objects) share the resolver and are unaffected either way, as the measurement
said.

### The partial-fix experiment, run rather than argued

With the resolver fixed and the dialect loop left as it was, on a file of nothing but two pg views:

```
dialect=unknown  relations=2  issues=["DRZL_ANL_DIALECT"]
```

and with both fixed, `dialect=postgres relations=2 issues=[]`. So the fourth site is load-bearing
and is now guarded by a test.

**The measurement's stated consequence of that state is wrong.** It says `dialect: unknown` "drops
every column to its coarse default". Measured in exactly that state, the columns are untouched:

```
id -> number/INTEGER   label -> string/TEXT   live -> boolean/BOOLEAN   seen -> Date/TIMESTAMP
```

`analyzeTable` reads each column object directly and never consults the dialect, and the dialect is
computed after every table has already been analysed. The real cost of the missed site is that
`analysis.dialect` is wrong in the CLI's `analyze --json` output and in the public `Analysis` type,
plus a spurious `DRZL_ANL_DIALECT` warning whose hint ("Column types will fall back to their coarse
defaults") does not apply to that case. No generator reads `analysis.dialect` at all
(`grep -rn "\.dialect\b" packages/*/src/*.ts` outside the analyzer: no hits). The comment in the
source now says the measured thing.

## A version fact the salvaged measurement did not have

Sweeping 11 published versions with a fresh `npm i` each, probing own symbols as well as lookups:

```
0.29.5   viewOwn ["drizzle:ViewBaseConfig","drizzle:PgViewConfig"]                          IsDrizzleView: ABSENT
0.33.0   same                                                                               IsDrizzleView: ABSENT
0.36.4   same                                                                               IsDrizzleView: ABSENT
0.39.3   viewOwn ["drizzle:ViewBaseConfig","drizzle:IsDrizzleView","drizzle:PgViewConfig"]  IsDrizzleView: present
0.44.7 / 0.45.0 / 0.45.2                                                                    IsDrizzleView: present
1.0.0-beta.1 / beta.24 / rc.1 / rc.4                                                        IsDrizzleView: present
```

`drizzle:IsDrizzleView` was introduced in 0.39.0. It reads like the obvious way to recognise a view
and it is not there to be asked on three of the seven 0.x releases probed. `drizzle:ViewBaseConfig`
is an own symbol on all eleven, so `isDrizzleView()` asks that instead. The first draft of this fix
used `IsDrizzleView` and would have silently not marked a `sqliteView` read-only on drizzle < 0.39.

`drizzle:Columns`, `drizzle:Name` and `drizzle:Schema` are undefined on all seven 0.x and answered
on all four 1.0.0, matching the salvaged measurement exactly.

## The fix

`packages/analyzer/src/index.ts`, five small regions:

1. `getSymbolOf` gains a fallback: when a lookup misses, and the key is one of the three a view
   holds in its config, read `drizzle:ViewBaseConfig` and take `selectedFields` / `name` / `schema`.
   Own-symbol scanning is split into `ownSymbolOf` so the fallback cannot recur. The analyzer still
   does not import drizzle-orm.
2. The class's private `getSymbol` was a second, identical copy of that resolver. It now delegates,
   so the two cannot drift and a fallback added to either reaches every caller of both.
3. New export `isDrizzleView(val)`, asking `drizzle:ViewBaseConfig`.
4. The dialect loop reads through the resolver.
5. A SQLite view is marked `readOnly` once the dialect is known.

## Parity, which was the success criterion

Harness: the analyzer **source** loaded with jiti from two trees, one with `drizzle-orm@0.45.2` and
one with `1.0.0-rc.4`, over the same 9-export fixture (2 tables, a simple view, a `LEFT JOIN` view,
an aggregate view with a raw `sql` alias, an `.existing()` view with an explicit column list, a
materialized view, a schema-qualified view and a schema-qualified materialized view). Tables and
relations sorted, then `JSON.stringify(..., null, 2)`.

```
md5 4b495a36680e2bb3e729045955c61a49  v1 before the fix
md5 4b495a36680e2bb3e729045955c61a49  v1 after the fix
md5 4b495a36680e2bb3e729045955c61a49  0.45.2 after the fix
md5 8e56c016cc109cd19db1e0f0cd5bd745  0.45.2 before the fix   (2 relations, not 9)
```

Byte-identical three ways, and v1's own output is untouched by this change. The emitted zod is
byte-identical too: `diff -r out-d04 out-v1` is empty over 10 files. Before the fix that directory
held 3 files (`index.ts`, `orders.zod.ts`, `users.zod.ts`).

The same check on the fixture the committed test builds (8 exports, no aggregate view): identical,
`issues: []` on both majors.

The readOnly rule survives: `reportMv.zod.ts` exports `SelectreportMvSchema` and nothing else, on
both majors, because `drizzle:PgMaterializedViewConfig` is an own symbol on all eleven releases.

Degradation is identical on both majors too: the aggregate view's `sql` alias becomes one `unknown`
column with `DRZL_ANL_UNKNOWN_COLUMN`, on 0.45.2 and on rc.4 alike.

## What the databases said

**SQLite** (`node:sqlite`, Node 22):

```
FAIL insert into active_users  -> cannot modify active_users because it is a view
FAIL update active_users       -> cannot modify active_users because it is a view
FAIL delete from active_users  -> cannot modify active_users because it is a view
pragma table_info(active_users): every column notnull=0, pk=0
```

So a `sqliteView` insert or update schema describes an operation SQLite always refuses, and that is
the same argument the code already makes for a materialized view. `sqliteView` is now `readOnly`.

**Postgres** (PGlite 0.5.4, PostgreSQL 18):

```
OK   insert into simple view     -> the row really appears in users
OK   update simple view
FAIL insert into join view       -> cannot insert into view "user_orders"
FAIL update join view            -> cannot update view "user_orders"
FAIL delete from join view       -> cannot delete from view "user_orders"
FAIL insert into matview         -> cannot change materialized view "user_stats"
FAIL update matview              -> cannot change materialized view "user_stats"
is_nullable: every column of every view = YES, including active_users.name whose base is NOT NULL
pg_class/pg_index: active_users v/0 pks, user_orders v/0 pks, user_stats m/0 pks, users r/1 pk
select * from user_orders -> {"userId":2,"userName":"bob","total":null}
```

**MySQL 8.4.11** (my own container, started and removed; the other agents' containers untouched):

```
OK   insert into simple view     -> the row really appears in users
OK   update simple view
FAIL insert into user_orders     -> ERROR 1471 not insertable-into
FAIL update/delete user_orders   -> ERROR 1288 not updatable
FAIL insert into order_totals    -> ERROR 1471
information_schema.views is_updatable: active_users YES, user_orders NO, order_totals NO
is_nullable: user_orders.total = YES although orders.total is NOT NULL;
             active_users.id and .name = NO
no PRIMARY constraint on any view
```

Postgres and MySQL both accept a write to a simple auto-updatable view, so leaving their plain views
writable stays right for the simple case and over-permissive for the join case. That is unchanged
and is not made worse here.

**One correction to the salvaged measurement.** It says "no database gives a view column a
NOT NULL". MySQL does: `active_users.id` and `active_users.name` are `is_nullable=NO`. Postgres
reports YES for everything, MySQL computes it per column. So the nullability defect below is
dialect-dependent, not universal.

## Tests

Both were written first and watched fail for the right reason.

`packages/analyzer/test/views-0.4x.spec.ts`, 8 cases, all 8 red before the fix. The reds were the
real ones: `expected 'unknown' to be 'postgres'` for the views-only dialect case, and
`Cannot read properties of undefined` everywhere a view should have been a table.

`packages/cli/test/views.e2e.spec.ts`, 4 cases, all 4 red before the fix with
`no activeUsers.zod.ts was emitted; got: index.ts, schema.mjs, users.zod.ts`. This one builds a real
Drizzle schema, runs the real analyzer, emits with the real generator, **imports the emitted
module**, and hands its schema a row a real SQLite returned from a real view; it also executes the
insert SQLite refuses and asserts on the message before asserting that no insert schema was emitted.
It lives in `packages/cli` because that is the only package with both `drizzle-orm` and the
generators.

The pre-existing `packages/analyzer/test/materialized-views.spec.ts` is left alone. It hand-builds
objects and calls `isReadOnlyRelation` directly, so it passes on both majors while the feature is
dead on one; the two new files are the ones that can fail.

Full run, all green: **943 tests / 110 files** (`pnpm -r test`), up from 931/108. `pnpm build`,
`pnpm typecheck` and `pnpm lint` all clean.

## verify-packed

`pnpm verify:packed` was run **read-only** and passed, ending on its `OK: 12 packages packed, ...`
banner under `set -euo pipefail`. `git diff -- scripts/verify-packed.sh` is empty.

**No count and no ledger in it moves.** Its fixtures contain no view of any kind
(`grep -n "pgView\|sqliteView\|mysqlView\|MaterializedView" scripts/verify-packed.sh` returns one
hit, and it is a word inside the comment quoted below), so nothing it measures is touched by this
change.

**One hand-off for whoever owns that file.** The comment at `scripts/verify-packed.sh:5781-5785`
says `readOnly` is outside the cross-major field coverage because "`pgMaterializedView` answers a
`drizzle:Columns` lookup on 1.0.0-rc.4 and returns undefined on 0.45.2, so the analyzer sees no
0.4x view of any kind as a relation ... Covering `readOnly` means dealing with that first." That is
now dealt with. Adding a `pgMaterializedView` to the cross-major parity fixture makes `readOnly`
land on both sides and closes the one field that stage names as uncovered. Left alone here.

## Filed, not fixed

**1. A view's columns keep the base column's `notNull`.** Drizzle's `selectedFields` clone the base
columns, so DRZL reports `user_orders.total` as `nullable: false` and emits
`total: z.number().int()...`, which **rejects** `{"userId":2,"userName":"bob","total":null}`, a row
PGlite really returned. Postgres reports every view column nullable; MySQL widens only the ones the
outer join makes optional. Already wrong on 1.0.0 today; this change makes it reachable on 0.x too.
Fixing it means deciding whether a view's nullability follows the server (which differs by dialect)
or the query, and it changes every view's emitted select schema on both majors. Too large for this
commit; stated in the changeset.

**2. A view is reported with a primary key it does not have.** The cloned base column carries
`primary: true`, so the analysis says `user_orders.primaryKey = {columns: ['userId']}`. No catalog
agrees: `pg_index.indisprimary` gives 0 primary keys for relkind `v` and `m`, MySQL has no `PRIMARY`
constraint on any view, and SQLite's pragma reports `pk=0`. Generated, the consequence is real:
`userOrderService.getById(id) / update(id, ...) / delete(id)` and oRPC `create/update/delete` on a
view Postgres refuses to update or delete. Removing it changes the shape of the service and oRPC
output for every view on both majors. Filed.

**3. Six of seven generators ignore `readOnly`.** `grep -rn "readOnly" packages/*/src/*.ts` finds it
only in `@drzl/analyzer` and `@drzl/generator-zod`. Verified by generating: for the materialized view
`reportMv`, zod correctly emits `SelectreportMvSchema` alone, while `generator-service` emits
`create`, `update` and `delete` methods and `generator-orpc` emits `create/update/delete` procedures.
Neither breaks a build (service emits its own `types/` and oRPC inlines its schemas, so nothing
imports the insert schema zod withholds), but both offer a call the database always refuses. Already
true on 1.0.0; newly reachable on 0.x. Filed rather than fixed: it is a change in six packages.

## Files

- `packages/analyzer/src/index.ts` (+74/-15, five regions)
- `packages/analyzer/test/views-0.4x.spec.ts` (new, 8 cases)
- `packages/cli/test/views.e2e.spec.ts` (new, 4 cases, executes the emitted module)
- `docs/generators/zod.md` (the unconditional "views get schemas too" promise is now true, plus the
  SQLite read-only fact and a warning naming defects 1 and 2)
- `.changeset/views-on-drizzle-0-4x.md` (`@drzl/analyzer`: minor)
