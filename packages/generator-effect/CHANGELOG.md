# @drzl/generator-effect

## 0.5.3

### Patch Changes

- 8903870: `CHECK (LENGTH(col) <= n)` on MySQL is a byte budget, and is now read as one

  The CHECK parser is one parser for every engine, and `length()` is not one function:

  ```
              length()      char_length()   octet_length()
  Postgres    characters    characters      bytes
  SQLite      characters    characters      bytes
  MySQL       BYTES         characters      bytes
  ```

  So `CHECK (LENGTH(name) <= 5)` on a MySQL `varchar` was read as a five-character cap where the
  server enforces five bytes. Measured on 8.4.11 on utf8mb4 through a real constraint: `'一'` is
  accepted at three bytes and `'一二'` is refused at six bytes and two characters, while the schema
  accepted the second. The error ran in the safe direction, since five bytes can never be more than
  five characters, so no valid row was ever turned away; it under-enforced, which is the half a
  validator exists for.

  Verified end to end after the fix, the emitted schema against the server that enforces the CHECK:
  six values covering ASCII, CJK and emoji, at and over the bound, and the two agree on every row.

  `Table` now carries the engine it was declared for. That is the same kind of duplication `Column`
  already has, where `maxBytes`, `allowsNaN` and `format` are dialect-derived facts stamped on so
  nothing downstream has to know which server it is looking at; the shared check helpers take a
  `Table` rather than an `Analysis`, and `length()` is the one thing they could not read without it.
  `parseCheck` takes the dialect as an optional third argument, and absent still means the Postgres
  reading, so a caller that does not know its engine keeps the answer it already had.

  `LengthCheck` also carries the function as written. The label the constraint ledger matches an
  issue's message against is built from it, and deriving the name back from the unit would have
  relabelled a user's `length(name) <= 5` as `octet_length(name) <= 5`: a constraint they did not
  write, in the one string two surfaces compare exactly. `char_length` is still printed as `length`,
  which Postgres treats as the same function.

  SingleStore is MySQL wire-compatible and is deliberately not claimed, for the reason the analyzer
  gives everywhere else: no server of its own was measured.

- Updated dependencies [8903870]
  - @drzl/analyzer@1.21.4
  - @drzl/validation-core@3.22.4

## 0.5.2

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

## 0.5.1

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

## 0.5.0

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

## 0.4.1

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

## 0.4.0

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

## 0.3.0

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

### Patch Changes

- Updated dependencies [4efd19b]
- Updated dependencies [7a46b64]
  - @drzl/validation-core@3.19.0
  - @drzl/analyzer@1.19.0

## 0.2.0

### Minor Changes

- 3b53229: Add `@drzl/generator-effect`: Effect Schema validators from a Drizzle schema.

  `{ kind: 'effect', path: 'src/validators/effect' }` emits an insert, update and select schema per
  table, built on `effect/Schema` from `effect` core 3.x. Everything the other validation generators
  handle is handled here: every column type the analyzer produces, nullable against optional, CHECK
  constraints through `parseCheck` including the array and JSON guards, declared numeric precision
  and bounds, `maxLength`/`maxBytes`, `applyDefaults`, `typedJson`, `typedColumns`, `duplicateFinder`,
  `coerceDates`, affixes and nested relation schemas.

  Three things differ from the existing four, each measured rather than assumed:

  - **Both a bare and a Standard Schema form are emitted.** A bare `Schema.Struct` carries no
    `~standard` key, so `Standard<Name>` is exported beside every schema as
    `Schema.standardSchemaV1(<Name>)`. The bare form is the one that composes, since the wrapper drops
    `.fields`. This is the difference from TypeBox, which has no route to Standard Schema at all.
  - **`Schema.Number` accepts `NaN` and both infinities**, which is the opposite of `z.number()` and
    `Type.Number()`. Numeric columns therefore build on `Schema.Finite`, unconditionally rather than
    relying on the range, since `Infinity >= 0` is true.
  - **`effect` is an optional peer**, unlike the required validator peers of the other four.
    `drizzle-orm@1.0.0-rc.4` declares its own optional peer on `effect` as
    `>=4.0.0-beta.83 || >=4.0.0`, and npm auto-installs a required peer, so declaring one made
    `npm install @drzl/cli drizzle-orm@1.0.0-rc.4` fail with `ERESOLVE` for every consumer. Install
    `effect` yourself; the floor is 3.13.0, where `Schema.standardSchemaV1` first appears.

  Character limits are counted in code points rather than UTF-16 units, so a `varchar(10)` accepts ten
  astral-plane characters exactly as the database does.

  `ValidationLibrary` in `@drzl/validation-core` gains `'effect'`, and the CLI wires the new kind into
  both the `generate` and `watch` dispatch loops and into `computeGeneratorOutputDirs`.

### Patch Changes

- Updated dependencies [3b53229]
  - @drzl/validation-core@3.18.0
