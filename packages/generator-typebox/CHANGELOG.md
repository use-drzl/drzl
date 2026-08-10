# @drzl/generator-typebox

## 0.14.3

### Patch Changes

- 08c2189: Character caps stop spreading the string when it cannot matter

  Every emitted character cap counted code points as `[...v].length`, which allocates an array of
  code points on the path every ordinary row takes. A UTF-16 unit count is free and is never smaller
  than a code-point count, since only a surrogate pair spends two units on one code point, so a
  string already short enough in units cannot be too long in characters:

  ```ts
  // before
  .refine((v) => [...v].length <= 64, { message: 'at most 64 characters' })
  // after
  .refine((v) => v.length <= 64 || [...v].length <= 64, { message: 'at most 64 characters' })
  ```

  Measured on real emitted output, validating a whole five-column row rather than a lone field, with
  the two modules differing in exactly that one expression: zod `1646k/s` to `6925k/s`, 4.2x; TypeBox
  on the compiled path `2098k/s` to `31856k/s`, 15.2x. Both accepted exactly the same rows. On the
  check alone at a cap of 64, ordinary ASCII rows go `23171k/s` to `215029k/s`, and rows sitting at
  the cap `4250k/s` to `235657k/s`.

  The same rewrite applies to every length `CHECK` the parser reads, in the direction each operator
  allows: a cap short-circuits on the accept side, a minimum on the reject side, `=` on the reject
  side and `<>` on the accept side. Which rewrite is sound for which operator is now decided once, in
  `codePointCompare`, rather than in the five generators that each had their own operator table.

  Nothing changes about what is accepted. The equivalence is asserted rather than argued: every
  operator is evaluated against the bare spread over astral pairs, combining marks, a lone surrogate,
  the empty string and CJK at the bound, and then over a 4000-string pseudo-random pool, 24000
  comparisons in all.

- Updated dependencies [08c2189]
- Updated dependencies [866dbaa]
  - @drzl/validation-core@3.22.3
  - @drzl/analyzer@1.21.3

## 0.14.2

### Patch Changes

- 14ab9f7: `CHECK (col <> 'banned')` is now enforced by every generator that reads it

  One parsed CHECK, six emitters, three of which silently enforced nothing. The shared parser has
  always read `<>`, and zod, valibot and effect have always emitted a predicate for it, while ArkType
  and TypeBox emitted a bare `string` and the JSON Schema generator emitted no keyword at all. A
  column carrying `CHECK (tier <> 'banned')` therefore had a schema that accepted the single value
  the database refuses, on three of the six.

  The form each library can actually state, measured rather than assumed:

  - **ArkType** takes a narrow on the field. Its DSL has no negation, and the two spellings that look
    like they would work do not: on 2.2.3, `string & !'banned'` is a parse error and
    `Exclude<string, 'banned'>` parses and then accepts `'banned'`.
  - **TypeBox** states it declaratively, as `Type.Intersect([base, Type.Not(Type.Literal("banned"))])`.
    The intersect is load bearing rather than decorative: on 0.34.52 `Type.Not` alone accepts a value
    of any other type, so without the base the column would stop being a string. Both the interpreted
    and the compiled path enforce the pair.
  - **JSON Schema** emits `not` beside the type: `{ "type": "string", "not": { "const": "banned" } }`,
    spelled `"not": { "enum": [...] }` on the OpenAPI 3.0 target, which has no `const`. On a numeric
    string wire it becomes `"not": { "type": "string", "pattern": ... }`, because the driver spells
    one stored value many ways and excluding a single spelling would enforce almost nothing.

  Null is unaffected everywhere, which is what SQL does: `NULL <> 'banned'` is NULL and a CHECK passes
  on NULL. That inner `"type": "string"` on the pattern form is what keeps it so. Without it the `not`
  is false for null, because `pattern` is vacuously true of a value that is not a string, and the
  exclusion would quietly have made a nullable column non-nullable.

  The gate could not have caught any of this, because its CHECK fixture had `=`, `IN`, ranges,
  `length`, `cardinality` and a row comparison, and no `<>`. It has one now, on a text and an integer
  column, so the five-generator agreement and the Postgres ground truth both cover the form: 59 probes
  across 15 constrained columns, up from 53 across 13. The third dropper was found by that fixture
  rather than by reading, within a minute of it existing.

  Not changed: the constraint ledger stays scoped to the zod and valibot spellings, since what it
  reports is where a constraint's message lands rather than whether a schema enforces it.

- Updated dependencies [b37c158]
  - @drzl/analyzer@1.21.2
  - @drzl/validation-core@3.22.2

## 0.14.1

### Patch Changes

- acef357: Fix a dead link that shipped in every one of these READMEs. They pointed at
  `docs/sponsor.md`, and only `dist` is listed in `files`, so on npm that path resolves to nothing.
  They now point at https://use-drzl.github.io/drzl/sponsor, which answers 200. npm publishes README
  regardless of `files`, which is what makes this a change to the published artifact rather than a
  repository-only edit.

  The CLI README additionally listed four of its eight commands, omitting `doctor` and `explain`
  despite both having their own documentation pages, and did not say that all fourteen generators
  arrive with the CLI so no separate install is needed.

- Updated dependencies [acef357]
  - @drzl/analyzer@1.21.1
  - @drzl/validation-core@3.22.1

## 0.14.0

### Minor Changes

- 4801464: `generate` knows what it is about to write before it writes it (plan items 68, 80, 81, 75, 82)

  **One mechanism, three features.** `--dry-run`, "say what changed rather than how many files", and
  "a `--check` failure should show a diff" are the same question asked once per file: what content is
  about to land here, and what is here now. So generators now hand their writes to a `fileSink`
  instead of calling `node:fs/promises` themselves, and `generate` decides whether that sink writes.
  Fourteen generator packages changed by exactly one line each, because the sink is shaped like the
  `fs` namespace they already used, plus one option on their public type.

  The tempting alternative was to leave the generators alone and patch `node:fs/promises` for the
  duration of a run, and it was measured and rejected. Patching the CommonJS exports object is
  visible through a later dynamic import, but a module namespace that already exists is a snapshot
  and never changes: with `const ns = await import('node:fs/promises')` evaluated first,
  `require('node:fs/promises').writeFile = spy` leaves `ns.writeFile` untouched, on Node 22.22. The
  CLI links `chokidar`, which imports `node:fs/promises` at module scope, so a dry run built on that
  would write real files whenever an unrelated dependency happened to import first.

  **`drzl generate --dry-run` writes nothing at all** (item 68). Not "writes and puts it back":
  no file, no directory, no formatter output. A dry run in a project that has never been generated
  into leaves the directory byte-for-byte as it found it, asserted per entry and per byte rather than
  by looking for generated files. It exits `0` whether or not anything would change, because a dry
  run that computed its answer did what it was asked, and `2` is for a run that found what it was told
  to look for; `--check` is the flag whose question is "is anything stale". stdout still carries one
  absolute path per line, so `drzl generate --dry-run > files.txt` gives the list that _would_ be
  written in the same shape as the list that was.

  Because generators are separate packages that a user can install at a different version from the
  CLI, the claim is also checked at runtime rather than only in a test. A run that promised to write
  nothing and wrote something restores the tree, exits `1` with the new `DRZL_GEN_003`, and names the
  generator to update.

  **Every run says what it did to each file** (item 80): created, changed or unchanged, with the
  counts and the names of the ones that are not the same as before.

  ```
  ✔ Generated (zod): 3 files (1 created, 1 changed, 1 unchanged)
    + zod/posts.zod.ts
    ~ zod/index.ts
  ```

  A run that rewrote twelve identical files and one real change used to say `13 files`. Unchanged
  files are counted rather than listed: the list is what changed. That report is narration, so it is
  on stderr, `--quiet` drops it, and **stdout is unchanged**, still one absolute path per line.
  `--json` gains a `changes` array per generator beside the existing `files`, and a `dryRun` flag.

  **`--check` prints a unified diff under each drifted file** (item 81), `a/` being what is on disk
  and `b/` what the schema produces, so it reads like `git diff` and applies like a patch. "Changed"
  alone cannot tell a regenerated header from somebody's hand-edit to a generated file, and those two
  want opposite responses. Diffs are capped at the first 20 files, at 4000 lines and at 1500 line
  edits, and every cap states itself in the output; every drifted file is still named in the list
  above the diffs, so what is capped is the explanation and never the finding. `--quiet` keeps the
  list and drops the diffs. The diff is written here rather than installed: `diff` (jsdiff) is only
  resolvable in this workspace as a transitive dependency of a devDependency, and adding it as a real
  one costs a package on every install of the CLI in exchange for about a hundred lines of a
  published algorithm. It is checked by applying its own output: every case in its suite requires the
  emitted patch, replayed against the "before" text, to reproduce the "after" text exactly.

  **`--check` also stopped writing.** It used to snapshot the output directories, let the generators
  overwrite them for real, compare, and restore the snapshot, so the one command documented as never
  touching your tree was the command that rewrote every generated file on every CI run, with a window
  in which a killed process left the tree modified. It now compares in memory. One consequence: a file
  in an output directory that the run no longer produces is not reported, and the `removed` drift
  status is no longer produced. Reporting every unrecognised file in an output directory would mean a
  config whose `outDir` is `src` failed CI over every hand-written module in the project.

  **`drzl watch` runs one rebuild at a time** (item 75). The debounce that was there covered the wait
  and not the work: it collapsed changes arriving close together and then started a rebuild that took
  as long as it took, and every change arriving during _that_ started another one on top of it,
  writing the same output directory. Measured on a 600-table schema where one rebuild takes about
  1.4s, six saves 700ms apart produced six rebuilds with four running at once. A save that arrives
  during a rebuild is now remembered rather than started, and produces exactly one more rebuild when
  the current one finishes, however many arrive; the same measurement now shows at most one in
  flight. No save is dropped, because refusing one loses an edit, which is worse than the overlap.

  `--debounce` keeps its 200ms default, now measured rather than inherited: with the write-settling
  this watcher asks chokidar for, one editor save arrives as a single event and the widest gap inside
  one burst was 9ms; without it, a chunked write spread to 62ms, an atomic save to 101ms and
  format-on-save to 121ms. `--debounce 0` now works, having previously been read as absent by
  `Number(x) || 200` and silently replaced, and a value that is not a number is refused with a warning
  instead of quietly becoming 200.

  **Clearing the screen is opt-in** (item 75). `drzl watch` cleared the terminal on every rebuild with
  no way to stop it, throwing away the previous rebuild's errors and the banner naming the watched
  directories. It is now `--clear`, off by default, and it writes to the stream the output is actually
  on: the old `console.clear()` decided from stdout while every human-readable line goes to stderr, so
  `drzl watch > events.json` at a terminal cleared nothing and aimed the escape at the stream carrying
  the JSON.

  **The analysis was already shared between generators** (item 82), and there is now a test that says
  so. Measured on a 200-table schema: one, two, three and five generators each report exactly one
  analysis step, at a constant 37ms, and the four extra generators cost 2468ms of generator work
  where four extra analyses would have added about 148ms. `watch` re-analyses per rebuild, which is
  what keeps a cached analysis from going stale when the schema changes.

### Patch Changes

