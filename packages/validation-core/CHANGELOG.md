# @drzl/validation-core

## 3.16.2

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

## 3.16.1

### Patch Changes

- 55d1c31: `format.engine: 'biome'` formats. It never has before.

  `@biomejs/biome` publishes a `bin` and no module entry point at all, so the engine's
  `import('@biomejs/biome')` rejected with `ERR_MODULE_NOT_FOUND` whether or not the package was
  installed. Every project that configured biome got unformatted output, and after the previous
  release, a warning telling them to run the CLI by hand.

  It now spawns the binary the package actually publishes, found by resolving the package's own
  manifest from the directory being generated into. Both `bin` shapes are handled: a string at 1.5.3
  and below, an object from 1.9.4 on.

  **What changes for you.** If you configured `engine: 'biome'` and installed `@biomejs/biome`, your
  output is now formatted with it. If you configured it and did not install it, the warning now tells
  you to install the package, which is advice that works, rather than pointing you at the CLI.
  `engine: 'auto'` and `engine: 'prettier'` are unaffected.

## 3.16.0

### Minor Changes

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

- b14cbed: A formatter named in `format.engine` that cannot be loaded is now reported, instead of producing
  unformatted files and no message.

  `format: { engine: 'prettier' }` with no prettier installed wrote every generated file exactly as
  rendered and said nothing. The request was explicit, it did not happen, and there was no way to
  tell from the run: unformatted output is still valid TypeScript, so nothing downstream fails
  either. The same held for `format: { engine: 'biome' }`.

  **What changes for you.** When `format.engine` names an engine and that engine cannot be loaded,
  one line goes to stderr per run naming the setting, the package, what to do about it, and the
  underlying error:

  ```
  [drzl] format.engine is "prettier" but prettier could not be used, so the generated files were
  left unformatted. Install prettier, which is an optional peer of @drzl/validation-core, or set
  format.engine to "auto" to accept whatever formatter is present. Reason: Cannot find package
  'prettier' imported from ...
  ```

  It is a warning rather than an error. Generation still completes and the files are still written,
  because the difference is whitespace and failing the run would trade a finished generation for it.
  Once per run rather than once per file, since whether a formatter loads is a fact about the
  environment and a forty-table schema would otherwise repeat it forty times.

  **What does not change.** `format.engine: 'auto'`, the default, still falls back in silence: it
  asked for whatever is installed, so finding nothing is an answer rather than a failure. Prettier is
  still an optional peer that is never bundled, and `format: { enabled: false }` is still silent
  because nothing was requested.

- Updated dependencies [8cc4de8]
- Updated dependencies [f019b03]
  - @drzl/analyzer@1.18.0

## 3.15.1

### Patch Changes

- db2b1d7: A `GENERATED ALWAYS` column no longer appears in an update schema or an update type.

  Every server refuses an UPDATE that names one, with any value at all including NULL. Asked of a real
  Postgres:

  ```
  update children set span = 7        refused, 428C9 column "span" can only be updated to DEFAULT
  update children set span = null     refused, 428C9
  update children set span = default   accepted, and it is the only accepted form
  ```

  `SET col = DEFAULT` is not something a patch object can express and not something Drizzle's `.set()`
  produces, so a payload that validated against the old schema and was then handed to
  `db.update().set()` produced a query the database rejected. `drizzle-orm/zod`'s own
  `createUpdateSchema` omits the column.

  **What changes for you.** A key that the update schema previously accepted is now rejected, and the
  emitted `Update<T>` type no longer carries it. If you were passing a generated column in a patch,
  the database was already refusing that write.

  **What does not change.** `GENERATED BY DEFAULT AS IDENTITY` stays in the update schema, because the
  same servers accept an UPDATE of one and the analyzer reports it as `isGenerated: false`. Defaulted
  columns are unaffected.

  Two places carried the same wrong filter: `updateColumns` in `@drzl/validation-core`, which the five
  validation generators share, and a private copy in `@drzl/generator-service`, which builds its own
  field list and never called it.

