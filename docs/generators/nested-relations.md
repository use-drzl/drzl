# Nested Relation Schemas

Validate a whole nested payload, `{ ...user, posts: [...] }`, rather than the parent and each child
separately.

```ts
{ kind: 'zod', path: 'src/validators/zod', nestedSchemas: true }
```

Available on all five validation generators, off by default. With it off, the emitted output is
byte-for-byte what it was before.

A whole config, with every generator that takes the option:

```ts
export default {
  schema: 'src/db/schema.ts',
  outDir: 'src/api',
  generators: [
    { kind: 'zod', path: 'src/validators/zod', nestedSchemas: true },
    { kind: 'valibot', path: 'src/validators/valibot', nestedSchemas: true },
    { kind: 'arktype', path: 'src/validators/arktype', nestedSchemas: true },
    { kind: 'typebox', path: 'src/validators/typebox', nestedSchemas: true, nestedDepth: 2 },
    { kind: 'effect', path: 'src/validators/effect', nestedSchemas: true },
  ],
};
```

## Why this exists

**Nothing in the Drizzle ecosystem describes this payload.** Measured against
`drizzle-orm/{zod,valibot,arktype,typebox-legacy}` at 1.0.0-rc.4 and against
`drizzle-zod`/`drizzle-valibot`/`drizzle-typebox`/`drizzle-arktype` on the 0.4x line,
`createInsertSchema(users)` emits `['id', 'name']` and never a `posts` key, in every mode and every
library. Handing the `relations()` object in as a second argument does not change it either: that
slot is the refine slot, so the object's keys are not column names and it is dropped. Handing it in
first throws inside `getColumns`.

**And the payload is not merely unvalidated, it is silently discarded.** On both majors:

```ts
db.insert(users).values({ name: 'a', posts: [{ title: 't' }] });
// insert into "users" ("id", "name") values (default, $1)   params: ["a"]
```

The `posts` key is dropped, no error is raised, and the children are never written. A schema that
refuses the payload you cannot execute, and describes the one you can, is the thing that was
missing.

The read side has a real producer: `db.query.users.findMany({ with: { posts: true } })` works on
both majors and returns exactly this shape.

## What it emits

For a `users` / `posts` schema with `posts.authorId` referencing `users.id`:

```ts
export const NestedInsertusersSchema = z.object({
  name: z.string(),
  posts: z
    .array(
      z.object({
        title: z.string(),
      })
    )
    .optional(),
});

export type NestedInsertusersInput = z.input<typeof NestedInsertusersSchema>;

export const NestedSelectusersSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  posts: z
    .array(
      z.object({
        id: z.number().int(),
        authorId: z.number().int(),
        title: z.string(),
      })
    )
    .optional(),
});

export type NestedSelectusersOutput = z.output<typeof NestedSelectusersSchema>;
```

They sit in the table's own module beside the flat schemas, and the barrel already re-exports it.
The relation key is the **child table's Drizzle export name**, because `Relation` carries no field
name and nothing else names the key.

The other three libraries emit the same shape in their own spelling: `v.optional(v.array(...))`,
`Type.Optional(Type.Array(...))`, and `'posts?': type({...}).array()`.

## What happens to the foreign key

`posts.authorId` does not exist until the user is inserted, so **it is not in the nested insert
shape at all**.

The alternatives are both worse. Requiring it makes the schema unusable: there is no value to
supply. Permitting it as optional makes the schema accept
`{ name: 'ada', posts: [{ title: 't', authorId: 999 }] }`, a payload no correct nested write can
honour, since the parent is what determines that column.

The column is only dropped where the relation says which column it is, which means the child has
**exactly one** foreign key back to the parent:

- **Two or more.** A `messages` table with `senderId` and `recipientId` both pointing at `users` is
  genuinely ambiguous, and `Relation` has no field name to tell them apart. Nothing is dropped, and
  a comment above the arm says so. You supply them.
- **None.** A relation declared by `relations()` with no `references`, or found by the name-matching
  heuristic, has no key to drop. The child keeps every column it declared.

The **plain** insert schema is untouched in every case, so nesting never weakens the flat one. On a
nested **select** nothing is dropped at all: the row really comes back carrying its foreign key.

## `one`, `many` and `manyToMany`

| Kind         | Nested insert                             | Nested select                |
| ------------ | ----------------------------------------- | ---------------------------- |
| `many`       | array of the child, minus its foreign key | array of the child           |
| `manyToMany` | array of the far side                     | array of the far side        |
| `one`        | **not emitted**                           | the parent object, or `null` |

**`one` is deliberately absent from the insert schema.** In `{ ...post, author: {...} }` the foreign
key is on the _outer_ object, `posts.authorId`, not on the nested one: the author is written first
and the post then points at it. Admitting the arm means making `authorId` optional on the post, and
an optional `authorId` also admits `{ title: 't' }` with neither a key nor an author, which is a row
a NOT NULL column refuses. That would make the schema accept a write the database rejects, which is
worse than not describing the payload.

