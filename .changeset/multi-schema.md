---
'@drzl/analyzer': minor
'@drzl/validation-core': minor
'@drzl/generator-json-schema': minor
'@drzl/generator-orpc': patch
'@drzl/cli': minor
---

Multi-schema support: two tables of the same name in different Postgres schemas, addressed and
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