## 3.15.0

### Minor Changes

- 44b34b2: Stop shipping prettier inside three packages, and make the CommonJS build format at all

  `@drzl/validation-core`, `@drzl/generator-orpc` and `@drzl/generator-service` each published at
  about 2.8 MB packed and 11 MB unpacked. All three carried a copy of `formatCode` built on
  `await import('prettier')`, which is a specifier tsup resolves statically, so esbuild inlined the
  whole formatter behind it: prettier's Flow parser, its TypeScript parser, babel, postcss, yaml and
  the rest. Installing `@drzl/cli` pulled in roughly 32 MB of duplicated parsers.

  Prettier is now an optional peer dependency, marked external in every build that can reach it.
  The two private copies of `formatCode` are gone; both packages use the one exported by
  `@drzl/validation-core`, which they already depended on. The three packages now publish at 34 KB,
  15 KB and 8 KB packed, and 88 KB, 59 KB and 18 KB unpacked.

  **What changes for you.** DRZL formats with the prettier already in your project, using your
  config, exactly as before. If your project has no prettier and no biome, generated files are
  written as rendered: the same valid TypeScript with worse whitespace, rather than nothing at all.
  Add `prettier` as a dev dependency if you want it formatted.

  Along the way this fixes formatting for CommonJS consumers, where it never worked. The bundled
  prettier in `dist/index.cjs` called `createRequire(import.meta.url)`, and `import.meta.url` is
  undefined in a CJS bundle, so the first call threw, the `catch` swallowed it and the code came
  back unformatted. Every `require('@drzl/validation-core')` consumer carried 5.5 MB of formatter
  that could not run. Resolving the real prettier fixes it.

## 3.14.0

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

- Updated dependencies [fbc0881]
- Updated dependencies [5578e93]
  - @drzl/analyzer@1.14.0

## 3.13.0

### Minor Changes

- c5fcb15: `CHECK (cardinality(col) <op> n)` is now enforced on array columns.

  ```ts
  // check('tags_rule', sql`cardinality(${t.tags}) > 0 AND cardinality(${t.tags}) < 4`)
  tags: z.array(z.string())
    .refine((v) => v.length > 0, { message: 'tags_rule: cardinality(tags) > 0' })
    .refine((v) => v.length < 4, { message: 'tags_rule: cardinality(tags) < 4' }),
  ```

  The array analogue of the `length()` support, and free of the question that one carries: an
  element count is the same number in SQL and in JavaScript, with no encoding involved.
  `array_length(col, 1)` reads the same way, because for a one-dimensional array it is that count.
  `array_length(col, 2)` is refused, since a higher dimension is not an element count.

  This is the one check an array column takes. Every other kind is skipped there, because a
  comparison against a scalar literal says nothing usable about an array; this one is about the
  array itself, so it is applied after the array wrapping rather than to an element.

  Verified against Postgres for `CHECK (cardinality(tags) > 0 AND cardinality(tags) < 4)`: the
  emitted schema and the database agree on all four probes.

## 3.12.0

### Minor Changes

- f98d84a: `CHECK (length(col) <op> n)` is now enforced, counted in characters.

  The one function call the check parser reads, because the mapping is exact:

  ```ts
  // check('name_len', sql`length(${t.name}) >= 3 AND length(${t.name}) <= 8`)
  name: z.string()
    .refine((v) => [...v].length >= 3, { message: 'name_len: length(name) >= 3' })
    .refine((v) => [...v].length <= 8, { message: 'name_len: length(name) <= 8' }),
  ```

  `char_length` is the same function in Postgres and is read too. Counted in code points, for the
  same reason a `varchar(n)` limit is: Postgres counts characters and `.length` counts UTF-16 units.
  Verified against Postgres for `CHECK (length(name) >= 3 AND length(name) <= 8)`, which agrees on
  all eight probes including three, eight and nine emoji.

  `octet_length` is deliberately **not** read: it counts bytes, which depends on the encoding and
  cannot be derived from a JavaScript string without choosing one. Nor is `lower`, which would need
  a locale to be faithful. The rule is unchanged, only its reach: read what maps exactly, refuse the
  rest rather than guess.

  TypeBox and ArkType do not carry these, for the same reason they carry an approximate `varchar(n)`:
  both state constraints declaratively with no predicate to hook. Each generator's docs say so.

  The parity probe pool gained astral characters as well, so a cross-generator disagreement about
  character counting is visible rather than invisible.

