# Doctor

Report what DRZL **cannot** type or enforce in your schema, and what to do about each one.

Usage:

::: code-group

```bash [pnpm]
pnpm dlx @drzl/cli doctor [schema] [--json] [--strict] [-c drzl.config.ts]
```

```bash [npm]
npx @drzl/cli doctor [schema] [--json] [--strict] [-c drzl.config.ts]
```

```bash [yarn]
yarn dlx @drzl/cli doctor [schema] [--json] [--strict] [-c drzl.config.ts]
```

```bash [bun]
bunx @drzl/cli doctor [schema] [--json] [--strict] [-c drzl.config.ts]
```

:::

With no `schema` argument it reads the `schema` path out of your `drzl.config.*`, so a project that
already has one needs only `drzl doctor`. A config without a `schema` key resolves through your
drizzle-kit config, exactly as `generate` does.

## Why this is not `analyze`

[`drzl analyze`](/cli/analyze) prints the whole `Analysis` as JSON. That is a description of your
schema, and reading trouble out of it means knowing which fields mean trouble.

`doctor` is the other thing: the list of what will silently not work. Both failure modes it reports
produce a generated file that exists, compiles and validates nothing:

- a column DRZL cannot type gets a validator that accepts **any** value
- a CHECK constraint DRZL will not translate is simply **absent** from the output

## Example

```bash
npx @drzl/cli doctor src/db/schema.ts
```

```
DRZL doctor  src/db/schema.ts
postgres, 1 table, 11 columns, 12 CHECK constraints

Columns DRZL cannot type  (2)
  These get a validator that accepts any value.

  - Column "balance" on table "accounts" has no known type (SQL type numeric(12,2)), so its
    validator will accept any value.
  - Column "credit" on table "accounts" has no known type (SQL type numeric(12,2)), so its
    validator will accept any value.
    A customType has no runtime shape to read. Declare it with .$type<T>() and turn on
    typedColumns to give the validator the type.

CHECK constraints DRZL does not enforce  (9)
  Your database still enforces these. Nothing DRZL generates does.

  - CHECK "age_or" on "accounts" is not translated: contains OR. Expression: age >= 18 OR age <=
    65
  - CHECK "email_re" on "accounts" is not translated: not a single comparison this version
    understands. Expression: email ~ '^[a-z]+$'
    Only constraints whose meaning is unambiguous are translated, because a validator enforcing
    a guess rejects rows the database accepts. Your database still enforces this one; nothing
    DRZL emits does.

  - CHECK "tags_scalar" on "accounts" compares an array column "tags" against a scalar literal,
    which does not describe it, so it is not translated. Expression: tags = '{}'
    On an array column only cardinality(col) is read, since it is the one comparison that is
    about the array rather than about an element.

11 findings in src/db/schema.ts. None of these stop DRZL generating; they are what it will not
check for you.
```

A healthy schema says so, and says what was looked at, so a clean run cannot be confused with a
command that failed to run:

```
DRZL doctor  src/db/schema.ts
postgres, 3 tables, 6 columns, 0 CHECK constraints

Nothing to report.
  Every column has a type DRZL can describe.
  Every CHECK constraint is translated into the generated validators.
  Every table has a primary key the generators can use.
```

## What it reports

| Section                                 | What it means                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| Columns DRZL cannot type                | The emitted validator accepts any value for this column                            |
| CHECK constraints DRZL does not enforce | The constraint is in your schema and in your database, and in no schema DRZL emits |
| Primary keys the generators cannot use  | `getById`, `update` and `delete` are keyed on one column                           |
| Other findings                          | Everything else the analyzer said while reading the schema                         |

Four CHECK cases are distinguished, because they have different fixes:

- **Not translated.** The shared parser refused the expression and says why: `contains OR`,
  `right side is not a literal`, and so on. See the skip list in
  [Generators → Zod](/generators/zod#check-constraints); the same parser serves all four validation
  generators.
- **Names a column the table does not have.** Usually a typo, or a constraint that spans two tables.
- **Compares an array or structured column against a scalar literal.** `tags = '{}'` on a `text[]`
  says nothing usable about the array, so it is skipped rather than guessed at. On an array column
  only `cardinality(col)` is read.
- **Counts a column whose count JavaScript cannot take the way the database did.**
  `octet_length(bin) <= 8` on a MySQL `varbinary(8)`: the value arrives as a string produced by a
  lossy decode, so neither its characters nor their UTF-8 re-encoding is the number the server took.
  The same expression on a `text` or a `bytea` column **is** enforced, and is not listed.

A constraint DRZL **does** translate is not listed. `age >= 18` folds into `.gte(18)` and
`start_date < end_date` becomes an object-level refinement, and listing those would bury the ones
that matter.

## Exit codes

| Code | When                                                                             |
| ---- | -------------------------------------------------------------------------------- |
| `0`  | The schema was read. Findings may have been reported.                            |
| `1`  | The schema could not be read at all: the file is missing, or importing it threw. |
| `2`  | Findings were reported **and** `--strict` was passed.                            |

**Zero by default is deliberate.** A schema carrying a `customType`, or a CHECK this parser will
not guess at, is normal and usable, and a doctor that failed every pipeline reading one would be
switched off within a week. `--strict` is how you opt into a gate:

```yaml
- run: npx @drzl/cli doctor --strict
```

This differs from `analyze`, which exits `2` on an error-level issue, because there `error` means
"the JSON you asked for is not there". `doctor` always has a report to print.

## `--json`

```bash
npx @drzl/cli doctor src/db/schema.ts --json
```

```json
{
  "schema": "src/db/schema.ts",
  "dialect": "postgres",
  "ok": false,
  "counts": { "tables": 2, "columns": 5, "checks": 0, "findings": 2 },
  "findings": [
    {
      "kind": "partial-primary-key",
      "level": "warn",
      "table": "composite",
      "message": "Table \"composite\" has a composite primary key (a, b). ...",
      "hint": "Treat the generated service as a starting point for this table and widen the key by hand."
    }
  ]
}
```

`kind` is a stable identifier, so a CI step can count one category without matching on prose:

```bash
npx @drzl/cli doctor --json \
  | node -e "const r=JSON.parse(require('fs').readFileSync(0,'utf8'));
             const n=r.findings.filter(f=>f.kind==='unknown-column').length;
             if (n) { console.error(n+' untypeable column(s)'); process.exit(1); }"
```

Values are `unknown-column`, `check-declined`, `check-unknown-column`, `check-not-scalar`,
`check-uncountable`, `no-primary-key`, `partial-primary-key` and `analyzer`.

## Runnable config

`doctor` needs no config of its own. It reads the `schema` path out of the one you already have:

```ts
// drzl.config.ts
export default {
  schema: 'src/db/schema.ts',
  outDir: 'src/api',
  analyzer: { includeRelations: true, validateConstraints: true },
  generators: [{ kind: 'zod', path: 'src/validators/zod', typedColumns: true }],
} as const;
```

```bash
npx @drzl/cli doctor
```

`typedColumns` above is the fix `doctor` names for an untypeable column: it does not make the
validator check the value, which nothing can do for a `customType`, but it recovers the declared
TypeScript type so the call site is still narrowed. See
[Generators → Zod](/generators/zod#typedjson).

See also: [Analyze](/cli/analyze) · [Generate](/cli/generate)
