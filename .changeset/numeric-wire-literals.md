---
'@drzl/validation-core': patch
'@drzl/generator-zod': patch
'@drzl/generator-valibot': patch
'@drzl/generator-arktype': patch
'@drzl/generator-typebox': patch
'@drzl/generator-effect': patch
'@drzl/generator-json-schema': patch
---

Reconcile a CHECK's literal kind with the column's wire by the database's comparison semantics,
so a set on a `numeric()` column stops rejecting every row the driver returns

`CHECK (n IN (1, 2))` on a `numeric()` column (string mode, the default) emitted
`z.union([z.literal(1), z.literal(2)])`, and the driver returns *decimal text* there, spelled by
the declared scale: measured through PGlite on both drizzle majors, a stored 1 comes back `'1'`
from a bare `numeric`, `'1.00'` from a `numeric(10,2)` and `'1.0000000000'` from a
`numeric(20,10)`, and mysql2 returns the same shapes for `decimal`. So the select schema refused
every row the database handed back. Exact string literals are no repair: `'1'` fails against the
`'1.00'` the scaled column returns, and a bare `numeric` even preserves the insert's own zeros
(`1.000000` came back `'1.000000'` and `CHECK (n IN (1, 2))` admitted it, because SQL numeric
equality is scale insensitive: `1 = 1.00` is true, measured on PostgreSQL 17.5 and MySQL 8.4.11).

The same rule gap ran the other way. The database coerces a quoted literal to the column's type
before comparing (`bigint CHECK (big IN ('1','2'))` admitted 1 and refused 3;
`integer CHECK (age IN ('18'))` admitted 18), while the emitted schemas compared the raw text:
`z.enum(["1","2"])` refused every `1n` a bigint-mode column returns, `big = '1'` compared
`v === "1"` which no bigint ever satisfies, and `age IN ('18')` refused the number 18.

The repair is one shared policy in `@drzl/validation-core`, extending `wireNumberLiteral`'s rule
to the whole comparison: the literal's kind and the column's wire are reconciled by what the
database does, never by the source spelling.

- **Numeric string wires** (`numeric`/`decimal` string modes, v1 `bigint({ mode: 'string' })`):
  equality, inequality and sets compare *canonical decimal spellings* through a `DrzlNumericCanon`
  helper emitted once per file, dependency free: sign normalised, leading integer zeros and
  trailing fraction zeros stripped, a bare trailing dot dropped, then compared as strings. Exact
  at any precision on purpose: `Number()` is not usable here, because a numeric column carries
  more digits than a double holds and `Number('99999999999999999999')` equals
  `Number('99999999999999999998')`. zod and valibot refine, ArkType narrows, TypeBox rides the
  registered `DrzlRowCheck` kind under both checkers, effect filters. JSON Schema cannot run a
  function, so the set becomes a `pattern`: one alternation branch per member, accepting exactly
  the spellings that canonicalise to it, ajv strict valid on every target; the cost is the
  regex's readability, not admitted rows. Ranges there keep their coerced numeric compare,
  now spelled `Number(v) >= 1` so the comparison is visible and the module typechecks.
- **Number and bigint wires**: quoted plain-decimal literals are respelled to their number-kind
  selves (canonicalised first: `018` and `018n` are syntax errors in an emitted module) and every
  existing arm applies, `wireNumberLiteral`'s bigint suffix included. `big IN ('1','2')` now
  emits byte for byte what `big IN (1, 2)` emits.
- **What no exact compare can state is left unenforced and reported, never guessed.** Three
  measured shapes: a number literal against a text column (Postgres refuses the DDL outright;
  MySQL creates it and admits `'1.00'`, `'1'` and `'2.0'` through double coercion), quoted text
  that is not plain decimal on a number or bigint wire, and a member outside the canonical domain
  on a numeric wire (`CHECK (n IN ('1e3', '2'))` is valid DDL whose rows come back `'1000'`).
  Each falls back to the base schema, which accepts every value the driver returns for admitted
  rows, and the constraint ledger carries the reason: enforcing a guess would reject rows the
  database admits, which is the defect class this fixes.

The ledger and `meta` apply the same policy through `classifyTableChecks`, so a respelled
constraint renders the message the emitted module writes and an unenforced clause says why
instead of being claimed. TypeBox also stops planting a dead `minimum` keyword on
`Type.String()`, which validated nothing and serialised as if enforced.