Two forms express it properly and neither is built: a union of "you gave the key" and "you gave the
object", which is 2^n branches on a table with n `one` relations, or a row-level "exactly one of
these" assertion, which all four libraries can carry but each spells differently. Both are open.

**A `manyToMany` arm carries the far side only.** The join row's columns are the two foreign keys,
and the two ends of the payload supply both, so there is nothing left to describe. The comment above
the arm names the join table, since the shape cannot.

**A pair of tables linked both ways gets one arm.** The key can only come from the table name, so a
`one` and a `many` between the same pair collide; `many` wins, because it is the arm that can hold
every related row. A relation whose key would collide with a **column** of the same name is dropped
entirely: the columns are the row.

## There is no nested update schema

A nested update payload has no single meaning. `{ name: 'x', posts: [...] }` could mean replace
every child, upsert them, or patch the ones that match, and choosing needs an operation vocabulary
(Prisma spells it `create` / `connect` / `set` / `deleteMany`) that neither DRZL nor Drizzle has.

It could not be acted on even if the meaning were fixed: an update schema drops the primary key,
because a key identifies a row rather than changes it, so a child inside an update payload carries
nothing that says which row it patches.

## Depth, and what stops a cycle

`nestedDepth` defaults to **1** and is capped at **3**.

```ts
{ kind: 'valibot', path: 'src/validators/valibot', nestedSchemas: true, nestedDepth: 2 }
```

At 2, `{ ...user, posts: [{ ...post, comments: [...] }] }` validates whole, and each level drops its
own foreign key.

Relations are frequently circular, `users -> posts -> users`, and a self-referencing table
(`users.managerId -> users`) is the case that occurs most. **The depth is what terminates them.**
Nesting is expanded inline, so at the last level the relation keys are simply not emitted and the
recursion has nowhere to go.

That is a deliberate choice over a genuinely recursive schema. All four libraries can express one
and each does it differently, measured by running them:

| Library         | Cyclic schema                | Behaviour                                                                                                                           |
| --------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| zod 4.4.3       | property getter, or `z.lazy` | works, no annotation needed at runtime                                                                                              |
| valibot 1.4.2   | `v.lazy`                     | works; TypeScript wants an explicit `GenericSchema` annotation                                                                      |
| ArkType 2.2.3   | only inside a `scope`        | a plain forward reference throws `Cannot access 'Post' before initialization` **at module load**                                    |
| TypeBox 0.34.52 | only inside a `Type.Module`  | a bare `Type.Ref` constructs happily and then throws `Unable to dereference schema with $id` the first time anything checks a value |

Two of the four therefore have a failure mode where the generated module is broken rather than
merely wrong, and each would need a different mechanism. Inline expansion needs none of them, needs
no type annotation, and makes the four outputs structurally identical.

The cost is size: the emitted output grows multiplicatively in the depth. A schema whose tables
average R relations emits R^depth child shapes per root table, and both directions of a
many-to-many count. That is why the default is 1 and the cap is 3.

## Extra keys behave differently per library

The four libraries disagree about a key the schema does not declare, and this feature makes that
visible, because a foreign key omitted from a child arm is exactly such a key.

| Library | An undeclared key in a child    |
| ------- | ------------------------------- |
| zod     | stripped from the parsed result |
| valibot | stripped from the parsed result |
| TypeBox | ignored; the value still passes |
| ArkType | kept in the returned value      |

None of them refuses it, so a payload that carries an `authorId` on a child validates everywhere.
Nothing here makes the objects strict, for the same reason the flat schemas are not strict: turning
away input the database accepts is the failure mode this project avoids.

## What it interacts with

- **`applyDefaults`, `coerceDates`, `typedJson`, `typedColumns`** all apply inside nested shapes,
  because the fields are rendered through the same code path as the flat schemas. With `typedJson`
  or `typedColumns` the type-only schema import names every table the nesting reaches, not just the
  file's own.
- **CHECK constraints** apply at every level: a child carries its own column checks and its own
  row-level checks, and a check naming an omitted foreign key drops out with the column.
- **Read-only relations** (a materialized view) get a nested select and no nested insert, matching
  the flat schemas.
- **A table with no relations gets nothing.** A nested schema there would be a byte-for-byte copy of
  the flat one under a second name. The same holds per mode: a table that is only ever a child has a
  nested select and no nested insert.

## Inspecting what was detected

The arms come from `analysis.relations`, so a column that merely looks like a foreign key produces
nothing until it has a real `.references()`. To see the graph:

```bash
npx @drzl/cli analyze src/db/schemas/index.ts --relations --json
```
