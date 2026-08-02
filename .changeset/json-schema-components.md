---
'@drzl/generator-json-schema': minor
'@drzl/cli': minor
---

Emit an OpenAPI `components.schemas` document

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