## 3.11.0

### Minor Changes

- 387b45b: A `varchar(n)` limit counts characters, not UTF-16 code units.

  Postgres and MySQL count `varchar(n)` in **characters**. Every JavaScript validator counts
  `.length`, which is UTF-16 code units. The two agree until the text leaves the basic plane, and
  then they do not.

  Measured against Postgres through PGlite for a `varchar(10)` column:

  | value               | database    | `.max(10)`  |
  | ------------------- | ----------- | ----------- |
  | 10 plain characters | accepts     | accepts     |
  | 8 emoji             | **accepts** | **refuses** |
  | 10 emoji            | **accepts** | **refuses** |
  | 11 emoji            | refuses     | refuses     |

  So the generated schema was turning away a bio, display name or message the column would have
  stored quite happily. `drizzle-orm/zod` emits `.max(n)` and does the same.

  The zod and valibot generators now count code points, which is what the database counts:

  ```ts
  name: z.string().refine((v) => [...v].length <= 10, { message: 'at most 10 characters' }),
  ```

  TypeBox and ArkType keep the UTF-16 form, and it is not an oversight: both state a length
  declaratively with no predicate to hook, so their output stays approximate for astral text. That
  is documented on each.

  The probe pool behind the ground-truth stage gained astral characters, since it had none and that
  is why the gate never saw this. It remains a class the gate cannot fail on by itself, because DRZL
  and `drizzle-orm` were wrong in exactly the same way and the gate only fires when DRZL is uniquely
  wrong. Finding it needed the pool to contain a value that tells the two counts apart.

## 3.10.0

### Minor Changes

- 98c7cd9: `applyDefaults`: reproduce literal column defaults in the insert schema.

  Drizzle knows what a column defaults to. `drizzle-orm/zod` reproduces none of them, so a parsed
  insert is missing the values the database would have written.

  ```ts
  { kind: 'zod', path: 'src/validators/zod', applyDefaults: true }
  ```

  ```ts
  country: z.string().default("GB"),
  count: z.number().int().default(0),
  ```

  `InserttSchema.parse({ name: 'x' })` returns `{ name: 'x', country: 'GB', count: 0 }`. Verified
  against a real Postgres through PGlite: inserting only the column that has no default leaves the
  database filling in exactly those three values.

  Only **literal** defaults. `defaultNow()`, `defaultRandom()` and any `sql` default are evaluated by
  the database, and `$defaultFn` is called by Drizzle at insert time. Those are told apart by shape
  rather than by name: an SQL default carries `queryChunks`, a function default sets `defaultFn`.
  Both stay `.optional()`, because a schema guessing at either would produce a different value than
  the one actually stored.

  Insert only, and `.default()` replaces `.optional()` rather than stacking with it: `.optional()`
  wrapped around a default short-circuits on an absent key and returns undefined, leaving the default
  unreachable.

  Off by default, because it changes what parsing _returns_ rather than only what it accepts.

### Patch Changes

- Updated dependencies [98c7cd9]
  - @drzl/analyzer@1.11.0

## 3.9.0

### Minor Changes

