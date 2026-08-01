---
'@drzl/generator-orpc': minor
'@drzl/generator-service': patch
---

`includeRelations` now generates endpoints. It was accepted and then ignored: nothing in the
package ever read `analysis.relations` or `Table.foreignKeys`, so setting it changed no byte of
output while docs/examples/relations.md promised endpoints like `listByParentId`.

Each single-column foreign key now produces a lookup on its own table's router, named after the
column that holds it. A `posts` table with `authorId` gains `listByAuthorId`, taking
`{ authorId }` and returning an array of that table's select schema, in whichever validation
library is configured.

Naming follows the column rather than the referenced table, because two keys frequently point at
the same table: `authorId` and `editorId` both referencing `users` yield `listByAuthorId` and
`listByEditorId`, where naming by table would emit one procedure twice under the same key.

Composite foreign keys are skipped, having no single scalar to accept. The inverse direction is
not generated, since it would return another table's rows and require an import the file cannot
resolve. Many-to-many links are reported by the analyzer but not yet traversed by the generator.

Procedures are synthesised by the generator rather than by a template, so the flag works with
every template including custom ones. They are strictly additive: the CRUD surface is identical
whether or not the flag is set, and a template declaring a procedure of the same name keeps its
own.

Also removes `src/analyzer-types.d.ts` from this package and from `@drzl/generator-service`. Each
was a `declare module '@drzl/analyzer'` block that shadowed the real types of a package both
already depend on, with a hand-maintained subset that had drifted: no `primaryKey`, `unique`,
`indexes`, `checks` or `foreignKeys`, and `relations` typed as `any[]`. Both packages compile
against the genuine types now, so the analyzer's shape cannot silently disagree with what its
consumers believe it to be.
