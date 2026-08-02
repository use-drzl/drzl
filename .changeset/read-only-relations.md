---
'@drzl/generator-zod': minor
'@drzl/analyzer': minor
---

A materialized view gets a select schema and nothing else.

`INSERT INTO mv ...` fails with `cannot change materialized view`, verified against Postgres, so
`InsertuserStatsSchema` and `UpdateuserStatsSchema` described an operation the database will
always refuse. They are no longer emitted, along with their type aliases.

**If you import one of those, your build will now fail.** That is the point: the call it was
enabling could never have worked, and a compile error is a better way to find that out than a
runtime error from the database.

An ordinary view keeps all three. Postgres accepts an `INSERT` into a simple auto-updatable view,
and whether a given view qualifies depends on its query rather than on anything the schema file
states, so refusing them all would take away something that works. That distinction was checked
against Postgres rather than assumed: a plain `SELECT a, b FROM t` view accepts an insert, an
aggregate view does not, and a materialized view does not.

Detection is on Drizzle's own `PgMaterializedViewConfig` marker rather than on a name.
