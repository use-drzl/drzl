---
'@drzl/generator-json-schema': minor
'@drzl/cli': minor
---

Emit a whole OpenAPI document, not just `components.schemas`. `document: true` on the `json-schema`
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
