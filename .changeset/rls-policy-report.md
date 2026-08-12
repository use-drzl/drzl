---
'@drzl/analyzer': minor
'@drzl/cli': minor
---

Read `pgPolicy` in the analyzer, and add `drzl doctor --policies`, which reports the row-level
security policies each table carries and what they refuse.

```bash
drzl doctor --policies
```

The analyzer read none of this before. A policy names no columns, so it fell through the
extra-config traversal's column guard and was dropped in silence, and every generated service was
built from a schema DRZL believed had no security rules at all. `Table` now carries `policies` and
`rlsEnabled`, including policies attached with `pgPolicy(...).link(table)`, which leave no trace on
the table they link to and are found as module exports instead.

**The headline is a table that returns nothing forever.** With row-level security on and no policy
granting a command, that command does not half-work: the read returns zero rows and the write
raises `new row violates row-level security policy`. The generated service over it still compiles
and its return type still promises rows. Measured against Postgres 18.3 through PGlite: on a table
with RLS enabled and no policies, the owner saw two rows, a plain role saw none, and its insert was
refused.

**Three readings this deliberately does not make**, each settled by running it rather than by
reading the declaration:

- **A table with policies and no `.enableRLS()` is not unprotected.** `drizzle:EnableRLS` is
  independent of the policies, and declaring any policy makes `drizzle-kit` emit
  `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` on its own. A report keyed on that flag would have
  told people their security rules were inert while Postgres was enforcing them.
- **A write policy with no `WITH CHECK` refuses writes; it does not wave them through.** A lone
  `FOR INSERT` policy carrying no `WITH CHECK` rejected every insert. This is reported as a door
  that is shut, which is the opposite of what the obvious reading gives.
- **`FOR UPDATE` and `FOR ALL` with a `USING` and no `WITH CHECK` are not defects.** Both fall back
  to the `USING` expression for the new row: moving a row out of the `USING` set under
  `FOR UPDATE ... USING (owner_id = 1)` raised the same violation, while the identical policy with
  `WITH CHECK (true)` allowed it. Flagging those would be a false positive on the most ordinary
  policy anybody writes.

A `to` is normalised to role names before it is reported. Drizzle takes a bare string, a `pgRole`
object or an array mixing the two, and the middle one stringifies to `[object Object]` in the one
field of a security rule nobody can afford to misread.

The report ends with the fact no schema change fixes: **no generator emits policy awareness**, so a
generated read path describes rows the caller may not be allowed to see. That is listed rather than
counted as a finding, so `--strict` cannot fail a pipeline nobody can make pass.

`--constraints` and `--policies` are separate reports and passing both is an error rather than a run
that silently picks one. Non-Postgres dialects carry no `rlsEnabled` at all, rather than `false`,
so they are absent from the report instead of listed as having row-level security switched off.

`doctor`'s existing output is unchanged when neither flag is passed.
