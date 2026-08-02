# Relations Example

Enable `includeRelations` to add a lookup endpoint for every foreign key on a table.

```ts
export default defineConfig({
  schema: 'src/db/schemas/index.ts',
  outDir: 'src/api',
  generators: [{ kind: 'orpc', includeRelations: true }],
});
```

## What it emits

One procedure per single-column foreign key, named after the **column** that holds it. Given:

```ts
export const posts = pgTable('posts', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  authorId: integer('author_id').references(() => users.id),
});
```

the `posts` router gains `listByAuthorId`, alongside the usual `list`, `get`, `create`, `update`
and `delete`:

```ts
const listByAuthorIdPosts = os
  .input(z.object({ authorId: z.number() }))
  .output(z.array(SelectpostsSchema))
  .handler(async ({ input: _input }) => {
    // Rows of posts whose "authorId" matches _input.authorId.
    return [];
  });

export const posts = {
  list: listPosts,
  // ...
  listByAuthorId: listByAuthorIdPosts,
};
```

The handler body is a stub, exactly like the other generated procedures: DRZL emits the router
surface and leaves the query to your service layer.

Naming follows the column rather than the referenced table, because two keys often point at the
same table. A `posts` table with `authorId` and `editorId` both referencing `users` gets
`listByAuthorId` and `listByEditorId`; naming by table would collide.

The input type follows the column, the output is always an array of that table's own select
schema, and both respect your chosen validation library, so `valibot` emits `v.object`/`v.array`
and `arktype` emits `type({ ... })`/`.array()`.

## Lookups that return another table

The inverse of a foreign key, and the far side of a many-to-many, are emitted too:

```ts
// on the users router, because posts.authorId points here
listPosts: listPostsUsers,

// on the posts router, because posts and tags are joined by posts_to_tags
listTags: listTagsPosts,
```

These take `{ id }` and return an array of the other table's select schema, which is imported
from that table's router.

Those imports are circular by nature: with a many-to-many, `posts` imports `tags` and `tags`
imports `posts`. So the schema is referenced through `z.lazy()` (or `v.lazy()`), which resolves
on first use rather than at module load. Referencing it directly typechecks perfectly and then
throws `Cannot access SelecttagsSchema before initialization` the moment you import the router,
which is why the generated code looks like this:

```ts
.output(z.array(z.lazy(() => SelecttagsSchema)))
```

With `validation.useShared`, every router imports the one barrel instead, so there is no cycle,
and the lazy wrapper is harmless either way.

## What it does not emit

- **Composite foreign keys are skipped.** There is no single scalar to accept, and inventing a
  shape for one would be guessing at an API rather than deriving it.
- **ArkType gets no cross-table lookups.** Its deferred form differs from Zod's and Valibot's,
  and an endpoint that fails to load is worse than one that is absent. Its own foreign-key
  lookups (`listByAuthorId`) are unaffected.

Relation procedures are always additive. The CRUD surface is byte-identical whether or not the
flag is set, and a template that already declares a procedure of the same name keeps its own.

## Inspecting what was detected

`includeRelations` on the generator needs only foreign keys, which are always analysed. To see
the full relation graph, including many-to-many, ask the analyzer directly:

```bash
npx @drzl/cli analyze src/db/schemas/index.ts --relations --json
```

Tip: the endpoints are derived from real foreign keys, so a column that merely looks like one,
such as an `authorId` with no `.references()`, produces nothing. Add the reference to your Drizzle
schema and it will be picked up.

::: tip Need something else?
If this example doesn't cover what you need, DM me on X (https://x.com/omardulaimidev) and we can scope it together.
:::
