# @drzl/generator-json-schema

## 0.8.0

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

- f29bff7: Write a shared enum once and reference it, instead of inlining it at every use

  A `mood` enum on six columns was six copies of the same list in each of the three schemas, and
  eighteen in a document. It is now one definition with references pointing at it.

  ```jsonc
  // openapi.json, always. The definition is a component.
  {
    "components": { "schemas": { "mood": { "enum": ["sad", "ok", "happy"] } } },
    "properties": { "m1": { "$ref": "#/components/schemas/mood" } }
  }

  // people.schema.ts, on `sharedEnums: true`. A standalone JSON Schema document.
  {
    "$defs": { "mood": { "enum": ["sad", "ok", "happy"] } },
    "properties": { "m1": { "$ref": "#/$defs/mood" }, "m2": { "$ref": "#/$defs/mood" } }
  }
  ```

  **`sharedEnums` is off by default, and the reason is a consumer pattern rather than a doubt about
  the keyword.** A per-table schema is used two ways: whole, and one property at a time. Reaching into
  `properties[col]` is the JSON Schema equivalent of reading zod's `.shape`, it is how a form builder
  gets one field's rules, and it is how `scripts/verify-packed.sh` checks these schemas against a real
  Postgres. A `$ref` cannot survive that: pulled out of the schema that holds its `$defs` it is a
  dangling reference and ajv refuses to compile it at all, `can't resolve reference #/$defs/mood from
id #`. Whole, it compiles and validates exactly as before. The OpenAPI document shares regardless,
  because a document is only ever read whole.

  **Where the definition goes depends on the document, and the two are not interchangeable.** Measured
  against `@seriousme/openapi-schema-validator`, which carries the real 3.0 and 3.1 meta-schemas:

  | placement                                 | OpenAPI 3.0             | OpenAPI 3.1                |
  | ----------------------------------------- | ----------------------- | -------------------------- |
  | `components.schemas` + `#/components/...` | valid                   | valid                      |
  | `$defs` in a schema + `#/$defs/...`       | INVALID, closed object  | INVALID, `$ref` unresolved |
  | `anyOf: [{$ref}, {type: 'null'}]`         | INVALID, no `null` type | valid                      |

  3.0's Schema Object is closed, so `$defs` beside `properties` fails the whole document. 3.1 allows
  the keyword and still fails, because a `$ref` inside a document resolves against the document root
  where `#/$defs/mood` names nothing. So `$defs` appears only in the standalone per-table modules on
  the `draft-2020-12` target, and only under `sharedEnums`; the OpenAPI document shares through
  `components.schemas`.

  **`components.ts` shares nothing, and that is the one place this stops.** It is a fragment the
  caller spreads into a document, and a `$ref` is a promise about where the thing holding it is
  mounted: `#/components/schemas/mood` resolves once the fragment sits at exactly that path and
  nowhere else. Every entry there stays self-contained, so a caller can hand one schema to a validator
  on its own; ask ajv to compile a cross-referencing entry alone and it answers `can't resolve
reference #/components/schemas/mood from id #`. `components.ts` is byte-for-byte what it was.

  **Nullable columns.** 2020-12 and 3.1 spell a nullable reference as `anyOf: [{ $ref }, { type:
'null' }]`, which validates. 3.0 has neither half of that: `type: 'null'` is not one of its six
  types, and it defines every sibling of `$ref` to be ignored, so `{ $ref, nullable: true }` is a
  schema that silently refuses null. A nullable enum column in a 3.0 document therefore keeps the
  inline enum it has always had, and the shared definition still serves every other use.

  **Only shared enums, and only declared ones.** Two or more columns is the threshold. A single use
  gains nothing from the indirection, and a `CHECK (status IN ('a','b'))` stays inline because it is a
  constraint on one column rather than a named type: two columns whose `IN` lists happen to agree are
  two constraints, and giving them a shared name would invent both the concept and the name. The
  definition's key comes from the analysis's own enum list, since a column carries values and no name.
  An enum whose name collides with a table's schema name, or which sanitises to nothing, stays inline
  rather than being disambiguated into a name that moves when a table is added.

  **Size.** A saving on every enum but the very shortest, because
  `{"$ref":"#/components/schemas/mood"}` is 36 bytes and `{"enum":["sad","ok","happy"]}` is 29.
  Measured on an OpenAPI 3.1 document, one table, n columns carrying the enum:

  | enum             | 1 col | 2 cols | 3 cols | 6 cols |
  | ---------------- | ----- | ------ | ------ | ------ |
  | 3 short values   | 0     | +58    | +70    | +106   |
  | 5 values         | 0     | -97    | -178   | -421   |
  | 12 country codes | 0     | -147   | -258   | -591   |
  | 20 long values   | 0     | -1697  | -2738  | -5861  |

  The threshold stays at two columns rather than becoming "wherever it saves bytes". The point of the
  definition is that the document names a type, so a client generator emits one enum class where six
  inline lists are six anonymous unions it cannot tell are the same thing; a rule keyed on encoded
  length would flip the output when somebody adds a value.

  A schema with nothing shared is byte-for-byte what it was.

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

