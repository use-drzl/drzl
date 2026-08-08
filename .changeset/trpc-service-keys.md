---
'@drzl/generator-trpc': patch
---

Service-mode routers reach the service for natural and composite keys

`template: 'service'` stubbed byId/update/delete for any table whose key was not exactly one
`number`, because `@drzl/generator-service` could not receive anything else. That generator now
types its key parameters from the primary key itself, so the guard follows it: the call is
wired whenever every key column has a type the input schema can spell (number, string,
boolean, Date, or an enum's literals), composing a composite key as one argument per key
column in key order (`Service.getById(input.orgId, input.userId)`). The throwing stub remains
only for a key column DRZL cannot type, where the input carries `z.unknown()` and the call
would not compile, and the emitted note now states that reason instead of the old single
number limitation.