- 5d6b7a2: Relations v2, declared peer ranges, TypeBox measured against official, and row-level CHECKs.

  ### `defineRelations` produced no relations at all

  Drizzle v1 added a second way to declare relations and the analyzer only knew the first, so a
  schema using `defineRelations` came back with an empty relations array and the oRPC and service
  generators emitted no relation endpoints. Nothing failed; the output was simply missing.
  Confirmed against `@drzl/cli@4.8.0`, which returns `[]` for the schema this now reads.

  The v2 shape is better than v1 for one case in particular: a many-to-many states its join table
  through `through`, where v1 leaves it to a heuristic over tables whose columns are all foreign
  keys. So a join table carrying extra columns is now recognised rather than missed.

  ### Zod 4 output with no declared peer

  The emitted schemas use `z.uuid()` and `z.json()`, both Zod 4 only, and `@drzl/generator-zod`
  declared no peer dependency on zod whatsoever. A Zod 3 project got code that does not compile and
  nothing said why. All three now declare what they emit for: `zod >=4.0.0`, `valibot >=1.0.0`,
  `arktype >=2.0.0`, matching what `@drzl/generator-typebox` already did.

  ### TypeBox is now measured against the official module

  The parity gate could only cross-check the typebox output against DRZL's own generators, and the
  docs said that was unavoidable. It was not: `drizzle-orm/typebox` targets the newer `typebox`
  package and throws on import against the released one, but `drizzle-orm/typebox-legacy` is the
  same module built for `@sinclair/typebox`, which is what this generator emits for.

  Turning it on immediately found a divergence, in DRZL's favour: official emits
  `Type.String({ format: 'uuid' })`, and TypeBox **fails** a format it has no entry for rather than
  ignoring it, so that schema rejects every valid uuid in any project that has not populated
  `FormatRegistry` first. DRZL emits a pattern, which needs no setup.

  ### Row-level CHECK constraints

  `CHECK (start_date < end_date)` was skipped, because neither column alone can say whether it
  holds. It goes on the object schema instead:

  ```ts
  .refine((v) => v['startDate'] == null || v['endDate'] == null || v['startDate'] < v['endDate'],
    { message: 'date_order: startDate < endDate', path: ['startDate'] })
  ```

  Both sides are guarded for null, reproducing SQL, where a comparison involving NULL yields NULL and
  a CHECK passes on NULL. The error is reported against the left column so it has somewhere to land,
  and a constraint naming a column the mode does not carry is left out rather than compared against
  `undefined`.

  Verified against a real Postgres through PGlite: for a table with `CHECK (start_date < end_date)`
  and `CHECK (price <= max_price)`, the emitted schema and the database agree on all five probe rows.

### Patch Changes

- Updated dependencies [5d6b7a2]
  - @drzl/analyzer@1.10.0

## 3.8.0

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

## 3.7.0

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
  - @drzl/analyzer@1.9.0

## 3.6.0

### Minor Changes

- c3b978f: `typedColumns`: take every column's static type from Drizzle, not just the untyped ones.

  `.$type<T>()` is a compile-time cast on **any** column, not just json. Drizzle's implementation is
  literally `$type() { return this }`, so `text().$type<'admin' | 'member'>()` is an ordinary string
  to anything reading the column at runtime, and `drizzle-orm/zod` and DRZL alike emitted a plain
  `z.string()` with the narrowing lost.

  ```ts
  { kind: 'zod', path: 'src/validators/zod', typedColumns: true }
  ```

  ```ts
  role: z.string().max(50).pipe(z.custom<(typeof users.$inferSelect)['role']>()),
  ```

  The runtime schema is untouched. The reference is appended rather than substituted, so a
  `varchar(50)` keeps its length check and only its _type_ narrows, and a typo in
  `if (user.role === 'admni')` becomes a compile error rather than dead code. Nothing narrows it at
  runtime, because the cast leaves no trace there.

  Appending happens after the nullable and optional wrappers, checked against zod rather than
  assumed: `.pipe()` keeps a key optional both when parsing and in the inferred type. A json or
  custom column still has its schema _replaced_ rather than appended to, since it has no runtime
  type worth keeping.

  Implies `typedJson`, since both need the schema imported back. Off by default: it adds a `.pipe()`
  to every field, which is noise unless you use `.$type<T>()`.