## 0.7.0

### Minor Changes

- a0e49e3: Multi-schema support: two tables of the same name in different Postgres schemas, addressed and
  generated end to end.

  `pgSchema('reporting').table('users', ...)` and `pgTable('users', ...)` are two different relations
  that share one database name. The analyzer already recorded which schema each was declared in, and
  nothing downstream read it, so every surface that addresses a table by name treated the two as one.

  What was measured, rather than assumed, before any of this was written:

  - **File names, export names, the barrel, the service and router files never collided.** All of them
    are derived from the Drizzle _export_ name, which is unique within a module by construction, so
    `users.zod.ts` and `reportingUsers.zod.ts` sat side by side and the barrel was already valid. That
    is now pinned by a test rather than left to hold by accident.
  - **The OpenAPI document refused to build at all.** Both tables wanted `/users`, and the path guard
    threw rather than let one silently overwrite the other. It was right to.
  - **The config filters over-matched in silence.** `exclude: ['users']` took both, and
    `columns: { users: { ... } }` narrowed both.
  - **Foreign keys could not say which schema they pointed into.** A key to `reporting.users` and a
    key to `public.users` both recorded `foreignTable: 'users'`, so anything resolving one back to a
    table object got whichever it happened to see first.

  ### Addressing one schema from a config

  `include`, `exclude` and the `columns` keys now match a schema-qualified name as well as the bare
  one:

  ```ts
  export default defineConfig({
    schema: 'src/db/schema.ts',
    exclude: ['reporting.*'],
    columns: {
      'public.users': { omit: ['passwordHash'] },
    },
    generators: [{ kind: 'zod' }, { kind: 'json-schema', document: true }],
  });
  ```

  - **A bare pattern still matches in every schema.** `exclude: ['users']` written before a
    `reporting` schema existed means "the users tables", and narrowing it to one of them would start
    generating an endpoint the config had already turned off. When a bare pattern really does reach
    two schemas, DRZL now says so and names the qualified spellings. A warning and not an error,
    because it has to keep parsing a config that works, and because the direction `exclude` takes is
    the safe one anyway. It matters most for `columns`, where a column pattern only has to match in
    one of the tables its entry matched: `columns: { users: { pick: ['id', 'email'] } }` narrows both
    tables and the one with no `email` silently keeps only `id`, with no typo for the existing check
    to report.
  - **`public.` is the spelling for the default schema.** Not an arbitrary choice: Drizzle refuses
    `pgSchema('public')` outright, so a plain `pgTable` is the only way to declare a table there and
    an absent schema _is_ `public`. `public.users` therefore names exactly one table, and no analysis
    can ever contradict it by carrying `schema: 'public'`.
  - **`*` works on either side of the dot**, so `reporting.*` is a schema and `*.users` is every
    `users`.

  ### What else follows the schema now
  - `Table.schema` is documented as the fact everything reads, and `qualifiedTableName` is exported
    so one function decides what a qualified name looks like.
  - `ForeignKey.foreignSchema` and `Column.references.schema` are new, so a key states which schema it
    points into. `Relation.from`, `.to` and `.via` are qualified names, and the nested-schema planner
    and the oRPC relation procedures resolve them qualified. On a schema that calls no `pgSchema` a
    qualified name is the bare name, so every one of these is byte for byte what it was.
  - The OpenAPI document gives a schema-qualified table its own path, `/reporting/users`, and its own
    tag. A table in the default schema keeps the bare `/users`. The duplicate-path guard stays: it
    still catches two exports of one table name in one schema, which Drizzle allows.
  - The `.meta()` facts carry `schema` beside `table`, added rather than folded in, so existing
    emitted metadata is unchanged and a consumer can still tell `reporting.users` from `public.users`.

  ### Fixed along the way

  Relations declared with `defineRelations` named their target by its **key in the schema object**
  rather than by its table name, while the other end of the same relation was a table name. Every
  consumer resolves those strings against `Table.name`, so for any export whose name differs from its
  table's, `export const reportingUsers = reporting.table('users', ...)` being the obvious case, the
  relation was dropped in silence and no nested schema or relation procedure was emitted for it. Both
  ends are now read off the table object Drizzle already provides.

  Verified end to end: a project generated from a schema holding `public.users`, `reporting.users` and
  a child in each is compiled with `tsc --strict` under `nodenext`, with a probe that imports both
  `users` schemas through the barrel at once and reads a field only one of them has.

