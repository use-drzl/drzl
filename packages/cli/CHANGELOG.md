# @drzl/cli

## 4.20.0

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

- c3465cc: Generate for a subset of a table's columns, without post-processing the output.

  `include`/`exclude` is all or nothing per table, and the column that should not appear in a
  generated schema is usually sitting in a table you do want: a `passwordHash` on `users`, an internal
  note beside the public fields, a `tenantId` the server sets from the session. The only previous
  answer was to edit the emitted file, which the next `drzl generate` overwrites.

  ```ts
  columns: {
    users: { omit: ['passwordHash'] },
    'app_*': { omit: ['deleted_at'] },
    audit_log: { pick: ['id', 'action', 'created_at'] },
  },
  ```

  The key is a table pattern in the same language `include`/`exclude` already uses, sharing the same
  implementation rather than a second copy of it: the database table name, anchored, with `*` as the
  only metacharacter. Column patterns are that language again. Every matching entry applies in the
  order written, and within one entry `pick` narrows before `omit` removes, so `omit` wins, which is
  the precedence `exclude` already has over `include`.

  Four decisions worth knowing:

  - **It narrows the analysis, once, before any generator is constructed**, at the same seam
    `filterTables` already uses. Not in `@drzl/analyzer`, which reads a schema module and has no
    config: `drzl analyze` has to keep printing what is really there. And not in each generator, of
    which there are nine plus two template packages: the one that forgot would emit a schema silently
    wider than the config asked for. Narrowing the analysis is also what keeps the validators, the
    OpenAPI document, the emitted `.meta()` facts and the service layer describing the same columns,
    since all of them read that one object.

  - **A pattern that matches nothing is an error, not a no-op.** `omit: ['passwrodHash']` treated as a
    no-op leaves the column exactly where it was while reading like a fix, and nothing downstream can
    tell that apart from a column that was never there. A table pattern matching no table and a
    column pattern matching no column both stop the run before anything is written, with every such
    problem in one message. A column pattern has to match in at least one of the tables its entry
    matched, not in all of them, which is what makes a wildcard table key usable.

  - **Omitting a primary key column is refused.** The generated `getById`, `update` and `delete`
    address rows by that key and every generator reads it differently, so the consequence would
    depend on which generators happened to be configured: the tRPC generator resolves the key against
    the columns and silently drops those three procedures, the oRPC generator never reads the key and
    keeps emitting them typed `{ id: number }`, the service generator falls back to a column literally
    named `id` and emits `eq(users.id, id)`, and the OpenAPI document drops its `/{id}` paths. One
    config, four outcomes, none announced. Refusing is also the reversible direction: an error can be
    relaxed to a warning later without breaking a config that works.

  - **Omitting a NOT NULL column with no default is a warning, and generates.** It really does produce
    an insert schema that cannot describe a whole row, and it is also the normal multi-tenant shape: an
    insert schema describes a request body, not a row, and the server fills in the rest. The warning
    says who has to supply the column. A CHECK naming an omitted column warns too, since nothing DRZL
    emits can enforce it any more, though the database still does.

  There is deliberately no per-mode form: a column cannot be kept in `select` and dropped from
  `insert`. The service generator's `Update<Table>` is `Partial<Omit<typeof users.$inferInsert, 'id'>>`
  taken from Drizzle's own types rather than from the analysis, so a per-mode narrowing would be
  invisible in half the generated tree.

  The narrowing covers more than the column list, because a table names its columns again in
  `primaryKey`, `unique`, `indexes`, `foreignKeys` and `checks`. `unique` reaches emitted TypeScript
  verbatim through `findDuplicate<Table>`, so a stale name there is a generated file that does not
  compile; `unique`, `indexes` and `foreignKeys` are narrowed with the columns. `checks` deliberately
  is not: the generators already skip a row check naming a column the mode does not carry, and leaving
  it lets `meta` keep listing the constraint as unenforced, which is the true answer.

  Measured, because a schema that stops describing a column and a schema that stops carrying its value
  are different claims. Pushing a row that still holds the omitted column through the emitted select,
  insert and update schemas: zod 4.4.3, valibot 1.4.2 and Effect 3.22.1 strip the key; TypeBox 0.34.52
  strips it under `Value.Parse` and `Value.Clean` while `Value.Check` alone still returns `true`;
  arktype 2.2.3 leaves it in place; and the JSON Schema output emits `additionalProperties: false`, so
  a validator rejects the payload instead of trimming it. Those are the validators' own policies about
  undeclared keys, not something DRZL sets.

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

