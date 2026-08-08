---
'@drzl/validation-core': minor
'@drzl/generator-valibot': minor
'@drzl/generator-zod': minor
'@drzl/cli': minor
---

Emit the table's constraints as data, and map a validation issue back to the constraint that caused
it

`constraints: true` on the zod or valibot generator writes one more file, `constraints.ts`: every
CHECK, unique constraint, primary key and foreign key on each table as plain objects, plus
`constraintForIssue`, which turns a failed parse back into the constraint that produced it.

```ts
{ kind: 'zod', path: 'src/validators/zod', constraints: true }
```

Off by default. With it off the emitted schemas are byte-for-byte what they were: this adds a file
and changes nothing in the existing ones.

**Why a schema is not enough.** A validator states what a value must look like and never says which
constraint said so, so `Too small: expected number to be >=18` gives a form a message and no way to
attribute it, no way to substitute its own wording for that rule, and no way to tell that failure
apart from the column's own type bound. And two of a table's constraints are absent from a
generated schema in every form: whether a value is already taken and whether the row it points at
exists are facts about the table, not about the row.

**What it maps, measured.** The same table and the same failing rows, on zod 4.4.3 and valibot
1.4.2, both answering with the same constraint:

| the row breaks          | zod reports                               | valibot reports                          |
| ----------------------- | ----------------------------------------- | ---------------------------------------- |
| `CHECK (age >= 18)`     | `too_small`, `minimum: 18`                | `min_value`, `requirement: 18`           |
| `varchar(10)`           | `custom`, `at most 10 characters`         | `check`, `at most 10 characters`         |
| `CHECK (length(...))`   | `custom`, `email_len: length(email) >= 3` | `check`, `email_len: length(email) >= 3` |
| `CHECK (status IN ...)` | `invalid_value`                           | `picklist`                               |
| `CHECK (starts < ends)` | `path: ['starts']`                        | `path: []`, naming no column             |

The last row is why the map exists rather than being a one-line path lookup: valibot names no
column for a row-level check, so the column comes out of the constraint data instead, and it is the
same column zod chose.

`CHECK (age >= 18)` is the other one. DRZL deliberately folds a numeric CHECK into the column's own
range, which is worth keeping because it yields the library's machine-readable bound instead of a
sentence DRZL wrote, and it costs the constraint name: the failure is worded entirely by the
library. The map answers that by matching the bound, and answers a failure against the column's own
`int4` ceiling with nothing rather than blaming the nearest CHECK.

**Constraints nothing enforces are present and marked.** A CHECK the parser declines appears with
`enforced: false` and the parser's own reason, because a form still wants to know the rule exists.
It can never produce a validation issue, so it never comes back from `constraintForIssue`.

**Not `meta` written to a second file.** `meta` describes a _field_, renders a CHECK as prose, has
no foreign keys, drops the names of the unique constraints, and is reachable only by holding the
schema object. This describes the table's _constraints_, carries their names, states each operand
as data, and is a record keyed by table with no validator import. Both are built from one
classification internally, so they cannot disagree about which CHECKs are enforced.

**zod and valibot only, and the boundary is measured.** The data claims the schemas enforce each
constraint and states the exact message they use. Measured on ArkType 2.2.3 against the same table,
neither claim would hold: it folds `cardinality(tags) > 0` into its own DSL, moves a `length()`
check onto the object, puts DRZL's wording in `expected` rather than `message`, and emits nothing
at all for `name <> 'x'`.

`{ errorMap: false }` emits the data without the matcher: for a table with twelve constraints, 1,855
bytes minified against 2,831 with it, and 708 against 1,117 gzipped.