### Patch Changes

- Updated dependencies [a0e49e3]
  - @drzl/analyzer@1.20.0
  - @drzl/validation-core@3.20.0

## 0.6.0

### Minor Changes

- b1405a9: Emit a whole OpenAPI document, not just `components.schemas`. `document: true` on the `json-schema`
  generator writes `openapi.ts` (and/or `openapi.json`) with a path per table, the verbs on each, the
  request and response body per verb, and the component schemas embedded so the file stands alone.

  **The path parameter is the table's real primary key, never an invented `id`.** Every column of it,
  at its real type, so a uuid key is `/sessions/{token}` with `{ type: 'string', format: 'uuid' }` and
  a composite key is `/org_members/{orgId}/{userId}`. A table with no primary key keeps `GET` and
  `POST` on its collection and loses the by-id paths rather than gaining a fictional column. This
  follows `@drzl/generator-trpc`, which reads the key, rather than `@drzl/generator-orpc`, which emits
  `z.object({ id: z.number() })` whatever the key is. The case is stronger in a document than in a
  router: a tRPC client is typechecked against the router it calls, so a wrong `id` is caught at build
  time, while an OpenAPI document is read by code generators in other languages that have nothing to
  check it against.

  `POST` answers `201`, `DELETE` answers `204` with no body (returning the deleted row is not a true
  statement on every dialect DRZL supports: `RETURNING` is Postgres and SQLite, and MySQL has no such
  clause), by-id paths answer `404`, and anything that takes a body or a path parameter answers `400`
  when the schema refuses it, movable to `422` with `document: { validationStatus: 422 }`. `409` is
  emitted where a primary key or unique constraint can collide, with the constraint named in the
  description, because uniqueness is the one thing a per-row schema structurally cannot state.

  `servers` is absent unless supplied, which the specification reads as a single server at `/`; a
  placeholder host would be a fabrication that tooling then follows. `includeRelations: true` adds a
  read-only `GET /users/{id}/posts` where a child has exactly one foreign key to the whole of a
  parent's primary key.

  **Fixes two keywords the `openapi-3.0` target emitted that OpenAPI 3.0 does not have.** A pinned
  value was `const` and base64 bytes were `contentEncoding: 'base64'`; 3.0 has neither, and its Schema
  Object is closed (`additionalProperties: false`, plus `^x-`), so unlike plain JSON Schema where an
  unknown keyword is merely ignored, either one made a whole 3.0 document fail validation. They are
  now `enum: ['gold']` and `format: 'byte'`, which say the same things in that dialect. Both were
  found by running the emitted document through `@seriousme/openapi-schema-validator` against the
  official OpenAPI schemas, and neither was visible from reading the output. Only
  `target: 'openapi-3.0'` output changes; the default `draft-2020-12` and `openapi-3.1` are
  byte-for-byte unchanged.

  The CLI's `json-schema` branch now goes through one shared options builder for both `generate` and
  `watch`, so the two dispatch loops cannot drift on what this generator is given, and a test runs
  both commands over a config that sets every document field to something no default produces and
  compares the bytes.

## 0.5.0

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

## 0.4.2

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

## 0.4.1

### Patch Changes