- 7a46b64: Emitted zod schemas can now carry the facts they cannot state about themselves.

  `{ kind: 'zod', path: 'src/validators/zod', meta: true }` attaches zod's own `.meta()` to every
  field and every table schema: the declared SQL type, the primary key, the unique constraints, the
  dialect, whether the database generates or defaults the value, the declared width, and the CHECK
  constraints, including the ones DRZL does not enforce.

  ```ts
  bio: z.string().nullable().meta({ sqlType: 'text' }),
  ```

  ```ts
  SelectusersSchema.shape.bio.meta(); // { sqlType: 'text' }
  SelectusersSchema.meta().primaryKey; // ['id']
  ```

  `z.toJSONSchema` copies the keys through, so the same option is what gets a declared width into an
  OpenAPI document: DRZL enforces `varchar(254)` as a `.refine()`, and `toJSONSchema` drops every
  refinement **in silence**, so without this the document says the column is an unbounded string and
  nothing in it says otherwise. `maxLength` is the JSON Schema keyword, so a validator acts on it.

  Off by default. On a ten-column table it costs about 48 bytes per field and 156 per schema, and
  roughly doubles the emitted module; generated code ships in your bundle.

  **Where it attaches is the whole design problem, and it is measured rather than reasoned about.**
  `.meta()` returns a clone carrying the entry, so an operation that clones keeps it and one that
  wraps does not. On zod 4.4.3, `.refine()`, `.min()`, `.describe()` and `.brand()` all preserve it,
  while `.nullable()`, `.optional()`, `.default()`, `z.array()` and `.pipe()` each build a new schema
  whose own `.meta()` answers `undefined`, reachable only at `.def.innerType`. DRZL wraps every
  nullable column, every array, every optional-on-insert column and every field of an update schema,
  so attaching to the base type would lose the metadata for most of the output. It is therefore
  attached last, after every wrapper, which is also the position `z.toJSONSchema` reads as the
  property's own keywords rather than as one arm of its `anyOf`.

  Every key had to say something the schema does not already say. `nullable` is deliberately absent
  for that reason: `.nullable()` is in the chain and `anyOf: [..., { "type": "null" }]` is in the
  JSON Schema, so it would be a second copy of an answer the consumer already has. `hasDefault` is
  present because a defaulted column and a nullable one are both `.optional()` on insert and the
  wrapper cannot tell them apart. `unenforcedChecks` is present because nothing else in the emitted
  module mentions a CHECK that DRZL declined; `drzl doctor` was the only place it appeared.

  `{ meta: { description: true } }` additionally writes a `description`, which `toJSONSchema` maps to
  the JSON Schema keyword of that name and which is the only key here any OpenAPI viewer renders
  without being taught. It is separate because it is prose repeating the machine-readable keys beside
  it, and prose is the most expensive thing in the output.

  **There are no column comments to carry, and this was measured before the feature was scoped.**
  `drizzle-orm` exposes none at all on either major: no comment-ish own key or prototype method on a
  built column, and `pg.text('a', { comment: 'hello' })` is refused by TypeScript as an excess
  property and, when passed through a variable, dropped at runtime with the string unreachable from
  the built column by any path. Every key above is therefore a fact the analyzer derived, never text
  the user wrote. The zod generator's documentation states this outright, because expecting it to
  work is reasonable.

  zod only, deliberately. The other four validation generators are not passed the option rather than
  being passed it and ignoring it: each has a metadata facility of its own, and where the metadata
  has to attach is exactly what had to be measured here. TypeBox is the obvious next one, because a
  TypeBox schema is a JSON Schema and there is no placement question at all. The `json-schema`
  generator does not read this either: it builds from the same analysis rather than from a zod schema,
  so there is nothing to read.

  `@drzl/analyzer` gains `Column.sqlType`, the column's type as the database declares it, from
  Drizzle's own `getSQLType()`: `varchar(255)`, `numeric(10, 2)`, `timestamp with time zone`,
  `text[]`, or an enum's type name. `dbType` could not answer this and was never meant to; it is a
  label with exactly one consumer, `isIntegerColumn`, and it calls `varchar`, `char` and `text` all
  `TEXT`. The two Drizzle majors disagree about an array and are reconciled: 0.4x wraps the column in
  a `PgArray` whose own answer is already `text[]`, while v1 leaves the class alone and raises
  `dimensions`, so the suffix is added from `arrayDimensions` when the type does not carry one. The
  field is absent, never guessed, where a builder cannot answer.

### Patch Changes

- Updated dependencies [4efd19b]
- Updated dependencies [f110f7b]
- Updated dependencies [7a46b64]
  - @drzl/validation-core@3.19.0
  - @drzl/generator-zod@3.19.0
  - @drzl/generator-valibot@3.18.0
  - @drzl/generator-arktype@3.15.0
  - @drzl/generator-typebox@0.12.0
  - @drzl/analyzer@1.19.0

