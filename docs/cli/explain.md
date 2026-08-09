# Explain

Show what DRZL understood about **one table**: the type it resolved for every column, the facts it
measured, the constraints it will enforce, and the ones it read and could not use.

Usage:

::: code-group

```bash [pnpm]
pnpm dlx @drzl/cli explain <table> [--json] [-s src/db/schema.ts] [-c drzl.config.ts]
```

```bash [npm]
npx @drzl/cli explain <table> [--json] [-s src/db/schema.ts] [-c drzl.config.ts]
```

```bash [yarn]
yarn dlx @drzl/cli explain <table> [--json] [-s src/db/schema.ts] [-c drzl.config.ts]
```

```bash [bun]
bunx @drzl/cli explain <table> [--json] [-s src/db/schema.ts] [-c drzl.config.ts]
```

:::

Options:

- `<table>`: the table to explain. Omit it for the index of every table; see
  [The index](#the-index).
- `-s, --schema <path>`: the schema to read. Overrides the config.
- `-c, --config <path>`: which `drzl.config` to read the schema path from.
- `--json`, `-q, --quiet`: as everywhere else, see [Output & exit codes](/cli/output).

With neither flag it reads the `schema` path out of your `drzl.config.*`, then out of your
drizzle-kit config, and failing both it looks for a schema in the usual places and confirms a
candidate by importing it and finding Drizzle tables in it. So `drzl explain users` works in a
checkout with nothing configured at all.

It writes nothing, ever.

## When to reach for it

Your generated schema is wrong. Something about `users` validates a value the database refuses, or
refuses one it accepts, and the question is **where** it went wrong: did DRZL misread the column
type, drop the CHECK, fail to follow the relation, or read all three correctly?

Nothing else answers that. [`analyze`](/cli/analyze) prints the whole `Analysis` for the whole
schema as JSON and points at nothing in it. [`doctor`](/cli/doctor) prints only the findings, across
every table, and says nothing about a table that is fine. This prints everything about one table,
with the things it could not use called out at the bottom.

## Example

```bash
npx @drzl/cli explain users
```

```
users  src/db/schema.ts
  postgres, table "users", export "users", 13 columns

Columns
  COLUMN     TS TYPE   SQL TYPE                  NULL
  id         number    serial                    no    pk, has default
  email      string    varchar(255)              no    unique
  nickname   string    text                      yes   default 'anon'
  role       string    role                      no    default 'member'
  age        number    integer                   yes
  balance    string    numeric(10, 2)            no
  score      number    double precision          yes
  followers  bigint    bigint                    no
  visits     number    bigint                    no
  ref        string    uuid                      no
  tags       string[]  text[]                    yes
  payload    any       jsonb                     yes
  createdAt  Date      timestamp with time zone  no    has default

What the generators read off each column
  id         -2147483648 to 2147483647
             whole numbers only
             has a default
             not stated by any generated schema: the value is produced at insert
             time, by the database or by a Drizzle function, so the field is
             optional on insert and no schema states what it becomes
  email      at most 255 characters
  nickname   defaults to 'anon'
  role       one of 'admin', 'member', 'guest'
             defaults to 'member'
  age        -2147483648 to 2147483647
             whole numbers only
  score      fractions allowed
             NaN is stored and returned
             Infinity is stored and returned
  followers  -9223372036854775808 to 9223372036854775807
             whole numbers only
  visits     -9007199254740991 to 9007199254740991
             whole numbers only
  ref        text in the uuid format the database parses
  tags       an array of the type above
  payload    any JSON value, checked recursively
  createdAt  has a default
             not stated by any generated schema: the value is produced at insert
             time, by the database or by a Drizzle function, so the field is
             optional on insert and no schema states what it becomes

Keys
  PRIMARY KEY (id)  filled in by the database
  UNIQUE (email)
  INDEX (id)

Relations
  memberships -> users  one
  users -> memberships  many

CHECK constraints, as DRZL parsed them
  age_adult     CHECK (age >= 18)
                enforced
  nickname_len  CHECK (length(nickname) > 2)
                enforced
  email_shape   CHECK (email ~ '^[^@]+@[^@]+$')
                not enforced by any generated schema
                not a single comparison this version understands
  tags_present  CHECK (cardinality(tags) > 0)
                enforced

Not understood  (1)
  These are in your schema and are not in anything DRZL generates.

  - email_shape: email ~ '^[^@]+@[^@]+$' is not enforced: not a single
    comparison this version understands.
    Your database still enforces it. Nothing DRZL generates does.
```

The whole report fits a terminal 80 columns wide.

## What each section answers

### Columns

The **`TS TYPE`** is what the generated schema will accept and return, with the array depth on it:
`text().array()` is `string[]` here, because Drizzle gives an array no column class of its own and
reading the class alone is what once produced a schema for the element.

The **`SQL TYPE`** is the type as the database declares it, taken from Drizzle's own
`getSQLType()`. This is the wire, and it is the column to read first when a value round-trips
wrongly: `bigint` in `{ mode: 'number' }` and in `{ mode: 'bigint' }` are the same SQL type and two
different TypeScript ones, `int unsigned` is not `int`, and `varchar(255)` is not `text`.

The last cell carries what the column is to the table: `pk`, `unique`, `fk -> users.id`,
`generated`, and its default.

### What the generators read off each column

Every measured fact the validation generators act on: the range, whether it is whole, whether the
column stores `NaN` and the infinities, the declared width or byte cap, a format the database
parses, the enum members, the array depth, the structured shape, and the default.

A fact printed **in yellow with a reason under it** is one nothing generated states. That is the
line to read when your question is "why is my schema not checking this". There are two ways it
happens:

- **A default nobody can reproduce.** `defaultNow()`, `defaultRandom()`, `$defaultFn` and a
  `serial`'s sequence all produce their value at insert time. The field is optional on insert and no
  schema says what it becomes.
- **A width the value space already states another way.** A `varchar(32)` narrowed by
  `CHECK (label IN ('a','b'))`, an enum column, and a `uuid` or `numeric` column all state what they
  hold by their members or their format, and the width is never written. This is measured off the
  same guard the generators apply, not from a second copy of the rule, so the report and the emitted
  module cannot disagree.

### Keys, foreign keys, relations

The primary key **whole**, composite included, with a note when it is composite: the service and
router generators key `getById`, `update` and `delete` on its first column alone.

### CHECK constraints, as DRZL parsed them

Not the raw SQL. Each declared CHECK with the verdict a generated schema gives it, and where the
verdict is "not enforced", the parser's own reason. `age >= 18` folds into a range, `length(x) > 2`
becomes a predicate, `cardinality(tags) > 0` becomes an element count, and a regex or an
`OR` across two branches is refused whole, because a validator enforcing a *guess* at your
constraint rejects rows the database accepts.

### Not understood

Everything on this table that DRZL read and could not use, in one place:

- a CHECK, or one clause of one, that nothing enforces
- a column with no known type, whose validator will accept any value
- a relation the analyzer could not follow
- anything else the analyzer reported about this table

When there is nothing, it says so: `Nothing about this table was dropped or left unrecognised.`

## Finding the table by name

A table is matched against three names: its **database name**, its **schema-qualified name**
(`reporting.users`, and `public.users` for a table that declares no schema), and its **TypeScript
export name**, since a reader looking at their own schema file may only know
`export const orgMembers`.

Exact first, over all three. Only when nothing matches exactly are they tried again ignoring case,
and the report says so when that is how it matched.

A name reaching **two** tables is refused rather than resolved, because answering a question about
one table with facts about another is the one thing a diagnostic must not do:

```
$ drzl explain users
"users" names 2 tables (DRZL_EXPLAIN_002): reporting.users (exported as reportingUsers),
public.users (exported as users).
Name one of them exactly, for example "reporting.users".
```

A name reaching **none** lists the tables there are, with the near miss where there is one:

```
$ drzl explain userz
No table called "userz" (DRZL_EXPLAIN_001). This schema declares 3 tables: countries,
memberships, users.
Did you mean "users"?
```

## Your config's filters

`explain` reads your `drzl.config`, and a table your `include`/`exclude` removes is still found and
still explained, with a line saying the config removes it. That is the answer to "why is there no
file for this table", and a command that could not find it would be answering a different question.
Columns your `columns` filter removes are named the same way.

## The index

With no table argument it prints one line per table, with the number of things `explain` would
report as not understood for each. On a schema with forty tables and one wrong file, this is what
says which table to look at:

```
$ drzl explain
src/db/schema.ts  postgres
  3 tables

  TABLE        EXPORT       COLUMNS
  countries    countries    2
  memberships  memberships  4
  users        users        13       1 thing not understood

  drzl explain <table>  for one of them in full
```

## `--json`

One document, with the envelope merged in at the top level. See
[Output & exit codes](/cli/output#json).

```json
{
  "command": "explain",
  "exitCode": 0,
  "schema": "src/db/schema.ts",
  "dialect": "postgres",
  "table": {
    "name": "memberships",
    "tsName": "memberships",
    "qualified": "memberships",
    "addressable": "public.memberships",
    "readOnly": false,
    "matchedOn": "name",
    "matchedExactly": true,
    "columns": [
      {
        "name": "userId",
        "tsType": "number",
        "dbType": "INTEGER",
        "sqlType": "integer",
        "nullable": false,
        "hasDefault": false,
        "default": null,
        "isGenerated": false,
        "inPrimaryKey": true,
        "unique": false,
        "references": { "table": "users", "column": "id", "onDelete": "cascade" },
        "facts": [
          { "text": "-2147483648 to 2147483647", "stated": true },
          { "text": "whole numbers only", "stated": true }
        ]
      }
    ],
    "primaryKey": { "columns": ["orgId", "userId"], "generated": false },
    "unique": [{ "name": "membership_alt", "columns": ["userId", "joinedAt"] }],
    "indexes": [{ "columns": ["orgId", "userId"] }],
    "foreignKeys": [
      {
        "columns": ["userId"],
        "references": { "table": "users", "columns": ["id"] },
        "onDelete": "cascade"
      }
    ],
    "relations": [{ "kind": "one", "from": "memberships", "to": "users", "outgoing": true }],
    "constraints": [
      {
        "id": "memberships_userId_fkey",
        "kind": "foreignKey",
        "columns": ["userId"],
        "rule": "FOREIGN KEY (userId) REFERENCES users (id) ON DELETE cascade",
        "enforced": false,
        "references": { "table": "users", "columns": ["id"], "onDelete": "cascade" }
      }
    ],
    "gaps": []
  }
}
```

The keys, in the order they appear:

| Key                       | Meaning                                                                    |
| ------------------------- | -------------------------------------------------------------------------- |
| `schema`                  | the schema path, as it was resolved                                        |
| `dialect`                 | the dialect the analyzer measured                                          |
| `table`                   | the explanation. Present exactly when a table was named                    |
| `table.qualified`         | `reporting.users`, or the bare name for the default schema                 |
| `table.addressable`       | `public.users`: the spelling that reaches this table and no other          |
| `table.matchedOn`         | `name`, `qualified` or `tsName`                                            |
| `table.matchedExactly`    | `false` when the name matched only after case folding                      |
| `table.excludedByConfig`  | present and `true` when this config's filters remove the table             |
| `table.columnsRemovedByConfig` | present when this config's `columns` filter drops columns             |
| `table.columns[].default` | `null`, or `{ kind: "literal", value }`, `{ kind: "expression", text }` or `{ kind: "runtime" }` |
| `table.columns[].facts`   | `{ text, stated }`, plus `reason` where `stated` is `false`                |
| `table.constraints`       | every constraint with `enforced`, and `unenforced` clauses with reasons     |
| `table.gaps`              | what DRZL read and could not use: `{ kind, subject?, message, hint? }`      |

`table.gaps[].kind` is `check`, `column`, `relation` or `analyzer`.

With no table argument the document carries `tables` instead of `table`: one summary per table,
`{ name, tsName, schema?, qualified, columns, checks, gaps }`.

## Exit codes

| Code | When                                                                                 |
| ---- | ------------------------------------------------------------------------------------ |
| `0`  | the table was explained, whatever the report says about it                           |
| `1`  | no such table, an ambiguous name, or no schema DRZL could read                       |

`2` is not used. A CHECK nothing enforces is a normal, usable schema, and a command that failed a
pipeline for one would be switched off within a week. That is `doctor --strict`'s job; see
[Exit codes](/cli/output#exit-codes).

| Code              | Meaning                                        |
| ----------------- | ---------------------------------------------- |
| `DRZL_EXPLAIN_001` | There is no such table; the message lists the ones there are |
| `DRZL_EXPLAIN_002` | The name reaches more than one table          |
| `DRZL_SCHEMA_001` | The schema is missing, or the module would not import |
| `DRZL_SCHEMA_002` | The schema imported cleanly and declares no tables |
| `DRZL_CFG_001`    | There is no config, no drizzle-kit config and no schema to be found |

## See also

- [Doctor](/cli/doctor): the same silent failures, across every table, and nothing else
- [Analyze](/cli/analyze): the whole `Analysis` as JSON
- [Output & exit codes](/cli/output)