## 3.5.0

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
  - @drzl/analyzer@1.8.0

## 3.4.0

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
  - @drzl/analyzer@1.7.0

## 3.3.0

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

## 3.2.0

### Minor Changes

- d2ac66d: Two things no runtime-derived validator can do.

  ### `typedJson`: json columns typed from your schema

  `.$type<T>()` is a compile-time cast. Drizzle implements it as `$type() { return this }`, so
  nothing about the declared type survives to runtime and every runtime-derived validator is blind
  to it. `drizzle-orm/zod` types a json column as its generic `Json` whatever you wrote, and that
  is the highest-reaction open issue on the repository.

  A generator does not have to resolve the type itself, because Drizzle already did:

  ```ts
  prefs: z.custom<(typeof settings.$inferSelect)["prefs"]>(),
  ```

  `typeof settings.$inferSelect['prefs']` _is_ the declared type, resolved by TypeScript at the
  point of use. So generics, unions and imported interfaces all work, which are exactly the cases
  that defeat approaches that parse the source and rebuild the type. Insert and select reference
  their own inference, since a defaulted json column is optional on insert and its type differs.

  Enable per generator:

  ```ts
  { kind: 'zod', path: 'src/validators/zod', typedJson: true }
  ```

  Off by default: it adds an `import type` of your schema module to the generated file. That import
  is erased at build time, so it adds no runtime dependency and cannot create a runtime cycle, but
  the coupling should still be a choice.

  Verified by compiling the result: `z.infer<typeof SelectsettingsSchema>['prefs']` is the declared
  type, a wrong shape is a type error, and it is assignable back to the original interface.

  ### `drzl generate --check`: drift detection for CI

  ```bash
  drzl generate --check
  ```

  Regenerates and fails if the result differs from what is committed, naming every file:

  ```
  Generated output is out of date (2 file(s)):
    ~ changed  src/validators/zod/people.zod.ts
    + added    src/validators/zod/extra.zod.ts
  ```

  Exits 1 on drift and 0 when current. It catches the two things that actually happen, someone
  editing generated files by hand and someone changing the schema without regenerating, and it
  catches them in CI rather than in review.

  This is only available to a code generator. Runtime modules derive their schemas in memory at
  import time, so there is nothing on disk to have drifted and nothing to compare.

  **It never modifies your working tree.** Redirecting output to a temporary directory would not
  work, since generated files contain paths computed relative to their own location and every file
  would report as drifted. So the real directories are snapshotted, regeneration is allowed to
  overwrite them, and the snapshot is restored either way, including deleting anything the run
  created.

## 3.1.0

### Minor Changes

- c90fd42: **Generated Zod schemas now enforce CHECK constraints. No official Drizzle validator does.**

  Verified against `drizzle-orm/zod` at 1.0.0-rc.4: a table declaring
  `check('age_adult', sql`${t.age} >= 18`)` produces an insert schema that accepts `{ age: 5 }`.
  The constraint is right there in the schema, the database will reject the row, and the validator
  says nothing. Same for valibot, arktype and typebox.

  DRZL emits:

  ```ts
  age: z.number().int().gte(-2147483648).lte(2147483647)
    .refine((v) => v >= 18, { message: "age_adult: age >= 18" }),
  ```

  `BETWEEN 0 AND 100` becomes two refinements. The constraint name is in the message, so a failure
  points at the thing in the schema that caused it.

  ### It refuses more than it accepts, on purpose

  Only a comparison naming one column against one literal is translated. A schema that quietly
  enforces a _guess_ at your constraint is worse than one enforcing nothing, because it rejects
  rows the database would have accepted. Skipped, not guessed: comparisons between two columns
  (`start_date < end_date`, a statement about the row rather than a field), compound predicates,
  function calls, and regex matches, whose `~` in Postgres is POSIX ERE and not JavaScript's
  dialect.

  ### Two pieces of SQL semantics that a naive version gets wrong

  **A CHECK passes on TRUE or NULL.** So `CHECK (score >= 0)` on a nullable column accepts NULL.
  The refinement is applied to the inner type and `.nullable()` wraps it, which reproduces that
  exactly rather than being stricter than the database.

  **The bound has to survive.** `sql`${t.age} >= ${MIN}`` used to render as `age >= ?`, because
  `renderSql` mapped an interpolated value to `?`. Drizzle puts a primitive into the chunk list as
  itself rather than wrapping it, so the value was there all along and was being discarded. Any
  refinement built from that expression would have been built from a hole. Fixed in the analyzer,
  which also makes `Table.checks[].expression` correct for anything else reading it.

  Valibot and ArkType keep their current output; the parser lives in `@drzl/validation-core` as
  `parseCheck`, so they can adopt it without reimplementing it.