- cf19c30: Unsigned integer columns get the range they actually hold

  `int('x', { unsigned: true })` emitted the signed range, `gte(-2147483648).lte(2147483647)`,
  so the select schema refused every stored value in [2^31, 2^32-1] on a column shape MySQL
  users reach for constantly. The whole family had the same defect, differently per major. On
  drizzle-orm 0.4x the flag lives only in `config.unsigned` and no range table read it, so every
  width kept its signed bounds and `serial`, unsigned by its own definition, had no bounds at
  all: an auto-increment column accepted -1. On drizzle v1 the `uint16`/`uint24`/`uint32`
  semantics had no arm and fell to the implicit-decimal path, `integer: false` with
  +/-9999999999, and `uint64` fell back to the class table's signed int64 range, so
  `bigint({ mode: 'bigint', unsigned: true })` refused 18446744073709551615n, a value the driver
  really returns.

  The analyzer now answers every unsigned width on both majors with the type's own range:
  tinyint [0, 255], smallint [0, 65535], mediumint [0, 16777215], int [0, 4294967295], bigint in
  number mode [0, 9007199254740991], the safe-integer ceiling the number wire imposes, and
  bigint in bigint mode [0, 18446744073709551615], representable because the value is a bigint,
  which is how 18446744073709551615n lands in emitted literals. `serial` takes the number-mode
  answer with a BIGINT label on both majors. `bigint({ mode: 'string', unsigned: true })` stays
  the string the driver returns: v1 spells it `string uint64` and the string-mode arm keyed on
  `int64` alone. SingleStore ships the same builders and takes the same table, which also closes
  a signed gap: its tinyint and mediumint carried no range on 0.4x while v1 stated `int8` and
  `int24` for the same columns. Postgres and SQLite have no unsigned spelling and are untouched,
  asserted by test.

  Measured against a live MySQL 8.4.11 in STRICT_TRANS_TABLES: every ceiling stores and comes
  back, value for value, through mysql2 under both majors, and -1 and each ceiling plus one are
  refused with ER_WARN_DATA_OUT_OF_RANGE. A CHECK on an unsigned column still folds into the
  bound in its wire's spelling: `.gte(10).lte(4294967295)` on the number wire, `.gte(10n)` on
  the bigint wire. Official drizzle-zod, drizzle-valibot, drizzle-arktype and drizzle-typebox
  answer the same probes identically on both majors, so the fixed schemas agree with first-party
  behavior on every unsigned width, including the safe-integer ceiling for number mode and for
  serial. The JSON Schema generator also narrows its bigint pattern on unsigned columns, from
  `^-?\d+$` to `^\d+$`: the sign is the one half of the range a pattern can state exactly.

- Updated dependencies [cf19c30]
- Updated dependencies [c56125f]
- Updated dependencies [28787ff]
- Updated dependencies [062f305]
- Updated dependencies [2c8b20b]
- Updated dependencies [4801464]
- Updated dependencies [02fc84a]
  - @drzl/analyzer@1.21.0
  - @drzl/validation-core@3.22.0

## 0.13.1

### Patch Changes

- 10af5d7: The duplicate finder now covers the primary key, which is the collision seed data actually has

  `findDuplicate<table>` scanned only the declared unique constraints, so two rows carrying the
  same explicit primary key sailed through and failed at the database with
  `duplicate key value violates unique constraint "users_pkey"` (23505, measured on Postgres 17),
  and a table whose only key is its primary key, a natural key like `skus.code`, got no finder at
  all. The database enforces a primary key with a unique index and its own error calls it a unique
  constraint, so the finder treats it as one: the key is checked first, named `<table>_pkey` the
  way Postgres names it, and reported like any other collision. Rows that leave a generated key to
  the database are untouched, because an absent or null column already skips a constraint, exactly
  as a unique index skips NULLs. Emitted output changes only where `duplicateFinder: true` is set.

- Updated dependencies [10af5d7]
  - @drzl/validation-core@3.21.1

## 0.13.0

### Minor Changes

- 1218361: Read three more CHECK shapes: a disjunction that pins one column, `IS NOT NULL`, and the null
  guard in front of a predicate

  `parseCheck` refused every expression holding `OR` and every expression holding `NOT`, which took
  `col IS NOT NULL` with it. Three of those refusals are now readings, one is unchanged, and one that
  used to be a generic "not a comparison" now says what it found.

  ```ts
  // check('status_valid', sql`${t.status} = 'draft' OR ${t.status} = 'live'`)
  status: z.enum(['draft', 'live'] as const).nullable(),

  // check('email_set', sql`${t.email} IS NOT NULL`)   // on a nullable column
  email: z.string(),

  // check('age_adult', sql`${t.age} IS NULL OR ${t.age} >= 18`)
  age: z.number().int().gte(18).lte(2147483647).nullable(),

  // check('tier_ok', sql`${t.tier} IS DISTINCT FROM 'banned'`)
  tier: z.string().refine((v) => v !== 'banned', { message: "tier_ok: tier <> 'banned'" }).nullable(),
  ```

  All five validator generators and the JSON Schema generator, plus `drzl doctor` and the constraint
  ledger.

  **Why a disjunction was refused, and what changed.** A conjunction splits because every part is
  independently _necessary_. A disjunction is the opposite: `CHECK (a OR b)` is satisfied by a row
  that breaks `a`, so a schema enforcing `a` refuses rows the database takes. Nothing about that
  argument has weakened. What is read is the one shape where the _whole_ disjunction is a single
  statement: every branch pinning the same column to a literal, by `=` or by `IN`. `s = 'a' OR
s = 'b'` and `s IN ('a','b')` are the same statement in SQL, NULL included, so they emit the same
  schema. Everything else is refused **whole**, never in part, and named:

  | Refused                     | Reason reported                                 |
  | --------------------------- | ----------------------------------------------- |
  | `n < 0 OR n > 100`          | a branch is a range rather than a set of values |
  | `a = 'x' OR b = 'y'`        | the branches constrain different columns (a, b) |
  | `s = 'a' OR s = 1`          | the branches mix a string and a number          |
  | `s = 'a' OR lower(s) = 'b'` | part of an OR was not understood                |

  **`IS NOT NULL` narrows the field rather than adding a predicate.** Every other CHECK is emitted
  _inside_ the nullable wrapper, precisely so `null` skips it, which is what makes them match SQL.
  This one is the statement that `null` is not allowed, so it is said by the field not being
  nullable. Applied once, in the three column selectors every generator already calls, so no
  generator learns a new kind of check and none of the six can disagree with the others. On insert
  the field becomes required, because a row omitting a nullable column with no default writes NULL;
  a column that defaults to a value stays optional. On a column already `.notNull()` it changes
  nothing and stops being reported as declined.

  **A null guard reduces away.** `col IS NULL OR P` states nothing beyond `P`, because a CHECK
  already passes on NULL and every operator here yields NULL when its column is NULL. Sound only when
  `P` names the guarded column and holds no null test of its own, so `a IS NULL OR b > 0` is still
  refused: with `a` null it accepts every `b`. `IS DISTINCT FROM <literal>` reduces the same way and
  emits byte for byte what the `<>` it means emits.

  **Arithmetic over two columns stays refused, and now says so.** `x + y < 100` used to report "not a
  single comparison this version understands". It now names the operator, and `drzl doctor` says what
  to do instead. The reason is measured rather than argued: Postgres computes `numeric` exactly and
  JavaScript computes in binary floating point.

  | Column type        | `CHECK (x + y <= 0.3)` with `(0.1, 0.2)` | JavaScript `0.1 + 0.2 <= 0.3` |
  | ------------------ | ---------------------------------------- | ----------------------------- |
  | `numeric(10,2)`    | accept                                   | false, so it would reject     |
  | `double precision` | reject                                   | false, so it would agree      |

  One expression, two column types, two different correct answers, and the expression does not carry
  the type. A `bigint` pair adds a third, since Postgres raises on overflow where `BigInt` does not.
  Any single reading is wrong for two of the three in the direction that refuses rows the database
  accepts, which is the failure this parser exists to avoid.

  **Ground truth.** 64 probes through a real Postgres (PGlite), one table per constraint so a sibling
  CHECK cannot fail the statement before the value under test is reached, each value put to both the
  database and the emitted insert schema: **0 rows the schema refuses and Postgres accepts**, 58
  agree, 6 wide. Every wide row is a constraint DRZL deliberately enforces nothing for, which is the
  safe direction.

  `IS NULL` on its own is read but enforced nowhere, since narrowing a field to only null would mean
  replacing the column's type rather than wrapping it; `drzl doctor` lists it with that reason.
  `NOT`, `NOT IN` and the boolean `IS TRUE` family remain refused.

- f29bff7: Enforce `CHECK (octet_length(col) <= n)`, which is a byte budget rather than a character count

  `parseCheck` refused `octet_length` outright, on the recorded grounds that a byte count "depends on
  the encoding and cannot be derived from a JavaScript string without choosing one". Both halves of
  that are answerable: the encoding is UTF-8, and a `bytea` column does not arrive as a string at all.
  The constraint is now read and routed into the byte-cap machinery MySQL's TEXT family already used.

  ```ts
  // check('body_bytes', sql`octet_length(${t.body}) <= 5`)      // on a text column
  body: z.string().refine((v) => new TextEncoder().encode(v).length <= 5, {
    message: 'body_bytes: octet_length(body) <= 5',
  }),

  // check('blob_bytes', sql`octet_length(${t.blob}) <= 5`)      // on a bytea column
  blob: z.instanceof(Uint8Array).refine((v) => v.length <= 5, {
    message: 'blob_bytes: octet_length(blob) <= 5',
  }),
  ```

  **Three counts, and no two of them agree.** Measured on PostgreSQL 17.5 through PGlite, on a `text`
  holding three emoji and a `bytea` holding six bytes:

  | expression        | `text` | `bytea`        | JavaScript                                  |
  | ----------------- | ------ | -------------- | ------------------------------------------- |
  | `octet_length(x)` | 12     | 6              | `new TextEncoder().encode(v).length`        |
  | `length(x)`       | 3      | 6              | `[...v].length`, or `v.length` on the array |
  | `char_length(x)`  | 3      | does not exist | `[...v].length`                             |

  `v.length` on a string is none of them: it counts UTF-16 units, which is 6 for those same three
  emoji. So `length` is a character count on a text column and a byte count on a bytea one, and a
  parser that read `octet_length` as one more spelling of `length` would put a character cap on a byte
  budget. Measured on the real constraint: `CHECK (octet_length(t) <= 5)` accepts `'hello'` and one
  emoji and refuses `'hellos'` and two emoji, and it is the last of those, two characters and eight
  bytes, that a character cap takes and the column does not.

  The parser now carries a `unit` on `LengthCheck`, and `lengthMeasure(column, check)` turns that plus
  the column into one of three JavaScript expressions. It lives in `@drzl/validation-core` so the five
  validation generators, the constraint ledger, `meta` and `drzl doctor` cannot disagree about what is
  enforced.

  **JSON Schema.** No draft has a byte-length keyword, so the same trade the MySQL byte budget already
  made applies: the ceiling becomes `maxLength`, which counts characters and therefore refuses nothing
  the column accepts, and the part it cannot catch is stated in `description`. A `bytea` travels as
  base64, so its cap is the encoded length, `4 * ceil(n / 3)`, which is the padded length of a full
  value and an upper bound on the unpadded one, measured over n = 0 to 20. That also gives a MySQL
  `tinyblob` a bound it never had: 255 bytes is `maxLength: 340`, where the document previously said
  nothing. A byte _floor_ reaches no keyword in either case.

  **What is still refused, and now says so.** A count on a MySQL `binary(n)`/`varbinary(n)` cannot be
  answered: the value arrives as a string from a lossy decode, so neither its characters nor their
  re-encoding is the server's byte count. `drzl doctor` reports that as a new finding kind,
  `check-uncountable`, rather than dropping it silently, and the ledger marks it unenforced with the
  reason. The doctor's note that count clauses were "unreachable from a working schema" was true of
  Postgres and is not true of MySQL, which has `OCTET_LENGTH` and a column whose bytes JavaScript
  cannot see.

### Patch Changes