## 4.19.0

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

## 4.18.0

### Minor Changes

- 9ca760c: `drzl doctor`: a human-readable report of what DRZL **cannot** type or enforce in your schema, and
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

### Patch Changes

- Updated dependencies [9ca760c]
  - @drzl/analyzer@1.18.0

## 4.17.0

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

## 4.16.0

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
  - @drzl/generator-zod@3.18.0
  - @drzl/generator-valibot@3.17.0
  - @drzl/generator-arktype@3.14.0
  - @drzl/generator-typebox@0.11.0

## 4.15.0

### Minor Changes

- 91ca283: A tRPC generator, `@drzl/generator-trpc`, and the CLI wiring for it.

  `drzl generate` takes a `{ kind: 'trpc' }` generator, `drzl generate:trpc <schema>` runs it without
  a config, and `drzl watch --pipeline generate-trpc` rebuilds only it. The package is an **optional**
  dependency of `@drzl/cli`, like the json-schema generator: a package that has never been published
  cannot publish through npm's trusted-publisher flow, so its first version goes out by hand, and
  naming it as a hard dependency in the same release would break `npm i @drzl/cli` until it exists.

  **Targets tRPC v11**, determined from the registry rather than from memory: `latest` is 11.x, majors
  1 through 11 are published and there is no 12, and `next` points behind `latest`, so there is not
  even a pre-release train to aim at. Every construct emitted was run against a real 11.18.0 install.

  Three kinds of file per run. `trpc.ts` holds the single `initTRPC` instance the whole tree shares,
  which has no counterpart in the oRPC output and is not optional: tRPC's builder carries the context
  type with it, so a router built from its own `initTRPC.create()` cannot share middleware and cannot
  be soundly merged. `<table>.ts` is one router per table. `index.ts` builds `appRouter` with
  `router()` and exports `type AppRouter`, which is the entire client contract.

  Per table: `list` and `byId` as queries, `create`, `update` and `delete` as mutations, each with an
  `.output(...)` schema, plus one `listBy<Column>` query per single-column foreign key under
  `includeRelations`. Reads are queries and writes are mutations because a tRPC client caches and
  batches queries over `GET` and never puts a mutation there.

  **The primary key is read off the schema.** A `varchar` key called `isbn` produces
  `byId({ isbn: string })`. A composite key produces `byId({ orgId, userId })`. A table with **no**
  primary key gets `list` and `create` only, rather than a fabricated `id`. A read-only relation gets
  `list` and `byId` only, and no insert or update schema is imported for it. The emitted tree is
  compiled by `tsc` under `strict` and `moduleResolution: nodenext` for every one of those shapes and
  for all three validators, and stood up as a real HTTP server and driven with real requests, in this
  package's own test suite.

  TypeBox cannot be used with this generator, and that is measured rather than assumed: tRPC v11
  recognises a validator through Standard Schema, and `@sinclair/typebox` 0.34 puts no `~standard` key
  on what `Type.Object()` returns. `validation.library` accepts zod, valibot and arktype, all three of
  which were run through a real router.

  ***

  Three CLI wiring defects, all of the same species, found by generating output and reading it rather
  than by reading the wiring:

  - **`databaseInjection` was documented and unreachable.** It has been on the oRPC generator's
    documented options since it was added, and `GeneratorSchema` had no such key. That schema is not
    strict, so zod stripped it in silence and the option did nothing at all when set from a config
    file. It is in the schema now, and passed by both router branches.
  - **`watch` never passed `servicesDir`.** `generate` computes it from the `service` generator's
    `path` and passes it; `watch`'s oRPC branch did not, so a rebuild emitted a service import
    pointing at the default directory whatever the config said. The first save after starting
    `drzl watch` silently replaced a correct import with a wrong one.
  - **`databaseInjection` reached only one of the two generators that have to agree about it.** A
    router in injection mode emits `Service.getById(ctx.db, id)`, and only a service generated in the
    same mode has a `db` parameter to receive it. It is declared once on the router generator and
    pushed onto the `service` generator by `resolveConfig`, the same mechanism that already pulls
    `validation.affix` the other way. `@drzl/generator-service` honours the flag only while emitting
    real Drizzle queries, so pairing it with `dataAccess: 'stub'` now warns instead of emitting calls
    that cannot compile.

  The tRPC branches of `generate` and `watch` build their options through one shared function, and
  `packages/cli/test/trpc-branch-parity.spec.ts` runs both commands over a config that sets every
  option and compares the bytes, because reading the two branches is what missed all three above.

## 4.14.4

### Patch Changes