### Patch Changes

- Updated dependencies [c90fd42]
- Updated dependencies [6d6857f]
- Updated dependencies [6d6857f]
  - @drzl/analyzer@1.6.0

## 3.0.0

### Major Changes

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

### Patch Changes

- Updated dependencies [b0543a4]
  - @drzl/analyzer@1.5.0

## 2.1.0

### Minor Changes

- 9e86204: `validation.importPath`, `dbImportPath` and `schemaImportPath` now produce imports that resolve.
  They were emitted verbatim, so the config in the getting-started guide generated three imports
  that resolved to nothing, under every module resolution.

  These options get written as project-relative paths, `src/validators/zod`, because that is how
  the rest of the config names directories. Emitted verbatim that is a _bare_ specifier: Node and
  tsc look for a package of that name in node_modules and never consider the local file.

      from "src/validators/zod"          before
      from "../validators/zod/index.js"  after

  Each configured path is now classified before use. A package name (`zod`, `@acme/schemas`) is
  left exactly as written. A path already relative keeps its own spelling and only has its
  extension corrected, so anyone who followed the older guidance and wrote
  `../validators/zod/index.js` is unaffected. Anything else is treated as project-relative and
  rewritten against the directory of the file doing the importing.

  Whether a path names a file or a directory is asked of the filesystem, because
  `src/db/connection` and `src/validators/zod` are indistinguishable as strings and are usually a
  file and a directory holding a barrel. A directory gains `/index`. Where nothing exists yet,
  which happens when one generator runs before the one that writes its target, an extensionless
  path is taken to be a directory, since these options name directories by convention and the only
  path that can legitimately be missing is a generated barrel.

  Since a non-relative value could only ever have produced an import that resolved to nothing,
  rewriting it cannot break a setup that worked.

  Exposed by `resolveConfiguredImport` in `@drzl/validation-core`, so all three call sites share
  one rule.

## 2.0.0

### Major Changes