- 9939e4c: Spell a CHECK's number literals in the column's wire type, so a set on a `bigint({ mode:
'bigint' })` column stops rejecting every row the driver returns

  `CHECK (big IN (1, 2))` on a bigint-mode column emitted `z.union([z.literal(1), z.literal(2)])`,
  and the driver returns `1n` there: strict equality between a bigint and a number is false in
  JavaScript, so the select schema refused every row the database handed back, and the insert schema
  refused every value the driver wants. The OR fold routes `big = 1 OR big = 2` into the same set,
  and the single `big = 1` and `big <> 1` predicates compared with `===`/`!==` had the same wire
  mismatch: the equality never held and the inequality always did, so one rejected everything and
  the other enforced nothing. `bigint({ mode: 'number' })` was always correct, because the driver
  really returns a number there; the fix keys on the analyzer's per-mode `tsType`, which is the
  value's measured wire type, rather than on the SQL type name.

  The spelling per library was measured against the installed versions rather than assumed:

  - **zod, valibot**: `z.literal(1n)` and `v.literal(1n)` accept `1n`, reject `3n` and reject the
    number `1`, so the set stays the same union with the members suffixed. The `=`/`<>` refinements
    compare against `1n`.
  - **ArkType**: the string DSL parses bigint literals. `type('1n | 2n')` enforces the set,
    `type('9223372036854775807n')` holds the 64 bit value exactly, and `type('(1n | 2n)[]')` keeps
    the array wrap. The single equality already went through `atBigintNarrow` and was correct.
  - **TypeBox**: `Type.Literal(1n)` constructs and passes `Value.Check`, and
    `TypeCompiler.Compile` then throws "Preflight validation check failed to guard for the given
    schema", so the literal form would take every compiler-path consumer down. The set and the
    pinned equality go to the registered `DrzlRowCheck` kind intersected with `Type.BigInt()`, the
    same escape hatch the character caps use, which both checkers honour; the static type still
    narrows through `Type.Unsafe<1n | 2n>`, and the document still serialises.
  - **effect**: `Schema.Literal(1n, 2n)` enforces the set; the `<>` filter compares against `1n`.
  - **JSON Schema**: a bigint column is already a digits string in a JSON document, because
    `JSON.stringify` throws on a bigint, so the set becomes `{ enum: ['1', '2'] }` and a pinned
    equality `{ const: '1' }`, in the wire the serialised row can actually hold. This also unrounds
    the 64 bit case: `Number('9223372036854775807')` becomes 9223372036854775808 the moment it is a
    number, and the digit string stays exact.

  A non-integer member has no bigint spelling at all: `1.5n` is a syntax error, and an emitted
  module carrying it would throw at import. Such a member keeps its number spelling, which no stored
  bigint ever equals, exactly as the database says: no bigint column value is 1.5, so `big IN (1.5,
2)` narrows to the 2. The shared decision lives in `wireNumberLiteral` in
  `@drzl/validation-core`, so the six emitters cannot answer it differently.

  The driver-side ground truth is the analyzer's own: `decimal-modes.spec.ts` pins `db.select()`
  returning a real bigint in bigint mode on all three engines, and the `PgBigInt53`/`PgBigInt64`
  arms pin the number mode returning a number, which is why those literals do not change.

- cc26f38: Reconcile a CHECK's literal kind with the column's wire by the database's comparison semantics,
  so a set on a `numeric()` column stops rejecting every row the driver returns

  `CHECK (n IN (1, 2))` on a `numeric()` column (string mode, the default) emitted
  `z.union([z.literal(1), z.literal(2)])`, and the driver returns _decimal text_ there, spelled by
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
    equality, inequality and sets compare _canonical decimal spellings_ through a `DrzlNumericCanon`
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

- Updated dependencies [9939e4c]
- Updated dependencies [0e295da]
- Updated dependencies [1218361]
- Updated dependencies [45bb6f5]
- Updated dependencies [cc26f38]
- Updated dependencies [f29bff7]
  - @drzl/validation-core@3.21.0
  - @drzl/analyzer@1.20.1

## 0.12.0

### Minor Changes

- 4efd19b: Emitted validators can now give every key a nominal type, so a `users.id` cannot be passed where a
  `posts.id` is wanted.

  `{ kind: 'zod', path: 'src/validators/zod', branded: true }`, on all five validation generators.

  ```ts
  export const SelectpostsSchema = z.object({
    id: z.number().int().brand<'posts.id'>(),
    authorId: z.number().int().brand<'users.id'>(),
  });

  export type PostsId = z.output<typeof SelectpostsSchema>['id'];
  ```

  ```ts
  loadUser(post.authorId); // fine
  loadUser(post.id); // Type 'number & $brand<"posts.id">' is not assignable to
  //                    parameter of type 'number & $brand<"users.id">'
  ```

  **Nothing happens at runtime.** Measured on zod 4.4.3, `.brand()` returns the same schema object it
  was called on, by identity, and `parse(1)` is `1`; valibot 1.4.2, arktype 2.2.3 and effect 3.x all
  hand the value back unchanged, and TypeBox's marker is a cast that leaves the schema object
  byte-identical. So this cannot change what a schema accepts, and the whole feature is what `tsc`
  prints. It is proved that way: the test suite compiles generated modules and asserts that
  `@ts-expect-error` on each rejection is used, that the same file without the directives produces
  exactly those errors, and that the identical calls against unbranded output produce none.

  **Foreign keys carry the brand of the column they reference**, resolved transitively, and that beats
  the column being part of its own table's key. `posts.authorId` is a `users.id`; a join table keyed
  on `(orgId, userId)` is `orgs.id` and `users.id`, not two brands nothing else produces. Without this
  the feature would only stop you swapping two tables' own ids, while every id actually flowing
  between your tables stayed a plain number.

  **The brand token is `<export name>.<column>`, verbatim.** Nothing is transformed, so the token is
  unique by construction and two tables cannot collide after a transformation. The exported alias has
  to be an identifier and is `PascalCase(table) + PascalCase(column)`; `user_accounts` and
  `userAccounts` do collide there, and when they do neither alias is emitted and the run says so. The
  schemas are unaffected, because they carry the token and never the alias.

  **The brand goes inside the `nullable` and `optional` wrappers**, and that is the one decision that
  could be wrong while still compiling. A brand is an intersection and `null & { ... }` is `never`, so
  `z.number().nullable().brand<'users.id'>()` infers `number & $brand<"users.id">` with the null arm
  silently gone while `.parse(null)` still returns null. The same trap is in valibot, effect and
  TypeBox. All five emit `(number & brand) | null`.

  **`typedColumns` is not emitted for a branded column.** Both narrow the same column's static type and
  whichever runs second wins, and applying the brand to the reference hits the null problem above. The
  brand wins outright rather than the two being emitted to fight; nothing is lost for an ordinary key,
  whose branded type is Drizzle's inferred type plus a marker. A key declared with `.$type<T>()` is the
  one case that costs something, and it is documented.

  **TypeBox has no brand at all** and still expresses one. There is no `Type.Brand` and nothing
  brand-shaped on `Type`, measured on 0.34.52 by enumerating its keys. What it has is `TUnsafe<T>`, its
  own primitive for "this schema, that static type", which the generator already uses for
  `typedColumns`. A branded file declares one helper whose value is the schema itself, so `Value.Check`,
  `TypeCompiler` and the JSON Schema `JSON.stringify` produces are all unchanged. The marker is a
  string-keyed property rather than a `unique symbol` on purpose: a `unique symbol` is unique per
  declaration, so two generated files would produce two unrelated brands and a foreign key would not be
  assignable to the key it points at.

  **Which types change differs by library, and branding only makes it visible.** zod, valibot and effect
  name their insert type from the schema's _input_ type, which a brand does not touch, so writes stay
  plain and only rows read back carry brands. ArkType and TypeBox name theirs from the output type, so
  an insert payload there wants a branded id.

  Off by default: it changes the inferred type of every consumer of the select schemas, which is the
  point, but it is a change to existing call sites rather than an addition. A full generated project,
  validators for all five libraries plus a service and both routers, typechecks with it on under
  `nodenext` with `noUnusedLocals`: the generated service types its key as `id: number` from Drizzle,
  and a branded id is still a number, so every call into it still compiles. Emitted source grows about
  10%, all of it text, none of it reaching runtime.

- f110f7b: TypeBox schemas can now back a tRPC or oRPC router.

  `{ kind: 'typebox', path: 'src/validators/typebox', standardSchema: true }` gives every emitted
  schema a `~standard` key, so `t.procedure.input(InsertusersSchema)` and
  `os.input(InsertusersSchema)` both typecheck, validate, and infer the real shape on the client.

  TypeBox was the one validator DRZL emits with no route to Standard Schema, which is the stated
  reason both router generators exclude it. Measured on `@sinclair/typebox` 0.34.52: a bare
  `Type.Object()` has own keys `type,required,properties` and no `~standard`, and the package exports
  nothing matching `/standard/i` from its root or from `value`. zod 4.4.3, valibot 1.4.2 and arktype
  2.2.3 all carry one already, so the option exists on this generator alone and is not passed to the
  others.

  Implemented against `@standard-schema/spec` v1 as published in 1.1.0: `version` fixed at the
  literal `1`, a `vendor` string, and a `validate` that returns a result rather than throwing, plus
  the optional `types` that carries the input and output types. `validate` is synchronous, which the
  spec permits and which keeps an input check off the microtask queue.

  Four decisions worth knowing:

  - **The key is attached to the schema, not exported beside it.** A TypeBox schema is a plain
    extensible object, so the wrapper is the same object and nothing is dropped. It is defined
    non-enumerably, so `JSON.stringify` still produces the same JSON Schema document byte for byte,
    `Object.keys` still lists only JSON Schema keywords, and `Value.Check`, `TypeCompiler` and
    `Static<typeof X>` all see what they saw before. This is the difference from the Effect
    generator, which must export a second `Standard<Name>` form because
    `Schema.standardSchemaV1` returns a different object that has dropped `.fields`.
  - **The vendor is `drzl/typebox`, not `typebox`.** DRZL implements this and TypeBox does not, so
    claiming TypeBox's name would mislead anything that special-cases a vendor and would collide
    with a first-party implementation whose issues are not shaped like these.
  - **The implementation is emitted, not imported.** One `standard-schema.ts` per output directory,
    exported from the barrel and imported by each table module. Generated code in DRZL has never
    depended on a `@drzl/*` package at runtime and this does not start; a new package could not
    publish by npm OIDC on its first version anyway, and a generated tree that cannot resolve an
    import is the worst place to find that out.
  - **Off by default**, like `duplicateFinder`, because generated code ships in your bundle.

  Also fixes a latent defect the option surfaced. The character and byte cap predicates guarded only
  against `null`, on the assumption that the `Type.String()` beside them in the intersection had
  already passed. `Value.Check` does stop an intersection at its first failing branch, so that held;
  `Value.Errors` does not, so building an issue list for `{ email: 123 }` reached `[...123]` and
  threw. A real tRPC route answered `v is not iterable` with a 400 instead of naming the type it
  wanted. The predicates now guard on `typeof`, as the three other predicates this generator emits
  already did, and the wrapper keeps whatever it collected if a predicate throws anyway. Null and
  undefined still pass the branch exactly as before. Costs 12 bytes per cap branch.

  A union reports one summary error in TypeBox and hangs the branch failures off it, so a nullable
  capped column produced `Expected union value` where the useful message was one level down. The
  wrapper reports the branch failures in place of the summary, and a constraint TypeBox can only
  state as a registered kind reports what the constraint says rather than `Expected kind
'DrzlRowCheck'`. Array indices in `path` are reported as numbers, matching zod, valibot and
  arktype, so code that switches on `typeof segment` behaves the same whichever generator wrote the
  schema.

  `validation.library` on the `orpc` and `trpc` generators still takes `zod`, `valibot` or
  `arktype`. Those generators invent arguments, such as a lookup by primary key, and have no TypeBox
  spelling for them; that is separate work from the Standard Schema gap this closes.

### Patch Changes

- Updated dependencies [4efd19b]
- Updated dependencies [7a46b64]
  - @drzl/validation-core@3.19.0
  - @drzl/analyzer@1.19.0

## 0.11.0

### Minor Changes