- 55d1c31: A generator that fails is reported as what went wrong, not as a missing package.

  Every generator branch in the CLI except oRPC's wrapped `generate()` in a catch of one shape, so any
  error at all came back as, for example, `Zod generator missing. Install with: npm install
@drzl/generator-zod`. The real reason was demoted to a trailing detail line, and the headline named a
  package you already had installed. Ten places.

  A module that cannot be resolved and a module that threw while running are now told apart, so a
  genuinely absent optional generator still gets the install hint it is for, and a generator that
  failed reports its own error.

- Updated dependencies [55d1c31]
  - @drzl/validation-core@3.16.1

## 4.14.3

### Patch Changes

- Updated dependencies [734defc]
- Updated dependencies [b14cbed]
- Updated dependencies [8cc4de8]
- Updated dependencies [f019b03]
  - @drzl/generator-arktype@3.13.0
  - @drzl/validation-core@3.16.0
  - @drzl/analyzer@1.18.0
  - @drzl/generator-zod@3.17.0
  - @drzl/generator-valibot@3.16.0
  - @drzl/generator-typebox@0.10.0
  - @drzl/generator-service@2.4.0
  - @drzl/generator-orpc@2.8.0

## 4.14.2

### Patch Changes

- abd7b0c: `drzl --version` and `drzl -V` report the version you actually installed.

  Both printed `0.0.1` on every release the CLI has ever had. The registry lists 29 versions of
  `@drzl/cli` and 28 of them were wrong, so every version number in every bug report filed against
  this CLI has been `0.0.1` and none of them identified anything.

  **Where it came from.** `program.version('0.0.1')` in `src/cli.ts`, a literal written when the CLI
  was scaffolded. It was accurate for the first publish and for nothing after it. There was no
  manifest lookup to go wrong and no bundling involved: the number was simply typed into the source
  and left there while `package.json` moved on to `4.14.1`.

  **What it does now.** The version comes from the `version` field of the package's own
  `package.json`, read at startup from beside the running build. That file is the one the registry
  took the version from, so the two cannot disagree, including for anyone running a build from a
  branch or a tarball.

  Nothing falls back. If the manifest is missing, belongs to another package, or has no `version`,
  the CLI throws and names the path it looked at, because a placeholder standing in for a failed
  lookup is exactly what made this defect survive 28 releases.

  **Verified from an installed tarball**, not from the source tree: `pnpm pack`, `npm install` of the
  resulting `.tgz` into an empty directory, then the installed `drzl` binary, which prints `4.14.1`
  for `--version` and for `-V`. The published `@drzl/cli@4.14.1` prints `0.0.1` for both.

  The bin test in `packages/cli/test/every-entry-loads.spec.ts` ran the built binary throughout and
  asserted only that it printed something, which `0.0.1` did. It now asserts equality with the
  manifest, for `--version` and `-V`, from the ESM and CommonJS builds alike.

  One build change comes with this. `src/version.ts` locates the manifest through `import.meta.url`,
  which esbuild rewrites to `undefined` in a CommonJS output while warning `empty-import-meta`. The
  new `packages/cli/tsup.config.ts` gives the CommonJS build a real value for it, derived from
  `__filename`, rather than silencing the warning: that is the same shape as the
  `createRequire(import.meta.url)` defect in `@drzl/validation-core`, and leaving it silenced would
  have left the next unguarded use in this package resolving to `undefined` with nothing printed to
  say so. The banner repeats `"use strict"` so that the CommonJS bundles stay in strict mode.

## 4.14.1

### Patch Changes

- Updated dependencies [6fbdb22]
  - @drzl/analyzer@1.15.0
  - @drzl/generator-zod@3.16.0
  - @drzl/generator-valibot@3.15.0
  - @drzl/generator-arktype@3.12.0
  - @drzl/generator-typebox@0.9.0
  - @drzl/generator-orpc@2.7.0
  - @drzl/generator-service@2.3.0

## 4.14.0

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
  - @drzl/generator-zod@3.15.0
  - @drzl/generator-valibot@3.14.0
  - @drzl/generator-arktype@3.10.0
  - @drzl/generator-typebox@0.8.0

## 4.13.1

### Patch Changes

- 98592df: Make `@drzl/generator-json-schema` an optional dependency, so the CLI installs again

  `@drzl/cli@4.13.0` shipped with a hard dependency on `@drzl/generator-json-schema@^0.2.0`, and
  that package failed to publish in the same release, so `npm install @drzl/cli` failed outright
  with a 404 for everyone.

  The publish failed because npm's trusted publishing has nothing to authenticate against for a
  package name that has never existed: `E404 PUT /@drzl%2fgenerator-json-schema`. The account
  disallows tokens, so the first version of any new package has to be published interactively before
  CI can take it over. That is a one-time step and it had not been done.

  An optional dependency that cannot be resolved is skipped rather than failing the install, so the
  CLI installs and works as it did before, and the JSON Schema generator is picked up automatically
  once it is on the registry. It is also the more honest declaration: the CLI imports every
  generator dynamically and already reports a missing one with an install hint.