- 0fde945: A MySQL TEXT column now carries its cap in the emitted JSON Schema, and says what the format cannot
  express.

  The analyzer reports a MySQL `tinytext`, `text`, `mediumtext` or `longtext` column with `maxBytes`,
  the budget the column type itself imposes. The four validation generators encode the string and
  count the bytes. This one ignored the field, so on drizzle-orm 0.4x, where such a column carries no
  declared length either, the emitted schema was `{ "type": "string" }` and a document validated
  against it could still be refused by the database.

  Asked of a real MySQL 8 on utf8mb4 in `STRICT_TRANS_TABLES`, on a `TINYTEXT` column whose budget is
  255 bytes, with the emitted module compiled by ajv:

  ```
                         MySQL     before    after
  255 ascii, 255 bytes   accepts   accepts   accepts
  256 ascii, 256 bytes   REFUSES   accepts   REFUSES
   63 emoji, 252 bytes   accepts   accepts   accepts
   64 emoji, 256 bytes   REFUSES   accepts   accepts
  ```

  **What changes for you.** A string column with a byte budget gains `maxLength` holding that number,
  and a `description` naming the budget. If you were sending values over the cap, the database was
  already refusing the write. `varchar(n)` columns are untouched: that limit really is characters, and
  it already had one.

  **What it still cannot do.** JSON Schema has no byte-length keyword in any draft, and inventing one
  produces a document that either fails to compile in a strict validator or is silently ignored by a
  lax one. `maxLength` counts characters, and UTF-8 spends at least one byte per character, so the cap
  refuses nothing the column accepts and catches every overflow made of one-byte characters. It cannot
  catch a multi-byte string that fits the count and not the budget, which is the last row of the table
  above, so that is what the `description` says.

  Binary columns are unaffected, because they travel as base64 and a character cap taken from a byte
  budget would refuse a legal value.

- Updated dependencies [2dccd51]
- Updated dependencies [194eb72]
- Updated dependencies [bfda92d]
  - @drzl/analyzer@1.16.0

## 0.4.0

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

## 0.3.0

### Minor Changes

- 9254a9c: Emit an OpenAPI `components.schemas` document

  `{ kind: 'json-schema', components: true }` also writes `components.ts`, one object keyed by name
  and ready to spread into an OpenAPI document. Assembling that from per-table modules is the step
  everyone repeats.

  Two details it handles. `$schema` is dropped, because a schema nested under `components.schemas`
  inherits the document's dialect and OpenAPI 3.1 reads a per-schema `$schema` as a dialect switch.
  `$id` is dropped rather than rewritten: setting it to `#/components/schemas/<name>` is the obvious
  first attempt and is invalid, since a draft 2020-12 `$id` may not contain a fragment. The map key
  is the identity.

  Also fixes a bug in the select schema found while testing this: a column with a database default
  was marked optional in every mode, so `id` was optional on a select schema, which describes a row
  that cannot exist. Only insert treats a defaulted column as omissible.

  Off by default.

### Patch Changes

- Updated dependencies [fbc0881]
- Updated dependencies [5578e93]
  - @drzl/analyzer@1.14.0
  - @drzl/validation-core@3.14.0

## 0.2.0

### Minor Changes

- dc13c47: Add a JSON Schema and OpenAPI generator, and fix two analyzer gaps it uncovered on drizzle-orm 0.4x

  `{ kind: 'json-schema' }` emits plain JSON Schema per table, with no runtime dependency at all.
  The other four generators each target one validation library, so the output only helps a
  TypeScript program that installs that library. JSON Schema is what OpenAPI documents, API
  gateways, form builders and validators in other languages already read, and nothing in the
  official Drizzle family emits it.

  `target` picks the dialect: `draft-2020-12` (default), `openapi-3.1`, or `openapi-3.0`. The last
  is genuinely different rather than older, spelling nullable as `nullable: true` and an exclusive
  bound as a boolean beside the bound. Since JSON Schema ignores unknown keywords rather than
  rejecting them, emitting the wrong dialect gives a document that validates and then accepts what
  the constraint exists to reject.

  Running the new generator through the real CLI surfaced two analyzer bugs affecting **every**
  generator on drizzle-orm 0.4x, the version the analyzer depends on:

  - **`.array()` columns came back `unknown`.** 0.4x wraps the column in a `PgArray` whose
    `baseColumn` is the element; v1 leaves the class alone and raises `dimensions`. Only the v1
    signal was read.
  - **`pgEnum` columns came back `unknown`, on both majors.** The class map had no arm for
    `PgEnumColumn` and `describeV1Column` does not read `dataType: 'string enum'` either. The
    emitted schemas were still correct, because every generator reads `enumValues` ahead of
    `tsType`, so this one was a gap in the analysis model rather than a validation hole.

  The array bug did produce schemas that accepted anything, in all five generators, with nothing
  reporting a problem. `verify-packed.sh` pins `drizzle-orm@1.0.0-rc.4`, so the whole verification
  ladder only ever ran on one major; it now runs a stage against 0.4x that fails on any column the
  analyzer cannot name. That stage found the enum gap the first time it ran.

### Patch Changes

- Updated dependencies [78aeca2]
- Updated dependencies [dc13c47]
- Updated dependencies [c29891a]
  - @drzl/analyzer@1.13.0