- 22f4cb7: Relations-aware nested schemas: `nestedSchemas: true` emits `NestedInsert<Table>` and
  `NestedSelect<Table>` beside the flat ones, the table plus one key per relation, so
  `{ ...user, posts: [...] }` can be validated whole. All four validation generators, off by default,
  and with it off the output is byte-for-byte unchanged.

  **Nothing in the Drizzle ecosystem describes that payload**, which was measured rather than
  assumed. Against `drizzle-orm/{zod,valibot,arktype,typebox-legacy}` at 1.0.0-rc.4 and against the
  0.4x `drizzle-zod`/`drizzle-valibot`/`drizzle-typebox`/`drizzle-arktype` packages,
  `createInsertSchema(users)` returns `['id', 'name']` and never a `posts` key, in every mode and
  every library. Passing the `relations()` object as the second argument lands it in the refine slot,
  where its keys are not column names and it is dropped; passing it first throws inside `getColumns`.
  Grepping both majors for `Relational|withRelations|createRelationSchema|createNestedSchema` finds
  nothing. And the payload is not merely unvalidated:
  `db.insert(users).values({ name: 'a', posts: [{ title: 't' }] })` emits
  `insert into "users" ("id", "name") values (default, $1)` on both majors, so the children are
  silently never written.

  **The child's foreign key is omitted from a nested insert.** `posts.authorId` does not exist until
  the user is inserted, so requiring it makes the schema unusable and permitting it admits a payload
  no correct nested write can honour. It is dropped only where the relation says which column it is,
  meaning the child has exactly one foreign key back to the parent; two or more is ambiguous and
  nothing is dropped, with a comment above the arm saying why. The plain insert schema is untouched,
  and a nested select drops nothing, since the row really comes back carrying its key.

  **`one` is not emitted on insert.** Its foreign key is on the outer object, so admitting the arm
  would mean making that column optional, and an optional NOT NULL foreign key also admits a row with
  neither a key nor a nested parent, which the database refuses. **There is no nested update schema
  at all**: the payload has no single meaning without an operation vocabulary Drizzle does not have,
  and an update schema drops the primary key, so a child in one carries nothing that identifies which
  row it patches.

  **Cycles terminate by depth rather than by recursion.** `nestedDepth` defaults to 1 and is capped
  at 3, and nesting is expanded inline, so `users -> posts -> users` and a self-referencing
  `managerId` both simply stop. All four libraries can express a cyclic schema and each does it
  differently, measured by running them: zod through a property getter, valibot through `v.lazy`,
  ArkType only inside a `scope` (a plain forward reference throws `Cannot access 'Post' before
initialization` at module load), TypeBox only inside a `Type.Module` (a bare `Type.Ref` constructs
  happily and then throws `Unable to dereference schema with $id` the first time anything checks a
  value). Two of the four therefore fail as a broken module rather than as a wrong schema, and inline
  expansion needs none of the four mechanisms and no explicit type annotation.

  Nested shapes are rendered from the columns rather than derived from the sibling schema, because
  deriving does not work in three of the four and fails loudly in only one of those three. Measured:
  zod's `.omit()` **throws** `.omit() cannot be used on object schemas containing refinements`, so
  every table with a row-level CHECK would emit a module that threw on import; valibot's `v.omit`
  over a `v.pipe` silently drops the checks; and TypeBox's `Type.Omit` over the `Type.Intersect` a
  row check emits rewrites the check branch into an empty object and keeps every property required.

  ***

  Two CLI wiring defects of the class the shared options builder was created to remove, both found by
  generating output and reading it rather than by reading the wiring:

  - **`watch` never moved onto the shared builder.** Its zod, valibot and arktype branches still
    assembled six keys by hand, so `coerceDates`, `applyDefaults`, `typedJson`, `typedColumns` and
    `duplicateFinder` were all dropped on a rebuild: the first save after starting `drzl watch`
    silently replaced correct output with output generated from defaults. All three now call
    `validationOptions`, the same function `generate` uses.
  - **`watch` had no typebox or json-schema branch at all.** Those two generators were configured,
    ran under `drzl generate`, and were then skipped by every watch rebuild, so their directories went
    stale from the first save onward with nothing said.

  `packages/cli/test/nested-branch-parity.e2e.spec.ts` runs both commands over a config that sets the
  option for every generator and compares what landed on disk, because reading the two loops is what
  missed both.

### Patch Changes

- Updated dependencies [22f4cb7]
  - @drzl/validation-core@3.17.0

## 0.10.5

### Patch Changes

- 5371d51: A TypeBox select schema stops accepting a row that never mentions a column it declares, and two
  SQLite classes the drizzle-orm 0.4x path could not name are named.

  **The hole was a kind check, not a missing `required`.** Measured on TypeBox 0.34.52 rather than
  reasoned about: `Value.Check` on an object visits every property named in `required` with
  `value[key]`, which is `undefined` when the key is absent, and `Type.Unknown()` accepts `undefined`
  along with everything else. The only thing that then refuses the row is a guard beside that visit,
  `ExtendsUndefinedCheck(property) || IsAnyOrUnknown(property)`, and `IsAnyOrUnknown` reads the
  property's `Kind`. So a bare `Type.Unknown()` keeps its key and
  `Type.Union([Type.Unknown(), Type.Null()])` does not: its kind is `Union`, the guard never fires,
  and the union's own check passes on `undefined` through the unknown arm. `TypeCompiler` agrees with
  `Value.Check` on every case, so neither entry point caught it.

  The `required` array named the key the whole time. Both the emitted source and the serialised JSON
  Schema said the key was required, and one of them was not, which is why this was invisible to
  anything that read the output instead of running it.

  **What changes in the generator.** A nullable column whose type nothing can name no longer gets the
  null union. `Type.Unknown()` already accepts `null`, so the union added no value and took the key
  away. This reaches a `customType`, a column the analyzer could not name, an `any` column and a
  typed json one, each alone or inside the `Type.Unsafe<T>` that `typedJson` and `typedColumns` emit,
  since `Type.Unsafe` copies the wrapped schema's kind. Nothing is lost: the runtime check admits the
  same set of values, and the static type does too, because a bare unknown already includes `null` and
  a narrowed one takes its type from drizzle's own `$inferSelect`, which spells a nullable column
  `T | null` on its own.

  A nullable **array** of unknowns keeps its union, because `Type.Array(...)` has its own kind and
  never had the hole. `insert` and `update` are unaffected: an absent key there is legitimate and is
  decided by `Type.Optional`, which lets the key go missing over an unknown exactly as it should. The
  emitted field shrinks from `Type.Union([Type.Unknown(), Type.Null()])` to `Type.Unknown()`.

  The zod, valibot, ArkType and JSON Schema generators do not change. All four already required the
  key for their own nullable unknown.

  **What changes in the analyzer.** Two SQLite classes fell off the end of the 0.4x class-name path
  and came back `unknown`, so every generator emitted a schema that accepts any value at all. Both
  answers are taken from drizzle's own mappers on 0.45.2 and both match what v1 already says about the
  same column:

  - `blob({ mode: 'buffer' })` builds a `SQLiteBlobBuffer`, whose `mapFromDriverValue` hands the
    driver's Buffer straight back, so it is described as a buffer. A bare `blob()` is the same class
    on this major and is described the same way; on v1 a bare `blob()` builds a `SQLiteBlobJson`
    instead, and each major is reported as it is.
  - `integer({ mode: 'timestamp' })` and `integer({ mode: 'timestamp_ms' })` are one class,
    `SQLiteTimestamp`, and one type: both hand back a `Date`, differing only in the scale of the
    integer on the wire, which `mapFromDriverValue` consumes and no validator ever sees. The arm that
    used to answer this tested `config.mode === 'timestamp'` and named only the first, so the second
    was unknown. Keying on the class covers both.

  A `SQLiteBlob` class does not exist on either major, which is why a real `blob()` reached neither
  that arm nor anything else.

  Naming those two closes the TypeBox key hole for them as a side effect. It does not close it in
  general, which is why the generator changed as well: a nullable `customType` has no runtime shape to
  read on either major and is unnameable by design.

- Updated dependencies [5371d51]
  - @drzl/analyzer@1.17.5

## 0.10.4

### Patch Changes

- 8ba0106: `date({ mode: 'date' })` and `timestamp({ mode: 'date' })` accept an epoch number on write in the
  valibot, ArkType and TypeBox generators, which is what `coerceDates` has always documented.

  `coerceDates` is described as taking a date string **or an epoch number** on insert and update. Only
  the zod generator ever had a number branch. The other three never had one, so every date and
  timestamp column took `Date.now()` in one of the four generators and refused it in the other three,
  on insert and on update alike, and which of your schemas accepted an epoch depended on which
  validator you had chosen rather than on anything you wrote. Measured across all four generators on
  11 date and timestamp columns, the divergence was the same single signature on every one of them.

  The zod generator is the reference the other three now match, and it does not change. Each of the
  other three states the branch in the form its library has. valibot adds a second pipe beside the
  string one, `v.number()` into a transform into the same result check. ArkType adds `number` to the
  union in its string DSL and widens the `.narrow` that already guards the string, so one predicate
  answers for both. TypeBox adds a `Type.Number()` branch intersected with the registered `DrzlRowCheck`
  kind, which is where a predicate can live at all in that library, exactly as its string branch does.

  **A number that is not a date is still refused, in all four.** `new Date(NaN)` and
  `new Date(Infinity)` are Invalid Dates, and so is any finite number past the +-8.64e15 where the
  `Date` range ends, so `1e300` is a good number and not a date. The result check each generator
  already applied to the coerced string now covers the coerced number too, and it is load-bearing
  rather than belt-and-braces: `v.number()` and ArkType's `number` refuse `NaN` on their own and take
  both infinities, `Type.Number()` refuses all three and takes `1e300`, so no library turns all of them
  away by itself.

  **What changes for you.** On a `mode: 'date'` column, `Date.now()` and any other epoch millisecond
  value is accepted on the write path by all four generators. Nothing else moves: a real `Date`, an
  ISO string and every other notation both parsers read the same way still pass, and `'hello'`,
  `'12.5'`, `null`, booleans and arrays are still refused. `coerceDates` itself is unchanged and its
  `all` / `none` / `input` behaviour is the same, so `'none'` still accepts only a real `Date`
  anywhere, `'input'` leaves the select schema strict, and `'all'` extends the same coercion to select.

  The zod and JSON Schema generators do not change.

## 0.10.3

### Patch Changes

- e0ef06c: `date({ mode: 'date' })` and `timestamp({ mode: 'date' })` stop accepting a string that is not a
  date, in the valibot, ArkType and TypeBox generators.

  `coerceDates` lets a client send a date as a string, and a previous fix narrowed _which_ strings may
  be coerced: one that is entirely a number, or that starts with a sign, is refused, because V8 and
  Postgres disagree about what such a string means. That was a gate on the shape of the input, and
  these three generators asked nothing at all about the result. So every string that was not a bare
  number went through: `'hello'`, `'zzz'`, `'25:99:99'`, `'not-a-uuid'`, `'10.0.0.1'`, a uuid, a
  300-character run of `x` and a string of emoji all validated, all became an Invalid Date, and
  Postgres refuses every one of them. Validation passed and the INSERT then failed at the server,
  which is the one outcome an Insert schema exists to prevent.

  The zod generator was already correct and is what the other three now match. `z.preprocess(coerce,
z.date())` validates what came _out_ of the coercion, and an Invalid Date is a real `Date` instance
  that `z.date()` still turns away, so no bare instance check would have done: the timestamp is the
  only thing that differs and it is `NaN`.

  Each library states it in the form it has. valibot adds a `v.check` after the transform, which sees
  the transform's output rather than its input. ArkType adds a `.narrow`, because the constraint is a
  predicate over the result of a call and its string DSL cannot state one. TypeBox has no declarative
  form for it either, so it intersects the registered kind it already uses for character caps onto the
  string branch; the `pattern` beside it still serialises into a JSON Schema, the intersected branch
  does not.

  **What changes for you.** On a `mode: 'date'` column, a string that `new Date` cannot parse is no
  longer accepted on the write path. Everything that reads as a date is untouched: `'2020-01-01'`,
  `'2020-01-01T00:00:00Z'`, `'1999-01-08 04:05:06'`, `'01/02/2020'`, `'January 8, 1999'`, `'2020-1-5'`
  and `'  2020-01-01  '` all still pass, as does a real `Date`. `coerceDates` itself is unchanged and
  its `all` / `none` / `input` behaviour is the same, so `'none'` still emits a plain date type and
  `'all'` still narrows the select schema the same way as the write schemas.

  `'12:00:00'` is worth naming, because the two parsers could have disagreed about it and do not.
  `new Date('12:00:00')` is an Invalid Date, and Postgres refuses `'12:00:00'` for `date`, `timestamp`
  and `timestamptz` with `invalid input syntax`. The types that do take it are `time`, `timetz` and
  `interval`, none of which is ever a `mode: 'date'` column. So it is refused, and both sides agree it
  should be.

  The zod and JSON Schema generators do not change.