## 4.13.0

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

- c29891a: Warn when a column gets a validator that accepts anything

  `tsType: 'unknown'` is the exact shape two real bugs took: `.array()` and `pgEnum` columns came
  back untyped on drizzle-orm 0.4x, every generator emitted a validator accepting any value, and
  nothing anywhere said so. The only way to find out was to read the generated file.

  `verify-packed.sh` now fails on it, which protects this repository and does nothing for a user
  whose schema uses a column type DRZL has not modelled. That is the case where it matters most,
  because their validators are silently open and nobody has told them.

  The analyzer now reports `DRZL_ANL_UNKNOWN_COLUMN` per column, and the CLI prints a summary after
  analysis, naming the column and its SQL type. It stays a warning: the rest of the schema still
  generates and the generated code is still useful.

  The condition is "the emitted validator will be wide", not "the type is unknown". A `json` column
  is also untyped and is not wide, since the generators emit the JSON value space for it. A
  `customType` is wide, and gets a hint pointing at `.$type<T>()` with `typedColumns`, which is the
  documented fix.

### Patch Changes

- Updated dependencies [19dfa3b]
- Updated dependencies [78aeca2]
- Updated dependencies [43c32de]
- Updated dependencies [03f7810]
- Updated dependencies [dc13c47]
- Updated dependencies [3e15ea8]
- Updated dependencies [b274391]
- Updated dependencies [698e7b3]
- Updated dependencies [c29891a]
  - @drzl/generator-arktype@3.9.0
  - @drzl/generator-typebox@0.7.0
  - @drzl/analyzer@1.13.0
  - @drzl/generator-zod@3.14.1
  - @drzl/generator-valibot@3.13.0
  - @drzl/generator-json-schema@0.2.0

## 4.12.0

### Minor Changes

- 96a36d8: `typedColumns` for the valibot generator.

  It shipped for zod and TypeBox. Valibot had no schema-import machinery at all, so this adds it
  along with the narrowing itself.

  ```ts
  role: v.pipe(v.string(), v.transform((x) => x as (typeof users.$inferSelect)['role'])),
  ```

  Valibot has no equivalent of TypeBox's `Type.Unsafe`, so the reference is appended as an identity
  transform: the value passes through unchanged and only `InferOutput` sees the narrower type. Every
  action the schema carried still runs, which the tests assert by parsing values through it rather
  than by reading the emitted text, and the transform is appended after the nullable and optional
  wrappers so neither is disturbed.

  Verified end to end through the CLI: a `text().$type<'admin' | 'member'>()` column produces output
  where assigning `'nope'` is a compile error and `'admin'` is not.

  That leaves ArkType as the one generator without it, and it is not an oversight: it emits one
  string per field, and a TypeScript type reference has nowhere to live inside a string DSL.

### Patch Changes

- Updated dependencies [96a36d8]
  - @drzl/generator-valibot@3.12.0

## 4.11.0

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

### Patch Changes

- Updated dependencies [c99ac3d]
  - @drzl/generator-arktype@3.8.0
  - @drzl/generator-valibot@3.8.0
  - @drzl/generator-typebox@0.6.0
  - @drzl/generator-zod@3.10.0

## 4.10.0

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
  - @drzl/validation-core@3.10.0
  - @drzl/generator-zod@3.9.0
  - @drzl/analyzer@1.11.0

## 4.9.0

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
  - @drzl/generator-arktype@3.7.0
  - @drzl/generator-valibot@3.7.0
  - @drzl/validation-core@3.9.0
  - @drzl/generator-zod@3.8.0
  - @drzl/analyzer@1.10.0

## 4.8.0

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
  - @drzl/generator-arktype@3.6.0
  - @drzl/generator-valibot@3.6.0
  - @drzl/generator-typebox@0.5.0
  - @drzl/validation-core@3.8.0
  - @drzl/generator-zod@3.7.0

## 4.7.0

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
  - @drzl/generator-arktype@3.5.0
  - @drzl/generator-valibot@3.5.0
  - @drzl/generator-typebox@0.4.0
  - @drzl/validation-core@3.7.0
  - @drzl/generator-zod@3.6.0
  - @drzl/analyzer@1.9.0

## 4.6.0

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

### Patch Changes

- Updated dependencies [c3b978f]
  - @drzl/validation-core@3.6.0
  - @drzl/generator-zod@3.5.0