- 6903012: **Breaking:** every relative specifier DRZL generates now ends in `.js`, so the generated
  tree compiles under `moduleResolution: node16` and `nodenext`.

  ### What you will see

  Regenerate and the specifiers gain an extension. Nothing else about the output changes, and
  no file is renamed:

  ```diff
    // src/validators/zod/index.ts
  - export * from './users.zod';
  + export * from './users.zod.js';

    // src/api/index.ts
  - import { users } from './users';
  + import { users } from './users.js';

    // src/services/userService.ts
  - import type { Insertusers, Updateusers, Selectusers } from './types/users';
  + import type { Insertusers, Updateusers, Selectusers } from './types/users.js';
  ```

  If your build already worked, it still works: `./users.zod.js` resolves to `users.zod.ts`
  under `bundler` and `node10` exactly as the extensionless form did, and it is what Vite,
  esbuild, Rollup, Bun, Vitest and Next.js expect. It will show up in your next diff, and it
  is a good idea to regenerate in one commit of its own.

  ### Why

  Generated files land in your own source tree, so your `tsconfig.json` decides which
  specifiers resolve. Measured against tsc 5.9.2 and 7.0.2, for a specifier naming a sibling
  `.ts` file:

  | specifier        | `bundler` | `node10` | `node16`/`nodenext`, CommonJS | `node16`/`nodenext`, ESM |
  | ---------------- | --------- | -------- | ----------------------------- | ------------------------ |
  | `./users.zod.js` | resolves  | resolves | resolves                      | resolves                 |
  | `./users.zod`    | resolves  | resolves | resolves                      | **does not resolve**     |

  The extensionless form DRZL emitted before this release cannot be imported from an ES module
  under `node16` or `nodenext`. `tsc` reports `TS2307: Cannot find module './users.zod'` on the
  barrel and the build stops, and that was true of the default `fileSuffix`, not only of custom
  ones. That combination is now the common one: `tsc --init` has emitted `"module": "nodenext"`
  since TypeScript 5.9, every `@tsconfig/node*` base sets `"moduleResolution": "node16"`, and
  TypeScript 7 removed `node10` altogether, leaving `bundler`, `node16` and `nodenext` as the
  only three settings that exist.

  ### If `.js` is wrong for you

  Set `importExtension`, at the top level for every generator or on a single generator to
  override it:

  ```ts
  export default defineConfig({
    schema: 'src/db/schema.ts',
    importExtension: 'none', // 'js' (default) | 'none' | 'ts'
    generators: [{ kind: 'zod', path: 'src/validators/zod' }],
  });
  ```

  - `'none'` restores the pre-2.0 output byte for byte. Use it if your pipeline cannot map
    `.js` back to `.ts`: webpack without `resolve.extensionAlias`, or Jest with `ts-jest` and
    no `moduleNameMapper`.
  - `'ts'` emits `./users.zod.ts`, which needs `"allowImportingTsExtensions": true`. It is the
    only form Node's own type stripping accepts, so it suits running the generated `.ts`
    unbuilt.

  `importExtension` only touches specifiers DRZL invents. Paths you write yourself are still
  emitted verbatim, so on `node16`/`nodenext` in an ES module an `orpc` generator's
  `validation.importPath` has to name the barrel file rather than its directory
  (`'../validators/zod/index.js'`, not `'../validators/zod'`), and the `service` generator's
  `dbImportPath` and `schemaImportPath` need their own `.js`.

  `@drzl/validation-core` exports `ImportExtension`, `DEFAULT_IMPORT_EXTENSION`,
  `IMPORT_EXTENSIONS` and `importSpecifier`, and `moduleSpecifier` takes the extension as a
  third argument, so the five generators cannot disagree about how a module is spelled.
  `@drzl/generator-service` gains a dependency on `@drzl/validation-core` for that reason.

### Minor Changes

- 2f9214e: Add `affix`, so generated identifiers are not stuck on `Insert<Table>Schema`.

  Resolves #16. Set `affix` on a `zod`, `valibot` or `arktype` generator to choose
  the prefix and suffix of the exported schema constants and of the type aliases,
  separately, and either as one string for all three modes or per mode:

  ```ts
  {
    kind: 'zod',
    path: 'src/validators/zod',
    affix: {
      tableCase: 'pascal',
      schema: { suffix: 'Schema' },
      type: {
        prefix: { insert: 'Create', update: 'Edit', select: '' },
        suffix: { insert: 'Input', update: 'Input', select: '' },
      },
    },
  }
  ```

  which emits `InsertUsersSchema`, `CreateUsersInput`, `EditUsersInput` and a bare
  `Users` instead of `InsertusersSchema` and `SelectusersOutput`.

  `tableCase` addresses the second half of that issue. Generated identifiers
  interpolate the Drizzle export name exactly as written, so a table exported as
  `users` produces `Insertusers`. `tableCase: 'pascal'` upper-camels it first,
  splitting on `_`, `-` and camel boundaries, so `user_profiles` and `userProfiles`
  both give `InsertUserProfilesSchema`. The default is `preserve`, which keeps the
  existing behaviour; changing the default is a major-version decision.

  Naming now comes from one resolver in `@drzl/validation-core`
  (`resolveAffix`, `schemaName`, `typeName`, `validateAffix`, `pascalCase`) instead of
  template literals repeated in four packages, which is what lets both sides of an
  import agree. When an `orpc` generator uses `validation.useShared` and exactly one
  sibling generator produces that library, the sibling's `affix` is copied onto it,
  so the router imports the names the validation generator actually exported.
  A `validation.affix` that is set explicitly and disagrees with that sibling now
  fails the run, listing both sets of names, rather than writing a router that does
  not compile.

  Configs are checked before anything is written: an affix that could not appear in
  a TypeScript identifier, or that would put two same-named exports in one file, is
  rejected with the path to the offending option.

  Nothing changes for existing configs. Omitting `affix` reproduces the previous
  output byte for byte, `schemaSuffix` still works and is the default for
  `affix.schema.suffix`, and affixes rename identifiers only, never files or module
  specifiers.