- Updated dependencies [e0ef06c]
  - @drzl/validation-core@3.16.4

## 0.10.2

### Patch Changes

- 74afee6: `date({ mode: 'date' })` and `timestamp({ mode: 'date' })` stop accepting a string that is only a
  number.

  `coerceDates` lets a client send a date as a string, and every generator took any string at all in
  that position. `new Date` reads a bare number as a year, or as `month.day`, so `'12.5'`, `'0101'`
  and `'010'` were all real dates and Postgres refuses all three: validation passed and the INSERT
  then failed at the server, which is the one outcome an Insert schema exists to prevent.

  A coerced string now has to look like a date notation. The obvious justification for the rule, that
  Postgres refuses a bare number, turned out to be false and the real one is stronger. Postgres reads
  a six or eight digit run as a compact `YYMMDD` / `YYYYMMDD` date and takes it happily, but where
  both parsers accept such a string they never agree on which date it is. Measured against a real
  Postgres over every all-digit string in the probe set that both accept, ten of them, the two answers
  differed every single time:

  ```
  '250101'    Postgres 2025-01-01    V8 the year 250101
  '241231'    Postgres 2024-12-31    V8 the year 241231
  '121212'    Postgres 2012-12-12    V8 the year 121212
  '000101'    Postgres 2000-01-01    V8 0100-12-31
  '20200101'  Postgres 2020-01-01    V8 refuses it outright
  ```

  So coercing a bare number either sends the server a value it rejects or silently writes a different
  date than the database would have stored. A leading `+` or `-` goes the same way: `'+2020-01-01'`
  and `'-2020-01-01'` are valid dates in V8 and Postgres refuses both.

  **What changes for you.** On a `mode: 'date'` column, a string that is entirely a number, or that
  starts with a sign, is no longer coerced and no longer validates. Everything that reads as a date to
  both parsers is untouched: `'2020-01-01'`, `'2020-01-01T00:00:00Z'`, `'1999-01-08 04:05:06'`,
  `'01/02/2020'`, `'January 8, 1999'`, `'2020-1-5'` and `'  2020-01-01  '` all still pass, as does a
  real `Date`. `coerceDates` itself is unchanged and its `all` / `none` / `input` behaviour is the
  same; this narrows what a coerced string may be, it does not remove coercion. Numbers are untouched
  too, so an epoch millisecond still coerces.

  The JSON Schema generator does not change. Dates arrive as strings once serialised, whatever
  `coerceDates` does in TypeScript, and it already describes them as such.

- Updated dependencies [74afee6]
  - @drzl/validation-core@3.16.3

## 0.10.1

### Patch Changes

- 82c14d0: Postgres float columns accept `NaN` and the infinities they actually store.

  `real` and `double precision` hold `NaN`, `Infinity` and `-Infinity`, and Postgres hands all three
  back on SELECT. Every emitted schema refused them, so reading a row holding one failed validation on
  a column behaving exactly as documented. That is the read path, which no application can avoid.

  No range could have fixed it. A `>=`/`<=` pair refuses `Infinity` whatever the numbers are and `NaN`
  compares false against both ends, so the fact is now carried on the column as `allowsNaN` and
  `allowsInfinity` and each generator renders it as a union beside the range. The range is unchanged
  and still describes the column's finite values, so a `real` still refuses `1e300`.

  Measured against PostgreSQL 18.3, on the bound-parameter path a validator guards:

  ```
  real, double precision   NaN, Infinity and -Infinity all stored and returned unchanged
  numeric (no typmod)      the same three, faithfully
  numeric(10,2)            NaN faithful; either infinity refused, 22003 numeric field overflow
  integer, bigint          all three refused
  ```

  **What changes for you.** On Postgres, a `real` or `double precision` column's schema now accepts
  `NaN`, `Infinity` and `-Infinity`. A `numeric({ mode: 'number' })` column accepts `NaN` and keeps
  refusing both infinities: nothing in the analysis reads a column's precision or scale, so an
  unconstrained `numeric` and a `numeric(10,2)` are indistinguishable, and admitting the infinities
  would promise what the server refuses for the commoner of the two. Integer columns are untouched,
  because Postgres refuses all three there. MySQL and SQLite are untouched; SQLite returns both
  infinities and silently turns `NaN` into NULL, which is a separate answer that has to arrive whole.

  The JSON Schema generator does not change. JSON has no `NaN` and no `Infinity`, so there is nothing
  for it to admit.

- Updated dependencies [82c14d0]
  - @drzl/analyzer@1.17.4
  - @drzl/validation-core@3.16.2

## 0.10.0

### Minor Changes

- 8cc4de8: `point({ mode: 'xy' })` and `line({ mode: 'abc' })` are described as the objects they are, on both
  drizzle-orm majors.

  **`minor`, not `patch`.** The emitted TypeScript type of an object-mode `point` changes from
  `string` (0.4x) or `[number, number]` (v1) to `{ x: number; y: number }`, and of an object-mode
  `line` to `{ a: number; b: number; c: number }`. Code written against the old output does not
  compile against the new. `CONTRIBUTING.md` asks for a bump above patch to be called out, and this is
  the call-out.

  **What changes for a user, in one sentence.** If you have a `point({ mode: 'xy' })`,
  `line({ mode: 'abc' })` or `geometry({ mode: 'xy' })` column, your select schema stops rejecting
  every row the driver returns, and your insert schema stops accepting a value the database refuses.
  Nothing else moves: the tuple modes of the same three builders are untouched, and no other column
  type reaches the code that changed.

  ### It was wrong on both majors, in two different ways

  The two modes of these builders return different JavaScript values, and neither major's description
  separated them.

  On 0.4x there is no `codec` to read, so the column reaches the analyzer by class name, and a coarse
  `/Point|Line/i` answered `string`. That regex was written for the two tuple classes and was catching
  four: swept over every builder `pg-core` exports on 0.45.2, in every mode, it matches
  `PgPointTuple`, `PgLineTuple`, `PgPointObject` and `PgLineABC`, and `string` is wrong for all four.
  The tuple pair was fixed in `@drzl/analyzer@1.15.0`; this is the other half, and the regex is now
  gone rather than narrowed.

  On v1 the column states `dataType: 'object point'` while the tuple mode beside it states
  `'array point'`, and the analyzer read only the second word. Both modes reached one arm and came
  back as tuples, so a v1 select schema for an object-mode column rejected every row.

  ### The database settles it, not the first-party module

  Asked of a real Postgres through PGlite, on drizzle 0.45.2 and again on 1.0.0-rc.4, on a `point`
  and a `line` column:

  | value passed to insert | rendered by drizzle     | server                                 |
  | ---------------------- | ----------------------- | -------------------------------------- |
  | `{ x: 1.5, y: -2.25 }` | `(1.5,-2.25)`           | stored, and read back as `{ x, y }`    |
  | `{ a: 1, b: 2, c: 3 }` | `{1,2,3}`               | stored, and read back as `{ a, b, c }` |
  | `[1, 2]`               | `(undefined,undefined)` | `invalid input syntax for type point`  |
  | `'1,2'`                | `(undefined,undefined)` | `invalid input syntax for type point`  |
  | `{ x: 1 }`             | `(1,undefined)`         | `invalid input syntax for type point`  |
  | `{ x: 1, y: 2, z: 3 }` | `(1,2)`                 | stored: the unlisted key is ignored    |

  `mapToDriverValue` reads `.x`/`.y` off whatever it is handed, which is why a tuple and a string are
  not rejected in JavaScript but produce a literal the server refuses.

  So every named field is required and unlisted keys are not refused: the emitted object is
  `z.object`/`v.object`/`Type.Object` rather than the strict form, which would turn away a write the
  column accepts.

  ### What each generator emits

  | generator     | emitted for `point({ mode: 'xy' })`                   |
  | ------------- | ----------------------------------------------------- |
  | zod           | `z.object({ x: z.number(), y: z.number() })`          |
  | valibot       | `v.object({ x: v.number(), y: v.number() })`          |
  | typebox       | `Type.Object({ x: Type.Number(), y: Type.Number() })` |
  | arktype       | `type({ "x": "number", "y": "number" })`              |
  | JSON Schema   | `type: 'object'` with both fields `required`          |
  | service types | `{ x: number; y: number }`                            |
  | oRPC          | the zod or valibot form above; `unknown` for arktype  |

  ArkType is the one that is not a string. Its definition DSL cannot state an object at all,
  `type({ p: '{ x: number, y: number }' })` throws `'{' is unresolvable`, and it throws at import, so
  the field is emitted as a `type(...)` instance with `.array()`, `.or("null")` and an optional key
  around it. In the oRPC generator, where every field value is a quoted DSL fragment that has to
  compose with the nullable and optional wrappers, ArkType keeps `unknown` for the same measured
  reason it already keeps it for a tuple.

  ### Still not stated

  Postgres refuses a line whose A and B are both zero, `invalid line specification`, and accepts
  `{ a: 0, b: 1, c: 0 }` beside it. No column shape carries a cross-field rule, so the insert schema
  still promises that one write. It is pinned as a measured gap in
  `packages/cli/test/point-object-mode.e2e.spec.ts` rather than left as a remark.

- f019b03: `require('@drzl/…')` now reaches the CommonJS build, which is what these packages have been
  shipping and could not deliver.

  Every one of these packages built a `dist/index.cjs` and then published a manifest that could not
  name it. Ten had no `exports` map at all, so `require('@drzl/generator-zod')` fell through to
  `main`, which pointed at `dist/index.js` beside `"type": "module"`: an ES module. On Node 20.19 and
  Node 22.12 and later, `require()` loads one anyway, so it worked and the `.cjs` sat unused. Below
  those two versions it threw, against an `engines.node` of `>=18.17.0`:

  ```
  ERR_REQUIRE_ESM: require() of ES Module
    /app/node_modules/@drzl/generator-zod/dist/index.js from /app/probe.cjs not supported.
  ```

  Measured on a real install of the packed tarballs: broken on node 18.20.8, 20.18.3 and 22.11.0,
  working on 20.19.6, 22.22.0 and 24.19.0. The ESM half was never affected, and a Node 18 consumer who
  used `import` got correct output from all seven generators, which is why the floor stays at
  `>=18.17.0` rather than being raised: the packages really do run there, and the manifest was what
  was wrong.

  Each package now declares both entries:

  ```json
  "exports": {
    ".": {
      "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
      "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
    }
  }
  ```

  `@drzl/analyzer` was the one package whose `require` condition already named its `.cjs`, so it
  loaded. Its single shared `types` still handed a CommonJS consumer the ESM declarations, and
  `tsc --moduleResolution node16` rejected that with TS1479. It gets the same nested shape.

  **What can break.** These are minors rather than patches for two reasons, both about consumers
  doing something no DRZL documentation shows.

  An `exports` map is a gate: `@drzl/validation-core/dist/index.js` and any other path inside the
  package used to be importable and no longer is. Only the package root is a supported entry, and now
  that is enforced rather than merely intended.

  `main` moves from `dist/index.js` to `dist/index.cjs`, so a bundler old enough to ignore `exports`
  now picks up the CommonJS build. A `module` field pointing at `dist/index.js` is published beside
  it, which is what every bundler that predates `exports` reads first, so this only changes what the
  few that read neither would resolve.

  A consumer on Node 20.19 or newer who already used `require` gets the CommonJS bundle where they
  previously got the ES module through Node's interop. The named exports and `default` are the same
  either way, and `__esModule` is still true.

