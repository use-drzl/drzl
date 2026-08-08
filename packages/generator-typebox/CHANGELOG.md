# @drzl/generator-typebox

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
