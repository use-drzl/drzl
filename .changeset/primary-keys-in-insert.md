---
'@drzl/validation-core': major
'@drzl/generator-zod': major
'@drzl/generator-valibot': major
'@drzl/generator-arktype': major
'@drzl/analyzer': minor
---

**Breaking:** insert schemas now contain the primary key when the database does not supply one.
They omitted it unconditionally, so for a natural or non-generated key the schema could not
express a valid insert: the required column was simply absent, with no way to provide it.

`isGeneratedColumn` answered `c.isGenerated || primaryKeyColumns.includes(c.name)`, dropping
every primary key whether or not the database generated it. Being a key says nothing about who
supplies the value. The question is whether the database provides one, which `isGenerated`
answers for columns that cannot be written and `hasDefault` for columns that need not be.

### What changes

| column | before | after |
|---|---|---|
| `serial('id').primaryKey()`, pg | omitted | present, **optional** |
| `integer('id').primaryKey().generatedAlwaysAsIdentity()`, pg | omitted | present, **optional** |
| `integer('id').primaryKey()`, pg | omitted | present, **required** |
| `text('slug').primaryKey()` | omitted | present, **required** |
| `integer('id').primaryKey()`, sqlite | omitted | present, **optional** |
| `int('id').primaryKey().autoincrement()`, mysql | omitted | omitted |

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