### Patch Changes

- Updated dependencies [b14cbed]
- Updated dependencies [8cc4de8]
- Updated dependencies [f019b03]
  - @drzl/validation-core@3.16.0
  - @drzl/analyzer@1.18.0

## 0.9.1

### Patch Changes

- d8eb257: A MySQL or SingleStore `binary(n)`/`varbinary(n)` column is a string, and its schemas stop rejecting
  every row.

  The same wrong answer took two forms, one per drizzle major. On 0.4x the analyzer read the word
  "Binary" out of the class name and typed all four column builders as `Uint8Array`; on v1 it read the
  `string binary` dataType those columns share with a Postgres `bit(n)` and gave them a bit string, so
  all five generators emitted `^[01]*$` capped at n. Both are wrong about the same thing, and it was
  settled by asking a live MySQL 8.4 through drizzle on both majors rather than by reading any of the
  three layers in between:

  ```
  raw mysql2          vbin -> Buffer <00 ff 41>
  drizzle 0.45.2      vbin -> string, 3 code points, instanceof Uint8Array false
  drizzle 1.0.0-rc.4  vbin -> string, identical
  ```

  Measured through the emitted modules against that server, before and after, on both majors: the old
  schemas rejected **every** row the column returned in zod, valibot, arktype and typebox, and the new
  ones accept every one of them. The JSON Schema generator accepted them on 0.4x only by accident,
  because `contentEncoding: 'base64'` is an annotation no validator enforces.

  The declared width means two different things depending on direction, and both were measured:

  - **out**, the decode is lossy, so n bytes become at most n code points. `<ff ff ff>` stored in a
    `varbinary(3)` comes back as 3 characters that re-encode to 9 UTF-8 bytes, so a byte cap on a
    select schema refuses a row the column itself returned.
  - **in**, the server counts the encoded bytes. A `varbinary(8)` takes 8 ascii characters and refuses
    9, and takes 2 emoji (8 bytes) and refuses 3 (12 bytes), so a character cap on an insert schema
    promises a write the server refuses.

  So the column now carries a `{ kind: 'byteString', length }` shape and each generator picks the
  measurement its mode needs: characters on select, bytes on insert and update. Over a pool of writes
  against the live server, the four typed generators went from 16 disagreements with it to 0 on each
  major.

  **What changes for you.** A select schema for one of these columns now accepts the string your
  driver hands you and rejects a `Uint8Array`, which is the opposite of the 0.4x behaviour. An insert
  schema accepts any string inside the byte budget, including the empty string and anything that is
  not a run of `0` and `1`, and rejects one that is too long in bytes. `Column.tsType` for these four
  builders is `'string'` and `Column.dbType` is `'BINARY'` on both majors, where 0.4x used to say
  `Uint8Array`/`BLOB`; the declared width moved off `maxLength` and onto the shape.

  **What does not change.** A Postgres `bit(n)` and a Cockroach `bit(n)`/`varbit(n)` keep the bit
  string, which is correct for them. MSSQL `binary`/`varbinary` report `object buffer` and were never
  on this path. Gel `bytes` really does hand back a Buffer and stays a `Uint8Array`. The JSON Schema
  generator states the code-point cap in every mode, since JSON Schema has no keyword that counts
  bytes; that is a necessary condition on insert rather than the whole one.

  `drizzle-orm/zod` emits a bare unbounded string for these columns on 0.4x and the same rejects-every-row
  bit string on v1, so this output is deliberately neither.

- Updated dependencies [d8eb257]
- Updated dependencies [1af970b]
  - @drzl/analyzer@1.17.0

## 0.9.0

### Minor Changes

- 6fbdb22: Fixes two defects on drizzle-orm 0.4x, which is what `npm install drizzle-orm` still serves and
  what this workspace itself depends on, and corrects the bounds on inexact numeric columns on
  **both** majors.

  **`minor`, not `patch`.** The emitted TypeScript type of a `point` column changes from `string` to
  `[number, number]`, and of a `line` from `string` to `[number, number, number]`. Code written
  against the old output does not compile against the new. `CONTRIBUTING.md` asks for a bump above
  patch to be called out, and this is the call-out.

  **What changes for a user, in one sentence each.**

  - A `point` or `line` column: your select schema stops rejecting every row and your insert schema
    stops accepting a string the column cannot be given. On 0.4x only; v1 was already right.
  - A `real`, `double precision`, `float` or `double` column: your schema stops rejecting large
    values the column holds. This is a change on **both** majors, and most of it widens: an 8 byte
    float loses its bound entirely on both, and a 4 byte float on **v1** moves from `drizzle-zod`'s
    `+/-8388607` to a far wider one. **On 0.4x a 4 byte float is a narrowing**, because it had no
    bound there at all. `1e300` and `3.5e38` validated in a `real` before and are refused now, as is
    `Infinity` in valibot and arktype, which is the one value in that set the column really holds and
    which has its own section below. Nothing else that validated before stops validating.
  - A `numeric({ mode: 'number' })` column on 0.4x: newly bounded to the safe-integer range, which
    is a narrowing. A value above 9007199254740991 that validated before is refused now. It could not
    round-trip through a JS number anyway, and both drizzle majors and `drizzle-zod` emit the same
    bound.

  ### point and line were typed `string` on 0.4x

  0.4x carries no codec, so those columns reach the analyzer by class name, and a coarse
  `/Point|Line/i` answered `string` for a value the driver hands back as a tuple. A real Postgres
  settles it rather than the first-party module: drizzle 0.45.2 maps `[1, 2]` to the literal `(1,2)`,
  the column takes it and `mapFromDriverValue` returns `[1, 2]`; the string `"1,2"` is mapped to
  `(1,,)`, because `mapToDriverValue` indexes the value by position, and Postgres refuses it with
  `invalid input syntax for type point`. `point()` is now `[number, number]` and `line()`
  `[number, number, number]`, matching what the analyzer already emitted on v1.

  ### The bound on an inexact numeric column is the database's, not drizzle-zod's

  `real`, `double precision` and `numeric({ mode: 'number' })` on Postgres, `real`, `double` and
  `float` on MySQL and SingleStore, and `real` on SQLite carried no bound at all on 0.4x. The first
  pass at this adopted `drizzle-zod`'s numbers, and asking the database showed they are not limits of
  anything:

  - a `real` column stores 8388608, 9000000, 1e9 and 2147483648 and returns each unchanged, and holds
    every integer exactly up to 16777216. `drizzle-zod` bounds it at +/-8388607, so that bound
    refuses rows the column hands back.
  - a `double precision` column accepted every finite JavaScript number, measured to
    `Number.MAX_VALUE`, and returned each identical. `drizzle-zod` bounds it at +/-140737488355327,
    which refuses 1.75e15, an ordinary microsecond epoch.

  So the bounds are the database's now, and the 4 byte width has two of them, because the two
  databases that impose one do not agree on where it is. Both were bisected over the raw bit pattern
  of a double against a real server. Postgres accepts every double up to `3.4028235677973366e38` in a
  `real` and answers `out of range for type real` to the next one; MySQL 8.4 refuses everything past
  `3.4028234663852886e38`, the largest float32, which is 268435456 representable doubles lower, in
  strict mode and under the stock `sql_mode` alike. The gap is not academic: a `real` at full
  magnitude comes back over the text protocol as `3.4028235e+38`, which is inside Postgres's edge and
  outside the float32, so a schema bounded at the float32 refused a row the column had just handed
  back. An 8 byte float
  carries no magnitude bound, and states `integer: false` alongside, which is true of the column
  and is what keeps the _bounded_ widths from being read as integers: `isIntegerColumn` falls back to
  "declares both bounds" when the flag is absent, so without it a `real` schema would call `.int()`
  and refuse 1.5. On the unbounded widths the flag decides nothing, since there is no pair of bounds
  to fall back to. `numeric({ mode: 'number' })` keeps the safe-integer range, which is about
  what a JS number can carry rather than about the column.

  Measured against this repository's ground-truth stages, which insert every probe into a real
  Postgres. On the 1400 probes those stages carried before this release, DRZL's agreement with the
  database rose from 1007 to 1012 on the validator schemas and from 852 to 857 on the JSON Schema
  output. This release also adds the probe that would have caught the float32 mistake, the value a
  full-magnitude `real` returns, so the pool is 1440 probes now and the totals are not comparable
  across that line: DRZL agrees on 1048 of them against `drizzle-orm`'s 1013, is closer to the
  database on 35 and further on none. That last count, probes where DRZL disagrees with Postgres and
  the first-party module does not, stayed at 0 throughout.

  This puts DRZL deliberately looser than `drizzle-orm/{zod,valibot,arktype,typebox}` on six columns.
  Every one is waived in both parity passes with the measurement attached.

  ### Infinity and NaN are still refused, and that is not fixed

  Postgres stores and returns `Infinity`, `-Infinity` and `NaN` in `real` and `double precision`
  alike. No range admits any of them, and `z.number()` and `Type.Number()` refuse a non-finite number
  with no bound at all, so describing those columns honestly needs a union in every generator rather
  than a wider range. Filed, not fixed.

  One real consequence, stated because the first pass at this removed it silently: on 0.4x, valibot
  and arktype used to accept `Infinity` for these columns, because nothing bounded them. That is
  restored for every 8 byte float column, which now carries no bound again. For a 4 byte float it is
  not: the float4 magnitude bound excludes `Infinity`, so all four libraries refuse it there.

  ### The service and oRPC generators

  Both map a column through a short allowlist and fall to `unknown` for anything else, so a tuple
  column became `unknown` in the emitted TypeScript and `z.unknown()` in an oRPC router's input
  schema, which accepts anything at all including a `null` payload the insert will not survive. Both
  now emit the tuple: `[number, number]` in the service types, `z.tuple([z.number(), z.number()])`
  and the valibot equivalent in oRPC. ArkType keeps `unknown` there, measured rather than assumed:
  that generator emits its field values as quoted string-DSL fragments, and ArkType's string DSL has
  no tuple form.

### Patch Changes

- Updated dependencies [6fbdb22]
  - @drzl/analyzer@1.15.0

## 0.8.1

### Patch Changes

- b692e95: Cap array elements again in the ArkType and TypeBox generators

  Moving `varchar(n)` caps off the UTF-16 keywords dropped them for array columns: `varchar(50).array()`
  emitted a bare `string[]` and `Type.Array(Type.String())`. The cap describes the element, not the
  list, so it now goes on the element, with `.array()` wrapping it in ArkType.

  For TypeBox that also fixed an emitted module that threw on import. The check deciding whether to
  emit the registry preamble still excluded array columns while the expression no longer did, so a
  file used `[Kind]` without importing it. Both now read one shared predicate.

  Found by regenerating the documentation examples, which is the only reason anything looked at a
  capped array.

## 0.8.0

### Minor Changes

- fbc0881: Emit a batch duplicate finder, and stop reading a table-level `unique()` as the primary key

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

### Patch Changes

- 5578e93: Count MySQL TEXT caps in bytes, and stop rejecting valid `varchar(n)` values in TypeBox and ArkType

  Two different measurements were both being got wrong, in opposite directions. Measured against a
  real MySQL 8 on utf8mb4 and a real Postgres, not reasoned about:

  - `varchar(10)` counts **characters** in both databases: ten thumbs-up characters are a valid row.
    TypeBox emitted `maxLength: 10` and ArkType `string <= 10`, both of which count UTF-16 code
    units, so both **refused a row the database accepts**. That is the direction that breaks working
    code. zod and valibot already counted code points.
  - MySQL's TEXT family counts **bytes**: `tinytext` takes 255 ascii characters and 63 thumbs-up
    ones (252 bytes), refusing 64 (256 bytes). The cap was carried as a character count, so a
    tinytext holding 64 emoji validated clean and MySQL refused the row. It is now a separate
    `maxBytes`, applied by encoding the string.

  On drizzle-orm 0.4x the TEXT caps were absent entirely: every member of the family shares the
  `MySqlText` class there, so only the SQL type tells a `tinytext` from a `longtext`.

  Both caps now sit on the field rather than the object, so the differential parity harness, which
  compares column by column, can still see them.

