---
'@drzl/analyzer': minor
---

Foreign keys, relations, indexes, composite primary keys and check constraints are now actually
detected. Every one of them silently came back empty before, on current stable Drizzle.

`analyze --relations` and `includeRelations` are documented features that returned `relations: []`
for every schema, and `Column.references` was always `undefined`. Four independent causes:

- **Foreign keys were read from `col.references`**, which does not exist on a Drizzle column.
  The real data lives per dialect under `drizzle:PgInlineForeignKeys`,
  `drizzle:MySqlInlineForeignKeys` and `drizzle:SQLiteInlineForeignKeys`, none of which the
  analyzer referenced.
- **The table's extra-config callback was invoked with the table** where Drizzle passes its
  `ExtraConfigColumns`. That throws, and the throw sat under a bare `catch {}`, so every index,
  unique index, composite primary key, check constraint and table-level foreign key was
  discarded without a word.
- **`relations()` was read as `val.config.relations`.** `config` is a function, so the expression
  was always `undefined` and the branch never executed.
- **Enums were only collected when relations were requested**, so a caller that just wanted
  tables got none.

New in the analysis:

- `Table.foreignKeys`, including composite keys. Single-column keys are also mirrored onto
  `Column.references`.
- Relations derived from foreign keys in both directions, `one` from the child and `many` from
  the parent, deduplicated against anything `relations()` already declared.
- Many-to-many inference through a join table, reported as `kind: 'manyToMany'` with `via`. Only
  tables whose every column participates in a foreign key qualify, so a table carrying its own
  data is never mistaken for plumbing.
- Check constraint expressions render as readable SQL instead of `[object Object]`.

Column names in foreign keys, indexes and keys are TypeScript property names, matching
`Column.name`, rather than the database names Drizzle reports internally. Postgres reports
`no action` for a referential action where MySQL and SQLite report nothing; since that is the
default, it is normalised away so the same schema analyses identically across dialects.

A table whose extra-config callback throws now records a `DRZL_ANL_EXTRACONFIG` issue instead of
losing its constraints silently, and an unreadable `relations()` records `DRZL_ANL_RELATIONS`.

Heuristic name-based relations, still off by default, now only fire for columns that carry no
real foreign key, so a properly constrained schema is never second-guessed.

Tested against real drizzle-orm rather than stand-in classes. The existing suites build fake
`PgInteger`-style classes, which cannot reproduce any of this and were green throughout.
