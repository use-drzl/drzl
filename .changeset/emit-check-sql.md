---
'@drzl/cli': minor
---

Add `drzl doctor --constraints --sql`, which emits the statements alone so they can be redirected
into a migration, and make the constraint fix dialect aware.

```bash
drzl doctor --constraints --sql > drizzle/0004_close_constraint_drift.sql
```

The report added in the previous release prints the `ALTER TABLE ... ADD CONSTRAINT` that would close
each gap. This makes that output applicable rather than only readable: no prose, no colour, ordered
by table and column so the file is stable between runs and diffs cleanly, and empty when there is no
drift rather than a file of comments that looks like a migration whose statements were deleted.

**It also fixes a defect in that report.** The fix string was built with no dialect check, and
**SQLite refuses `ALTER TABLE ... ADD CONSTRAINT` outright**. Measured against `node:sqlite`:

```
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('draft','live'))
  -> near "CONSTRAINT": syntax error

ALTER TABLE users ADD COLUMN extra TEXT CHECK (extra IN ('a','b'))
  -> accepted
```

SQLite takes an inline CHECK on a *new* column and has no way to add one to an existing column, so
the route is the twelve-step table rebuild it documents. A SQLite user was therefore handed a
statement that could not run. Printing nothing would have been better than that; printing the reason
is better still, so a gap with no single-statement fix now carries a `noFix` explaining what the
dialect actually needs, and both renderers say it.

`unknown` gets no statement either, and that is deliberate. The analyzer says `unknown` when it could
not tell which database this is, and emitting DDL for a database nobody has named is exactly the kind
of confident guess that ends up in a migration.

`--sql` without `--constraints` is an error rather than an implication. A flag that silently turns
another one on is the kind of thing that later reads as a bug.