- Updated dependencies [fbc0881]
- Updated dependencies [5578e93]
  - @drzl/analyzer@1.14.0
  - @drzl/validation-core@3.14.0

## 0.7.0

### Minor Changes

- 19dfa3b: Apply `cardinality()` CHECK constraints in the ArkType and TypeBox generators

  `CHECK (cardinality(tags) >= 2)` was parsed and then dropped by both, so an array the database
  refuses validated clean. zod and valibot already applied it.

  Each states it natively rather than as a predicate. ArkType bounds an array's length with the same
  operators it bounds a number with, so it folds into the type: `string[] >= 2`. TypeBox uses
  `minItems` and `maxItems`, which means the constraint survives serialisation to JSON Schema. JSON
  Schema has no exclusive form of either keyword, but a length is an integer, so `> 2` becomes
  `minItems: 3` and nothing is approximated.

  The bound binds to the outermost array, so it counts what `cardinality()` counts, and it sits
  inside the union with null on a nullable column, so null still passes.

- 3e15ea8: Apply `length()` CHECK constraints in the ArkType and TypeBox generators

  `CHECK (length(name) >= 3)` was parsed, applied by zod and valibot, and dropped in silence by the
  other two: ArkType emitted a bare `string` and TypeBox a bare `Type.String()`. A constraint the
  database enforces and the validator does not is precisely the gap these generators exist to close.

  Neither uses its native length keyword, and that is deliberate. ArkType's `string >= 3` and
  TypeBox's `minLength` both count UTF-16 code units, while SQL's `length()` counts characters, so
  three thumbs-up characters are six units to both. On a minimum that only under-enforces; on a
  maximum it refuses rows the database accepts, which is the `varchar(n)` bug the zod generator
  already avoids by counting code points.

  So each goes where an exact count can be expressed: a `.narrow()` on the object for ArkType, and a
  branch of the same registered-kind intersection the row checks use for TypeBox. Null and absent
  both pass, matching SQL.

  The cost for TypeBox is that this constraint does not survive serialisation to JSON Schema, where
  a bare `minLength` would. Emitting the wrong count in a form that serialises is not a better
  trade.

- b274391: Enforce row-level CHECK constraints in the valibot, TypeBox and ArkType generators

  `CHECK (start_date < end_date)` compares two columns, so it cannot be a field constraint. Only the
  zod generator applied one; the other three parsed it and dropped it, so a row the database refuses
  validated clean. Each generator now states it in its own idiom: `v.check` on a pipe for valibot,
  `.narrow` for ArkType, and for TypeBox a registered kind intersected with the object, which both
  `Value.Check` and `TypeCompiler` honour. Serialising a TypeBox schema to JSON Schema keeps the
  constraint as a description, since JSON Schema cannot compare two fields.

  Both sides are guarded for null first, matching SQL, where a comparison involving NULL leaves the
  CHECK satisfied. A constraint naming a column a given mode does not carry is left out rather than
  emitted against an undefined value.

  Also fixes an ArkType crash this uncovered: a CHECK on a column with no declared width, which is
  every numeric type but the integers, emitted `0 < number`. ArkType rejects a left bound with no
  right bound, so the generated module threw the moment anything imported it. A lone bound is now
  written as `number > 0`.

### Patch Changes

- 698e7b3: One options builder for every validation generator, and a default that was being dropped.

  Each of the four generator branches in the CLI hand-built its own options object. Three documented
  options had already been found silently dead that way: `typedJson` never reached typebox, and
  `coerceDates` and `applyDefaults` never reached anything but zod. Fixing each instance did not
  address the shape of the problem, so the four now share one builder and an option added once
  reaches everything that can act on it.

  What stays per-generator is a real capability rather than an oversight, and it is named as one:
  ArkType does not receive the schema-import options, because it emits one string per field and a
  TypeScript type reference has nowhere to live inside a string DSL.

  ### The default that was being dropped

  Auditing the result immediately turned up another: with `typedColumns` **and** `applyDefaults`
  both on, the typebox generator emitted no default at all.

  ```ts
  // before
  country: Type.Optional(Type.Unsafe<(typeof users.$inferInsert)['country']>(Type.String())),
  // after
  country: Type.Optional(Type.Unsafe<(typeof users.$inferInsert)['country']>(Type.String({ default: 'GB' }))),
  ```

  The default was being applied after the `Type.Unsafe` wrapper, where it lands on the wrapper
  rather than the schema, and the helper that attaches it declines anything that is not a bare
  `Type.X(...)`. So it returned the expression untouched and the default vanished without a word.
  It now goes on the schema before anything wraps it.

  Neither option is on by default, so this only affects a project that had turned both on.

- Updated dependencies [78aeca2]
- Updated dependencies [dc13c47]
- Updated dependencies [c29891a]
  - @drzl/analyzer@1.13.0

## 0.6.0

### Minor Changes

- c99ac3d: `applyDefaults` for every generator, `typedColumns` for TypeBox, and three options that silently
  did nothing.

  ### `applyDefaults` everywhere

  It shipped for zod only. Each library states a default in its own way, and all four now do:

  ```ts
  country: z.string().default("GB"),                        // zod
  country: v.optional(v.string(), "GB"),                    // valibot
  country: 'string = "GB"',                                 // arktype
  country: Type.Optional(Type.String({ default: "GB" })),   // typebox
  ```

  All four parse `{ name: 'x' }` into `{ name: 'x', country: 'GB', count: 0, flag: true }`, which is
  the row Postgres writes for the same insert. Checked by running the emitted modules rather than by
  reading them.

  One difference worth knowing: TypeBox's `Value.Check` does **not** materialise a default, only
  `Value.Parse` and `Value.Default` do. It separates validating from defaulting where zod and valibot
  fold the two together.

  ### `typedColumns` for TypeBox

  `Type.Unsafe<T>(schema)` wraps an existing schema, so every check it carries still runs and only
  the inferred type is replaced:

  ```ts
  role: Type.Unsafe<(typeof users.$inferSelect)['role']>(Type.String({ maxLength: 50 })),
  ```

  That leaves ArkType as the one generator that cannot do this, and it is not an oversight: it emits
  one string per field, and a TypeScript type reference has nowhere to live inside a string DSL.

  ### Three documented options that did nothing

  Found while wiring the above, each confirmed by generating and reading the output rather than by
  inspecting the code:

  - **`typedJson` on a `typebox` generator was ignored.** The CLI never passed it, so a json column
    emitted the generic `DrzlJsonValue` no matter what the config said.
  - **`coerceDates` was ignored by every generator.** It was documented on the zod generator, but the
    config schema had no such key, so `coerceDates: 'none'` parsed and was dropped. The output kept
    coercing.
  - **`applyDefaults` reached only zod**, for the same reason, until the other three branches were
    given it.

  Each generator branch in the CLI built its own options object by hand, so an option added to one
  was simply absent from the others. All four now pass everything they support.

## 0.5.0

### Minor Changes

- d557658: CHECK constraints: `IN` lists and conjunctions.

  The two most common shapes a CHECK is written in were both skipped. No official Drizzle validator
  module enforces any CHECK at all, so these are added to a list that already had no competition.

  ### `IN` lists become enums

  ```ts
  // check('status_valid', sql`${t.status} IN ('active', 'archived')`)
  status: z.enum(['active', 'archived'] as const),
  ```

  A set constraint is what an enum is, so it takes the enum's shape in each library rather than
  becoming an opaque predicate, and the static type narrows with it: `v.picklist` for valibot,
  `'active' | 'archived'` for ArkType, `Type.Union([Type.Literal(...)])` for TypeBox.

  ### Conjunctions split into one check per part

  ```ts
  // check('n_bounds', sql`${t.n} > 0 AND ${t.n} < 10 AND ${t.n} <> 5`)
  n: z.number().int()
    .refine((v) => v > 0, { message: 'n_bounds: n > 0' })
    .refine((v) => v < 10, { message: 'n_bounds: n < 10' })
    .refine((v) => v !== 5, { message: 'n_bounds: n <> 5' }),
  ```

  Every part of an `AND` has to hold on its own, which is exactly what a list of refinements means.

  The split walks the expression rather than splitting on the text, so the `AND` inside `BETWEEN 1
AND 10` and the one inside `'A AND B'` are both left alone. Lifting `BETWEEN` above the split was
  necessary for that: taking the naive order silently turned every `BETWEEN` into an unparseable
  pair and dropped a constraint that had been enforced since the feature shipped.

  ### What is still refused, and why it grew

  `OR` and `NOT` anywhere in the expression disqualify it. A conjunction is safe to break apart
  because each part holds independently; a disjunction is not, and separating them inside a mixed
  expression needs a real parser. A conjunction where any single part is not understood is refused
  whole rather than partially applied, since enforcing half of a constraint is enforcing a different
  constraint.

  Verified against a real Postgres through PGlite: for `CHECK (status IN ('active','archived'))`,
  `CHECK (age >= 18 AND age <= 65)` and `CHECK (n > 0 AND n < 10 AND n <> 5)`, the emitted schema and
  the database agree on all 19 probes, NULL included.

### Patch Changes

- Updated dependencies [d557658]
  - @drzl/validation-core@3.8.0

## 0.4.0

### Minor Changes

- fadf2fb: Check generated schemas against Postgres itself, and validate the numeric format.

  Every check so far compared DRZL to `drizzle-orm`'s validators. Both can be wrong about the same
  column and neither is the authority, so `verify:packed` now runs the emitted schemas against a
  real Postgres through PGlite: 1287 probes, each an actual INSERT, with the database answering
  directly.

  DRZL agrees with Postgres on **920** of them to `drizzle-orm`'s **897**, and is never further from
  the database on a column where `drizzle-orm` is closer.

  ### What it found

  A `numeric`/`decimal` column is returned as a string, because a JS number cannot hold arbitrary
  precision. That left the schema a bare `z.string()`, which accepts `'hello'` for a numeric column.
  `drizzle-orm/zod` still does; Postgres rejects it. Numeric columns now carry the real grammar,
  which is broader than it looks: a sign, a leading `.`, exponents, `NaN`/`Infinity`, surrounding
  whitespace, and since Postgres 16 the underscore digit separators and `0x`/`0o`/`0b` literals, so
  `1_000` and `0xDEAD_beef` are valid. Not applied on SQLite, whose NUMERIC affinity stores whatever
  text it is given.

  ### What it stopped

  `date`, `timestamp`, `time`, `interval`, `inet`, `cidr` and `macaddr` were all attempted and all
  dropped, each caught turning away input Postgres accepts:

  | Type      | What the pattern would have refused                              |
  | --------- | ---------------------------------------------------------------- |
  | `date`    | `today`, `January 8, 1999`, `20200101`, `01/02/2020`, `infinity` |
  | `time`    | `allballs`, `12:00:00+02`                                        |
  | `macaddr` | `2020-01-01`, which Postgres pads into `20:20:00:01:00:01`       |
  | `inet`    | `10.1/16`, `::ffff:1.2.3.4`                                      |
  | `cidr`    | parses as `inet`, then additionally demands zero host bits       |

  Those keep a plain string. A check that refuses valid data is worse than no check, and without the
  database to ask, all seven looked equally shippable.

  ### The gate

  CI fails if a generated schema disagrees with Postgres where `drizzle-orm` agrees, which is what
  an over-strict check looks like. Verified to bite by removing underscore support from the numeric
  pattern: it fails and names `'1_000'`.

  Incidentally settled an earlier judgement call: DRZL types `bytea` as `Uint8Array` where official
  demands a `Buffer`, and Postgres accepts the `Uint8Array`. Official is the one refusing valid data
  there.

### Patch Changes

- Updated dependencies [fadf2fb]
  - @drzl/validation-core@3.7.0
  - @drzl/analyzer@1.9.0

## 0.3.0

### Minor Changes

