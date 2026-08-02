---
'@drzl/analyzer': patch
'@drzl/validation-core': minor
'@drzl/generator-zod': minor
'@drzl/generator-valibot': minor
'@drzl/generator-arktype': minor
'@drzl/generator-typebox': minor
'@drzl/cli': minor
---

Emit a batch duplicate finder, and stop reading a table-level `unique()` as the primary key

`{ duplicateFinder: true }` on any of the four validation generators also emits
`findDuplicate<Table>`: the rows in a batch that collide with an earlier row on a unique
constraint.

Uniqueness is the one constraint a per-row validator structurally cannot check, since it is a fact
about the table rather than the row. What needs no database is whether a batch collides with
itself, and that is the half a user can fix before sending anything. It matters for bulk inserts,
where a thousand rows fail whole on one collision and the error names a constraint rather than a
row.

The finder follows SQL on null: a constraint is skipped for any row where one of its columns is
null or absent, because NULL is not equal to NULL and a unique index permits repeats. Composite
keys compare by JSON, so `[1, '2']` never collides with `['1', 2]`. The emitted function is plain
TypeScript with no reference to any validation library, so all four generators emit the same one.

Building it surfaced an analyzer bug it depended on. A table-level `unique('name').on(a, b)` keeps
its columns directly on the builder and carries no `unique` flag, which is also true of a primary
key builder, and the rule was "no flag means primary key". So the constraint was not merely
lost: a table keyed on `id` reported a composite primary key on whatever the unique named, which
is what the service and router generators build their lookups from. Builders are now told apart by
`drizzle:entityKind`.
