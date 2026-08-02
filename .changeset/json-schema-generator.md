---
'@drzl/generator-json-schema': minor
'@drzl/analyzer': patch
'@drzl/cli': minor
---

Add a JSON Schema and OpenAPI generator, and fix two analyzer gaps it uncovered on drizzle-orm 0.4x

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
- **`pgEnum` columns came back `unknown`.** The class map had no arm for `PgEnumColumn`, so the
  values sat in `enumValues` with no type to attach to.

Both produced schemas that accepted anything, in all five generators, with nothing reporting a
problem. `verify-packed.sh` pins `drizzle-orm@1.0.0-rc.4`, so the whole verification ladder only
ever ran on one major; it now runs a stage against 0.4x that fails on any column the analyzer
cannot name. That stage found the enum bug the first time it ran.