- 31d4a83: MySQL and SQLite parity, insert and update parity, and generated columns.

  The parity gate added last release covered Postgres select schemas. Extending it to three dialects
  and all three modes turned up **54 findings**, including two regressions from that same release.
  All are fixed and the gate now runs the full cross product.

  ### Insert schemas invited writes the database rejects

  The analyzer derived "generated" from `col.autoIncrement || col.isGenerated`, and
  **`col.isGenerated` is undefined on every Drizzle column of every dialect**, so the second half
  never fired at all. A `generatedAlwaysAs(...)` column and a `generatedAlwaysAsIdentity()` column
  both appeared in insert schemas, and an insert built from one is rejected by Postgres outright.

  The first half then over-fired in the other direction: a MySQL `autoIncrement` column was dropped
  from insert schemas entirely, when `AUTO_INCREMENT` supplies a value if you omit one rather than
  forbidding you from supplying your own. The same construct therefore behaved differently per
  dialect, since a Postgres `serial` was already merely optional.

  | Column                           | Before            | Now      |
  | -------------------------------- | ----------------- | -------- |
  | `generatedAlwaysAs(...)`         | present on insert | omitted  |
  | `generatedAlwaysAsIdentity()`    | present on insert | omitted  |
  | `generatedByDefaultAsIdentity()` | present           | optional |
  | MySQL `autoincrement()`          | omitted           | optional |

  ### Two regressions from the previous release

  Both were introduced by the v1 `dataType` mapper and are fixed here.

  - **MySQL `tinyint` and `mediumint` lost their bounds.** The mapper had no `int8` or `int24` case,
    so they fell to its bare-number arm, whose safe-integer bounds then _overrode_ the correct ones:
    a tinyint went from `+/-127` to `+/-9007199254740991` and stopped being an integer at all.
  - **MySQL `binary`/`varbinary` were treated as Postgres `bit`.** Both report `dataType: "string
binary"` and only the codec separates them, so every MySQL binary column rejected `''` and
    anything that was not a run of 0s and 1s at exactly the declared width.

  ### SQLite was skipped by the v1 path entirely

  SQLite columns carry a `dataType` but no `codec`, and the mapper gated on the codec. So the whole
  dialect stayed on class-name matching: `text({ mode: 'json' })` and the json blob modes emitted
  `z.any()`, `blob({ mode: 'buffer' })` emitted `z.unknown()` (which accepts `null` on a NOT NULL
  column), and `blob({ mode: 'bigint' })` lost its 64 bit range.

  ### MySQL widths that nothing else states

  `tinyint`, `mediumint`, `year` and the unsigned `serial` now carry their real ranges, and the text
  and blob families carry the cap the type itself implies, which is on no property of the column:

  | Column        | Now                                                 |
  | ------------- | --------------------------------------------------- |
  | `tinyint()`   | `-128 .. 127`                                       |
  | `mediumint()` | `-8388608 .. 8388607`                               |
  | `year()`      | `1901 .. 2155`                                      |
  | `serial()`    | `0 ..`, since it is unsigned                        |
  | `text()`      | `max(65535)`, `tinytext` 255, `longtext` 4294967295 |

  Gated on the dialect, because the codec names collide: Postgres `text` reports the codec `text`
  too and has no cap at all.

  ### Date columns accepted null

  `coerceDates` defaults to coercing on write, and that was `z.coerce.date()`, which is `new Date(v)`
  on anything. `new Date(null)` is the epoch and `new Date(true)` is one millisecond past it, so a
  NOT NULL timestamp column accepted `null`, `true` and `[1, 2]`, each silently becoming a real date.
  Coercion is now limited to strings and numbers, which is what the option was for.

  ### TypeBox cannot back an oRPC router, and now says so

  oRPC types `.input()`/`.output()` as a [Standard Schema](https://standardschema.dev). Neither
  `@sinclair/typebox` nor the newer `typebox` package implements it, while zod, valibot and arktype
  all do, so `validation.library` on an `orpc` generator does not accept `typebox` and the docs
  explain why. The standalone typebox generator is unaffected.

  While confirming that, the oRPC generator's library handling moved from chains of ternaries to a
  per-library table. The chains ended in `... : valibot`, so any library they did not recognise
  would have silently emitted valibot code rather than failing.

  ### `customType` columns keep their type

  A `customType` column has nothing checkable at runtime, and guessing from `getSQLType()` would be
  wrong: that reports the _database_ type, and `fromDriver` may map it to anything, so a
  `numeric(12,2)` custom column can hand back a number where a plain numeric hands back a string.

  It stays `z.unknown()`, and `typedJson` now recovers the declared type the same way it does for
  json, by referencing Drizzle's own inference:

  ```ts
  balance: z.custom<(typeof accounts.$inferSelect)['balance']>(),
  ```

  `drizzle-orm/zod` emits `z.any()` for these, losing both the type and the narrowing that `unknown`
  forces at the call site.

  ### The gate

  `verify:packed` now measures three dialects times three modes times each library, 15 combinations
  over 82 columns, and cross-checks DRZL's four generators against each other. Deliberate
  divergences are listed with their reasons and everything else fails the build.

### Patch Changes

- Updated dependencies [31d4a83]
  - @drzl/validation-core@3.5.0
  - @drzl/analyzer@1.8.0

## 0.2.0

### Minor Changes

- eeafa5c: Array and structured columns, and a measured parity gate against the official validators.

  A differential harness now generates schemas for a 39 column Postgres table with DRZL and with
  `drizzle-orm/{zod,valibot,arktype}`, then pushes the same pool of values through both, column by
  column. It found DRZL weaker on **15 of 39 columns**. All 15 are fixed, and the harness runs in
  CI as part of `verify:packed` so a new divergence fails the build rather than being noticed later.

  ### Columns whose schema rejected every row
  - **Arrays were collapsed to their element.** Drizzle gives an array no class of its own:
    `text().array()` is still a `PgText`, separated from a scalar only by `dimensions`. Reading the
    class alone produced `z.string()`, which rejected `['a']` and accepted `'a'`.
  - **`point`, `line` and `geometry` were mapped to strings.** They arrive as `[number, number]`.
  - **`serial` was lower-bounded at 1.** Postgres serial is an ordinary integer column that defaults
    from a sequence; the sequence starts at 1, the column does not, and inserting `0` or a negative
    is how backfills and sentinel rows get written.
  - **ArkType output containing a binary column could not be imported at all.** `'Uint8Array'` is
    not an ArkType keyword, so the emitted module threw `'Uint8Array' is unresolvable` at import and
    took its importer with it. The keyword is `TypedArray.Uint8`.

  ### Columns whose schema accepted anything

  `bytea`, `bit` and `vector` emitted `z.unknown()`, which accepts `null` on a NOT NULL column.
  `json` and `jsonb` emitted `z.any()`, which accepts `undefined`, `NaN`, `Infinity`, bigints, Dates
  and Buffers, none of which survive the round trip. `real`, `double precision` and
  `numeric({ mode: 'number' })` were unbounded.

  | Column                      | Before        | Now                                     |
  | --------------------------- | ------------- | --------------------------------------- |
  | `text().array()`            | `z.string()`  | `z.array(z.string())`                   |
  | `point()`                   | `z.string()`  | `z.tuple([z.number(), z.number()])`     |
  | `vector({ dimensions: 3 })` | `z.unknown()` | `z.array(z.number()).length(3)`         |
  | `bit({ dimensions: 3 })`    | `z.unknown()` | `z.string().regex(/^[01]*$/).length(3)` |
  | `bytea()`                   | `z.unknown()` | `z.instanceof(Uint8Array)`              |
  | `jsonb()`                   | `z.any()`     | `z.json()`                              |
  | `real()`                    | `z.number()`  | `z.number().gte(-8388608).lte(8388607)` |
  | `serial()`                  | `.gte(1)`     | `.gte(-2147483648)`                     |

  All four generators handle all of it, and the harness also checks the four against each other, so
  `bytea` validates identically whichever validator you pick.

  ### Two bugs found only by running the output
  - **Every ArkType `integer()` column accepted `1.5`.** The generator preferred the range on the
    theory that an integer range implied integrality. ArkType parses
    `-2147483648 <= number.integer <= 2147483647` perfectly well and rejects the fraction.
  - **`v.tuple` ignores extra items**, so a valibot `point` accepted `[1, 2, 3]`. `v.strictTuple`
    holds the arity. `drizzle-orm/valibot` uses the plain form and accepts the third element.

  ### Reading the type from Drizzle rather than guessing at it

  Drizzle v1 stamps every column with a `dataType` of the form `"number int32"`, `"object buffer"`,
  `"array point"`, plus a `codec` naming the SQL side. The analyzer now reads those. It used to
  match on the constructor name against a list running to dozens of entries per dialect, with a
  regex fallback that guessed from the name when it missed, which is how `PgBinaryVector` came out
  as a vector when it is a bit string. The class-name path is still there for Drizzle 0.4x, which
  carries no `codec`.

  `Column` gains `arrayDimensions`, `shape`, and `integer`. That last one exists because the
  generators each inferred "is an integer" from "declares both bounds", which was true only while
  integers were the only bounded type: bounding `real` made every float schema reject `1.5` until
  the flag replaced the inference.

  ### Where DRZL deliberately differs
  - `bytea` accepts any `Uint8Array` where official demands a `Buffer`. A Buffer is a Uint8Array, so
    nothing official accepts is turned away, and the wider check needs no `@types/node`, works in a
    runtime with no `Buffer`, and makes a Postgres `bytea` and a SQLite `blob` behave the same.
  - valibot json rejects `Infinity` and class instances, which the official one accepts.
  - ArkType `bigint` carries no range. Its comparison operators take numeric literals, so a 64 bit
    bound cannot be written in the string DSL this generator emits; official states it with a narrow
    predicate built through the builder API.

  Each is listed in the harness with its reason, so it stays a decision rather than drift.

### Patch Changes

- Updated dependencies [eeafa5c]
  - @drzl/validation-core@3.4.0
  - @drzl/analyzer@1.7.0

## 0.1.0

### Minor Changes

- 5a99384: New generator: `@drzl/generator-typebox`.

  ```ts
  { kind: 'typebox', path: 'src/validators/typebox' }
  ```

  TypeBox is the second most used validator in the Drizzle ecosystem: `drizzle-typebox` at 41,537
  weekly downloads beats `drizzle-valibot` (17,216) and `drizzle-arktype` (6,761) _combined_ by
  1.73x. DRZL shipped both of the smaller ones and not this one.

  It has everything the other three generators have: column constraints, CHECK constraint
  enforcement, `typedJson`, affixes, file suffixes and import extensions. Because TypeBox is JSON
  Schema, constraints are keywords rather than chained calls, which makes the output the most
  directly readable of the four and usable by anything that speaks JSON Schema:

  ```ts
  export const SelectpeopleSchema = Type.Object({
    age: Type.Integer({ minimum: 18, maximum: 2147483647 }), // CHECK (age >= 18)
    score: Type.Union([Type.Integer({ minimum: 0, maximum: 100 }), Type.Null()]),
    tier: Type.Literal('gold'), // CHECK (tier = 'gold')
  });
  ```

  ### Two places TypeBox fails silently, both handled

  TypeBox accepts an option it does not understand for a given type and then ignores it, so a
  schema can look right, compile, and validate nothing. Both of these were found by running the
  emitted schemas rather than reading them:

  - **`format` needs registration.** `Type.String({ format: 'uuid' })` returns `false` for a
    perfectly valid uuid in any project that has not populated `FormatRegistry`. A uuid column is
    emitted as a `pattern` instead, which needs no setup.
  - **`const` is ignored on `String` and `Integer`.** `Type.String({ const: 'gold' })` validates
    `'silver'`, and `Type.Integer({ const: 5 })` validates `6`. An equality check is emitted as
    `Type.Literal` instead, which is the only form that enforces.

  The test suite writes the emitted module to disk, imports it, and runs `Value.Check` against it,
  because asserting on generated source text cannot tell the difference between a schema that
  validates and one that merely parses.

### Patch Changes

- Updated dependencies [5a99384]
  - @drzl/validation-core@3.3.0
