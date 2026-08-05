---
'@drzl/analyzer': minor
---

A view in your schema now produces schemas on drizzle-orm 0.x, as it already did on 1.0.0.

On every 0.x release a view answers `undefined` to `drizzle:Columns`, `drizzle:Name` and
`drizzle:Schema`; its columns and its name live only in `Symbol.for('drizzle:ViewBaseConfig')`. On
1.0.0 `View` declares all three as getters over that same config. The analyzer identifies a
table-like export by asking for `drizzle:Columns`, so on 0.x it skipped every view, and said
nothing about it. `@drzl/analyzer` and `@drzl/cli` both depend on `drizzle-orm@^0.45.2`, so the
broken major was the default one.

Probed with a fresh install of each: invisible on 0.29.5, 0.33.0, 0.36.4, 0.39.3, 0.44.7, 0.45.0
and 0.45.2; visible on 1.0.0-beta.1, beta.24, rc.1 and rc.4. Every dialect with a view API is
affected: `pgView`, `pgMaterializedView`, `mysqlView` and `sqliteView`, in their query-builder,
explicit-column-list, `.existing()` and schema-qualified forms alike.

**What changes for you.** On 0.x, a schema file with views now emits a module per view and a line
per view in the barrel, where it emitted nothing before. A fixture of 2 tables and 7 views went
from 3 emitted files to 10. A file of nothing but views also stops reporting
`dialect: unknown` with a spurious `DRZL_ANL_DIALECT` warning, because the loop that identifies
the dialect read the raw symbol rather than going through the resolver, and was the one read site
a fallback in the resolver did not reach.

The measured target was parity, and it is met: on a fixture covering join, aggregate, `.existing()`,
schema-qualified and materialized views, 0.45.2's analysis is byte-identical to 1.0.0-rc.4's, and
so is the emitted zod. 1.0.0-rc.4's own analysis is unchanged by this release.

**A SQLite view is now read-only.** SQLite refuses every write to a view, measured with
`node:sqlite`: `insert`, `update` and `delete` all fail with `cannot modify <name> because it is a
view`. That is the argument `readOnly` already makes for a materialized view, so a `sqliteView` now
carries it too and gets a select schema and nothing else. Postgres and MySQL both accept a write to
a simple auto-updatable view, verified against a real server on each, so their plain views are
unchanged.

**Two things a view inherits from Drizzle that the server does not agree with**, both already
present on 1.0.0 and neither addressed here. A view's columns keep the base column's `notNull` and
its `primary`, because that is what Drizzle records in `selectedFields`. Postgres reports every view
column nullable, so `SelectuserOrdersSchema` rejects `{"userId":2,"userName":"bob","total":null}`,
a row PGlite really returned from a `LEFT JOIN` view. MySQL agrees for the join column and disagrees
for the simple view's, computing nullability per column. Neither reports a primary key on a view,
while DRZL reports one for the join view and the service and oRPC generators build by-id, update and
delete endpoints on it. Both are filed.

New export: `isDrizzleView(val)`, which asks `drizzle:ViewBaseConfig` rather than
`drizzle:IsDrizzleView`; the latter looks like the obvious question and was only introduced in
drizzle-orm 0.39.0.