## 4.5.0

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
  - @drzl/generator-arktype@3.4.0
  - @drzl/generator-valibot@3.4.0
  - @drzl/generator-typebox@0.3.0
  - @drzl/generator-orpc@2.5.0
  - @drzl/validation-core@3.5.0
  - @drzl/generator-zod@3.4.0
  - @drzl/analyzer@1.8.0

## 4.4.0

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
  - @drzl/generator-arktype@3.3.0
  - @drzl/generator-valibot@3.3.0
  - @drzl/generator-typebox@0.2.0
  - @drzl/validation-core@3.4.0
  - @drzl/generator-zod@3.3.0
  - @drzl/analyzer@1.7.0

## 4.3.0

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
  - @drzl/generator-typebox@0.1.0
  - @drzl/validation-core@3.3.0

## 4.2.0

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

### Patch Changes

- Updated dependencies [d2ac66d]
  - @drzl/generator-zod@3.2.0
  - @drzl/validation-core@3.2.0

## 4.1.0

### Minor Changes

- 6d6857f: **The analyzer no longer reports an unknown dialect as SQLite.** It did, with no diagnostic at
  all. Unrecognised columns returned `dbType: 'UNKNOWN'`, the `/At$/` heuristic then rewrote
  `createdAt` to `INTEGER`, and that fabricated INTEGER satisfied a "does anything look like a
  SQLite storage class" fallback. Verified before the fix:

      { "dialect": "sqlite", "issues": 0, "cols": ["id=UNKNOWN", "createdAt=INTEGER"] }

  Detection is keyed off `Symbol.for('drizzle:entityKind')` now, the static Drizzle stamps on every
  column class and uses internally for this. `constructor.name` remains only as a fallback, because
  it does not survive minification: a bundled schema presents its columns as `a`, `b`, `c`.

  `mssql` and `cockroach` are recognised, both added in Drizzle v1. Where nothing matches the
  result is `unknown` plus a `DRZL_ANL_DIALECT` warning, rather than a confident wrong answer.

  **Tables can now be filtered**, with top-level `include` and `exclude`:

  ```ts
  export default defineConfig({
    schema: 'src/db/schema.ts',
    exclude: ['session', 'account', 'verification', '__drizzle_*'],
    generators: [{ kind: 'orpc' }],
  });
  ```

  There was no way to say this, and every generator loops over every table it finds, so DRZL
  emitted unauthenticated CRUD over whatever shared the schema file. For a migrations table that is
  noise. For an auth table it is a leak: Better Auth puts `user`, `session`, `account` and
  `verification` alongside your own, and `account` holds `accessToken`, `refreshToken`, `idToken`
  and `password`.

  Matching is anchored, on the database table name, with `*` as the only metacharacter, so
  `exclude: ['user']` does not also drop `users`. `exclude` wins over `include`.

  Deliberately explicit rather than detecting any particular library. Better Auth's model names are
  all overridable, so a built-in list would miss a renamed table and, worse, silently skip an
  ordinary table called `user`, which is usually the application's own primary entity.

### Patch Changes

- Updated dependencies [c90fd42]
- Updated dependencies [6d6857f]
- Updated dependencies [6d6857f]
  - @drzl/validation-core@3.1.0
  - @drzl/generator-zod@3.1.0
  - @drzl/analyzer@1.6.0
  - @drzl/generator-valibot@3.1.0
  - @drzl/generator-arktype@3.1.0
  - @drzl/generator-orpc@2.4.1

## 4.0.0

### Major Changes

- 4021e52: Dependencies updated to their latest stable releases.

  **Breaking for `@drzl/cli`: Node 22 or newer is now required.** It declared `>=18.17.0`, which had
  become untrue: chalk 6 requires `>=22` and chokidar 5 requires `>=20.19`, so installing on Node 18
  produced a package whose own dependencies could not run. The other packages keep the lower floor,
  since none of them pull those in and raising it would exclude consumers for no reason.

  Runtime dependencies: chokidar 4 to 5 (now ESM only), chalk 5 to 6, ora 8 to 9, commander 14 to
  15, zod 4.1 to 4.4, jiti 2.5 to 2.7.

  Tooling: vitest 3 to 4, eslint 9 to 10, typescript-eslint 8.42 to 8.65, tsup, prettier,
  @changesets/cli, @types/node, sharp. GitHub Actions bumped to checkout v7, setup-node v7,
  configure-pages v6, deploy-pages v5, upload-pages-artifact v5.

  ESLint 10 no longer supports `/* eslint-env */`, and it surfaced a `.eslintrc.cjs` and
  `.eslintignore` that had been dead since the flat config was added: ESLint was reading
  `eslint.config.js` and linting the stale `.eslintrc.cjs` as an ordinary source file. Both are
  removed, `--ext .ts` is dropped from the lint script since flat config does not accept it, and the
  flat config is renamed to `eslint.config.mjs` so Node stops reparsing it.

  **TypeScript stays on 5.9.** 7.0 is the current `latest`, but it is the native rewrite: it exposes
  no `main`, publishes its API under `./unstable/*` subpaths, and `ts.ModuleKind` is simply absent,
  so the compiler-API assertions in this repo do not resolve. 6.0 fails too, in tsup's `--dts` step,
  which errors on a deprecated `baseUrl` it sets itself and cannot resolve Node's types. Neither is
  a defect in this repo and neither is fixable here, so the bump waits for tsup to support them.