- 6034a24: Make the generated barrel follow `fileSuffix` instead of the default suffix.

  The zod, valibot and arktype generators named each emitted file from `fileSuffix` but wrote
  the barrel with the default suffix hardcoded, so any custom value produced an `index.ts`
  full of imports that pointed at nothing:

  ```ts
  // drzl.config.ts
  { kind: 'zod', path: 'src/validators/zod', fileSuffix: '.schema.ts' }
  ```

  ```ts
  // src/validators/zod/index.ts, next to users.schema.ts and posts.schema.ts
  export * from './users.zod'; // TS2307: Cannot find module './users.zod'
  export * from './posts.zod';
  ```

  The consumer's build failed on the unresolved imports, and so did anything importing the
  barrel, including an `orpc` generator pointed at it through `validation.importPath`. The
  only `fileSuffix` that worked was the default one. Both halves now come from the same
  value, so the barrel renames along with the files.

  Suffixes that are not simply `.<name>.ts` are handled too. A suffix with no leading dot
  runs straight onto the table name (`Schema.ts` gives `usersSchema.ts` and
  `./usersSchema.js`), a suffix that is only an extension leaves the bare table name (`.ts`
  gives `users.ts` and `./users.js`), and `.mts` and `.cts` are written as `.mjs` and `.cjs`,
  which is the only form TypeScript resolves for them.

  Leaving `fileSuffix` unset no longer reproduces the pre-2.0 barrel byte for byte, but that
  is down to the separate `importExtension` change in this same release, which puts a `.js` on
  every specifier DRZL generates. Set `importExtension: 'none'` and the default output is what
  it always was.

  `@drzl/validation-core` exports the two helpers the generators share, `moduleFileName` and
  `moduleSpecifier`, so the file name and the import specifier cannot drift apart again.

### Patch Changes

- Updated dependencies [549ee51]
  - @drzl/analyzer@1.3.0

## 1.1.0

### Minor Changes

- c48d79a: sponsor initiatives

### Patch Changes

- Updated dependencies [c48d79a]
  - @drzl/analyzer@1.2.0

## 1.0.0

### Major Changes

- 5da6f6b: support MySQL, SingleStore, and Gel; expand Postgres/SQLite; add tests (fixes #13)

### Patch Changes

- Updated dependencies [5da6f6b]
  - @drzl/analyzer@1.0.0

## 0.3.0

### Patch Changes

- @drzl/analyzer@0.3.0

## 0.2.0

### Patch Changes

- @drzl/analyzer@0.2.0

## 0.1.0

### Patch Changes

- @drzl/analyzer@0.1.0

## 0.0.3

### Patch Changes

- @drzl/analyzer@0.0.3

## 0.0.2

### Patch Changes

- @drzl/analyzer@0.0.2

## 0.0.1

### Patch Changes

- @drzl/analyzer@0.0.1
