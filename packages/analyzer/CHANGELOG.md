# @drzl/analyzer

## 1.5.0

### Minor Changes

- b0543a4: **Breaking:** insert schemas now contain the primary key when the database does not supply one.
  They omitted it unconditionally, so for a natural or non-generated key the schema could not
  express a valid insert: the required column was simply absent, with no way to provide it.

  `isGeneratedColumn` answered `c.isGenerated || primaryKeyColumns.includes(c.name)`, dropping
  every primary key whether or not the database generated it. Being a key says nothing about who
  supplies the value. The question is whether the database provides one, which `isGenerated`
  answers for columns that cannot be written and `hasDefault` for columns that need not be.

  ### What changes

  | column                                                       | before  | after                 |
  | ------------------------------------------------------------ | ------- | --------------------- |
  | `serial('id').primaryKey()`, pg                              | omitted | present, **optional** |
  | `integer('id').primaryKey().generatedAlwaysAsIdentity()`, pg | omitted | present, **optional** |
  | `integer('id').primaryKey()`, pg                             | omitted | present, **required** |
  | `text('slug').primaryKey()`                                  | omitted | present, **required** |
  | `integer('id').primaryKey()`, sqlite                         | omitted | present, **optional** |
  | `int('id').primaryKey().autoincrement()`, mysql              | omitted | omitted               |

  An auto-generated key stays absent, since it cannot be written. A defaulted key is present and
  optional, so it may be supplied or left out; previously neither was possible. A key the caller
  has to supply is present and required, which is what makes the insert expressible at all.

  This can fail a build that regenerates, and that is the point: those call sites were building
  inserts with no primary key, which the database would have rejected at runtime. Postgres does
  not generate `integer('id').primaryKey()`; only `serial` and identity columns are generated.

  ### The analyzer half

  `hasDefault` was computed from `col.default` and `col.config.default`, neither of which Drizzle
  populates. It now reads `col.hasDefault`, which Drizzle does set, plus `defaultFn` for runtime
  defaults. Without this the two halves of the table above are indistinguishable: every Postgres
  `serial`, every identity column and every SQLite rowid alias reported `hasDefault: false`,
  exactly like a plain `integer('id').primaryKey()`.

  That fix also reaches ordinary columns: any column whose default came from `.default()` or
  `.$defaultFn()` was previously reported as having none, so it was emitted as required in insert
  schemas rather than optional.

  `@drzl/generator-orpc` already filtered on `isGenerated` alone for its inline schemas, so its
  output was correct and is unchanged apart from the improved `hasDefault` signal. The standalone
  validation generators and the shared schemas disagreed with it until now.

## 1.4.0

### Minor Changes

- 53a72d2: Foreign keys, relations, indexes, composite primary keys and check constraints are now actually
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

## 1.3.0

### Minor Changes

- 549ee51: Type `numeric` and `decimal` columns as strings, matching what Drizzle returns.

  Generated validators previously typed them as numbers, so a select schema
  rejected every row the database returned ("expected number, received string"),
  and an insert schema rejected the string the driver wants while accepting a
  number it does not.

  `bigint({ mode: 'number' })` is now read as a number rather than a bigint, and
  `real`/`doublePrecision` are separated from `numeric` since those really are
  JS numbers.

  If you were working around the old behaviour by coercing numeric values, that
  workaround should be removed.

## 1.2.0

### Minor Changes

- c48d79a: sponsor initiatives

## 1.1.0

### Minor Changes

- 2ca4b77: Fix ArkType generator emitting double-wrapped enum strings; pgEnum unions now render with JSON-escaped literals so `drzl generate` succeeds even when

## 1.0.0

### Major Changes

- 5da6f6b: support MySQL, SingleStore, and Gel; expand Postgres/SQLite; add tests (fixes #13)

## 0.3.0

## 0.2.0

## 0.1.0

## 0.0.3

## 0.0.2

## 0.0.1