### Patch Changes

- Updated dependencies [4021e52]
  - @drzl/analyzer@1.5.2

## 3.0.0

### Major Changes

- 114b91d: **`drzl watch` never regenerated.** It has been inert since the chokidar v4 upgrade: it did one
  build on startup and then sat there, no matter how many times the schema was saved.

  Chokidar removed glob support in v4 (September 2024). The watcher was handed
  `<schema dir>/**/*.{ts,tsx,js}` and, in v4, that is a literal path, so it watched a directory
  called `**` which does not exist. No event ever fired. The startup build is what made this look
  like it worked: run `drzl watch`, see files appear, assume the watcher is live.

  Watch targets are the schema's directory now, which chokidar recurses into by itself, and the
  extension filtering the glob used to do happens on the event instead, so an unrelated file next
  to the schema does not trigger a rebuild.

  Marked breaking because a project relying on `watch` has been silently running against stale
  output, and the command now genuinely reruns.

  ### Also, in the analyzer

  Analyzing the same path twice returned the first parse. The schema is loaded through jiti, which
  delegates to `require` and keeps a process-global module cache, so re-analysis in a long-lived
  process never saw the file as it now is. Constructing a fresh analyzer per run did not help; the
  cache is not the instance's. It passes `moduleCache: false` now.

  This has no effect on a one-shot `generate`, which analyzes once and exits. It matters for
  `watch`, and it would have made the fix above produce confidently stale output rather than no
  output at all, which is worse.

### Patch Changes

- Updated dependencies [ebf3da7]
- Updated dependencies [114b91d]
  - @drzl/generator-orpc@2.4.0
  - @drzl/analyzer@1.5.1

## 2.0.2

### Patch Changes

- Updated dependencies [b0543a4]
  - @drzl/validation-core@3.0.0
  - @drzl/generator-zod@3.0.0
  - @drzl/generator-valibot@3.0.0
  - @drzl/generator-arktype@3.0.0
  - @drzl/analyzer@1.5.0
  - @drzl/generator-orpc@2.3.2
  - @drzl/generator-service@2.1.2

## 2.0.1

### Patch Changes

- 839cd23: Generated oRPC routers now compile. They did not, with any built-in template, for as long as the
  package has existed.

  `create` and `update` declared `.output(SelectSchema)` and then returned the input. The input is
  the _insert_ shape, where generated and defaulted columns are optional, while select requires
  them, so `tsc --strict` rejected every generated router: three errors on a two-table schema. It
  went unnoticed because nothing ever compiled the output.

  Returning the input was not merely mistyped, it was the wrong answer. A created row carries
  generated columns the input never had, so no cast would have made it correct. Both stubs now
  throw a `Not implemented` error naming the table and what to do. That satisfies the declared
  contract, since a body which only throws has type `never`, and an unimplemented endpoint now
  fails loudly instead of silently returning a malformed object.

  `list`, `get` and `delete` are unchanged: `[]`, `null` and `true` are each a truthful value of
  the declared output type. `@drzl/template-orpc-service` is also unchanged, because it delegates
  to a service layer and already returns the select shape; the fix belongs in the stub templates,
  not in the generator, which must never rewrite a real implementation.

  **If you have generated routers and filled in the handlers, nothing changes.** If you were
  relying on the stub bodies, `create` and `update` now throw rather than echoing the input back.

  Also fixes `@drzl/cli` never passing `servicesDir` to the oRPC generator. The option is declared
  on the generator and read by `@drzl/template-orpc-service`, which fell back to `src/services`
  whatever the service generator was configured to use. Pairing that template with, say,
  `{ kind: 'service', path: './src/api/services' }` emitted a router importing a module that was
  never created. The CLI now passes the service generator's actual path.

- Updated dependencies [839cd23]
  - @drzl/generator-orpc@2.2.0

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

- 549ee51: Type `numeric` and `decimal` columns as strings, matching what Drizzle returns.

  Generated validators previously typed them as numbers, so a select schema
  rejected every row the database returned ("expected number, received string"),
  and an insert schema rejected the string the driver wants while accepting a
  number it does not.

  `bigint({ mode: 'number' })` is now read as a number rather than a bigint, and
  `real`/`doublePrecision` are separated from `numeric` since those really are
  JS numbers.

  If you were working around the old behaviour by coercing numeric values, that
  workaround should be removed.

