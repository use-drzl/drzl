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

## What it does not emit

- **Composite foreign keys are skipped.** There is no single scalar to accept, and inventing a
  shape for one would be guessing at an API rather than deriving it.
- **The inverse direction is not generated.** A `listPosts` on the `users` router would return
  another table's rows, whose schema this file does not import.
- **Many-to-many is not traversed.** `drzl analyze --relations` reports these, including
  `kind: 'manyToMany'` with the join table in `via`, but the generator does not yet emit an
  endpoint that joins through them.

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
