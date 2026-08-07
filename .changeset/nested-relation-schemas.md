---
'@drzl/validation-core': minor
'@drzl/generator-zod': minor
'@drzl/generator-valibot': minor
'@drzl/generator-arktype': minor
'@drzl/generator-typebox': minor
'@drzl/cli': minor
---

Relations-aware nested schemas: `nestedSchemas: true` emits `NestedInsert<Table>` and
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

---

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
