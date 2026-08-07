---
'@drzl/analyzer': minor
'@drzl/cli': minor
---

`drzl doctor`: a human-readable report of what DRZL **cannot** type or enforce in your schema, and
what to do about each one.

Not `drzl analyze`. That prints the whole `Analysis` as JSON and leaves the reader to know which
fields mean trouble. `doctor` prints only what will silently not work, and both of its headline
failure modes produce a generated file that exists, compiles and validates nothing: an untypeable
column gets a validator accepting **any** value, and a CHECK constraint DRZL will not translate is
simply absent from the output.

```
DRZL doctor  src/db/schema.ts
postgres, 1 table, 11 columns, 12 CHECK constraints

Columns DRZL cannot type  (2)
  These get a validator that accepts any value.

  - Column "credit" on table "accounts" has no known type (SQL type numeric(12,2)), so its
    validator will accept any value.
    A customType has no runtime shape to read. Declare it with .$type<T>() and turn on
    typedColumns to give the validator the type.

CHECK constraints DRZL does not enforce  (9)
  Your database still enforces these. Nothing DRZL generates does.

  - CHECK "age_or" on "accounts" is not translated: contains OR. Expression: age >= 18 OR age <= 65
```

**The CHECK section reads something the analyzer does not know.** `parseCheck` lives in
`@drzl/validation-core` and every validation generator calls it; the analyzer carries the raw
expression through and has no opinion on it. So `Analysis.issues` cannot say "this constraint is in
your schema and nothing DRZL emits enforces it", and until now nothing said it at all: `drzl
generate` prints a count of untypeable columns and is silent about constraints. Measured on a
Postgres table carrying twelve CHECKs through all five generators, nine produced no enforcement in
any of them and DRZL reported none of the nine.

Three CHECK cases are distinguished, because their fixes differ: the parser declined the expression
(with its own reason, `contains OR`, `right side is not a literal`); the expression names a column
the table does not have; the expression compares an array or structured column against a scalar
literal. A constraint DRZL **does** translate is not listed, so the ones that matter are not buried.

Also reported: a table with no primary key, and a composite primary key. The service generator keys
`getById`, `update` and `delete` on `primaryKey.columns[0] ?? 'id'`, so a table with neither a key
nor an `id` column emits a service that does not compile (measured: three `TS2339` errors under
`tsc --strict`), and a composite key emits one matching on part of the key.

**Exit `0` by default, even with findings.** A schema carrying a `customType`, or a CHECK this
parser will not guess at, is normal and usable, and a doctor that failed every pipeline reading one
would be switched off within a week. `--strict` exits `2` when anything is reported, and `1` is
reserved for the case where the schema could not be read at all. `--json` emits the report with a
stable `kind` per finding, so CI can count one category without matching on prose.

Analyzer changes that go with it:

- **`Issue.path` is now set.** It has been declared since the interface existed and set by nothing,
  so a consumer wanting to group warnings by table had to read the names back out of the English in
  `message`. `DRZL_ANL_UNKNOWN_COLUMN` carries `table.column`; `DRZL_ANL_EXTRACONFIG`,
  `DRZL_ANL_RELATIONS`, `DRZL_ANL_REL_V2` and `DRZL_ANL_TABLE` carry the table.
- **A Gel temporal column gets its own hint.** The six `cal::`/duration columns are left `unknown`
  on purpose: the value is an instance of a class from the `gel` package, which DRZL cannot import,
  so no generator could emit a check for it even knowing the name. They used to carry the generic
  "open an issue naming the column type so it can be modelled", which sends their author to file an
  issue the arm already answers. `customType` and genuinely unmodelled columns keep their own
  wording.
