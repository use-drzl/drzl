---
---

Test-only. Adds analyzer coverage measuring the four dialects that had none, and changes no source:
`git diff master..HEAD -- 'packages/*/src'` is empty.

The defects it found are filed rather than fixed, since each needs its own scoped change:
mssql and cockroach losing their boolean and string families, `decimal` typed as a number on MySQL
and SingleStore while the driver returns a string, gel's seven holes, `binary`/`varbinary` typed as
`Uint8Array`, the JSON Schema generator ignoring `maxBytes`, and the untyped-column warning firing
falsely on enums.