### Patch Changes

- Updated dependencies [2f9214e]
- Updated dependencies [6034a24]
- Updated dependencies [6903012]
- Updated dependencies [549ee51]
- Updated dependencies [20a5b9d]
  - @drzl/validation-core@2.0.0
  - @drzl/generator-zod@2.0.0
  - @drzl/generator-valibot@2.0.0
  - @drzl/generator-arktype@2.0.0
  - @drzl/generator-orpc@2.0.0
  - @drzl/generator-service@2.0.0
  - @drzl/analyzer@1.3.0

## 1.1.0

### Minor Changes

- c48d79a: sponsor initiatives

### Patch Changes

- Updated dependencies [c48d79a]
  - @drzl/generator-arktype@1.2.0
  - @drzl/generator-service@1.1.0
  - @drzl/generator-valibot@1.1.0
  - @drzl/generator-orpc@1.1.0
  - @drzl/generator-zod@1.1.0
  - @drzl/analyzer@1.2.0

## 1.0.0

### Major Changes

- 5da6f6b: support MySQL, SingleStore, and Gel; expand Postgres/SQLite; add tests (fixes #13)

### Patch Changes

- Updated dependencies [5da6f6b]
  - @drzl/analyzer@1.0.0
  - @drzl/generator-arktype@1.0.0
  - @drzl/generator-orpc@1.0.0
  - @drzl/generator-service@1.0.0
  - @drzl/generator-valibot@1.0.0
  - @drzl/generator-zod@1.0.0

## 0.3.1

### Patch Changes

- Updated dependencies [811dd61]
  - @drzl/generator-service@0.4.0
  - @drzl/generator-orpc@0.4.0

## 0.3.0

### Minor Changes

- b2b8e35: fix(cli-config): improve watch and config loading

### Patch Changes

- @drzl/analyzer@0.3.0
- @drzl/generator-arktype@0.3.0
- @drzl/generator-orpc@0.3.0
- @drzl/generator-service@0.3.0
- @drzl/generator-valibot@0.3.0
- @drzl/generator-zod@0.3.0

## 0.2.0

### Minor Changes

- f007329: fix(cli): correct config types and update readme

### Patch Changes

- @drzl/analyzer@0.2.0
- @drzl/generator-arktype@0.2.0
- @drzl/generator-orpc@0.2.0
- @drzl/generator-service@0.2.0
- @drzl/generator-valibot@0.2.0
- @drzl/generator-zod@0.2.0

## 0.1.0

### Minor Changes

- 250f5fd: Ensure @drzl/cli builds and exports its config module so consumers can import it directly.

### Patch Changes

- @drzl/analyzer@0.1.0
- @drzl/generator-arktype@0.1.0
- @drzl/generator-orpc@0.1.0
- @drzl/generator-service@0.1.0
- @drzl/generator-valibot@0.1.0
- @drzl/generator-zod@0.1.0

## 0.0.3

### Patch Changes

- 4227090: Fix missing generator dependencies and improve error messages
  - Add all generator packages (@drzl/generator-zod, @drzl/generator-service, @drzl/generator-valibot, @drzl/generator-arktype) as dependencies in CLI package.json
  - Update error handling to provide clearer installation instructions when generators are missing
  - Separate error details for better readability

  This resolves the "Cannot find package" errors when using generators other than ORPC.
  - @drzl/analyzer@0.0.3
  - @drzl/generator-arktype@0.0.3
  - @drzl/generator-orpc@0.0.3
  - @drzl/generator-service@0.0.3
  - @drzl/generator-valibot@0.0.3
  - @drzl/generator-zod@0.0.3

## 0.0.2

### Patch Changes

- Fix missing generator dependencies and improve error messages
  - Add all generator packages (@drzl/generator-zod, @drzl/generator-service, @drzl/generator-valibot, @drzl/generator-arktype) as dependencies in CLI package.json
  - Update error handling to provide clearer installation instructions when generators are missing
  - Separate error details for better readability

  This resolves the "Cannot find package" errors when using generators other than ORPC.
  - @drzl/analyzer@0.0.2
  - @drzl/generator-arktype@0.0.2
  - @drzl/generator-orpc@0.0.2
  - @drzl/generator-service@0.0.2
  - @drzl/generator-valibot@0.0.2
  - @drzl/generator-zod@0.0.2

## 0.0.1

### Patch Changes

- 6130ad2: Initial public release setup: lockstep versioning, CI publish, and branding.
  - @drzl/analyzer@0.0.1
  - @drzl/generator-orpc@0.0.1
