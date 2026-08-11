---
'@drzl/generator-service': patch
'@drzl/generator-fastify': patch
'@drzl/validation-core': patch
'@drzl/generator-nestjs': patch
---

The emitted TypeScript row types stop saying `unknown` for json and binary columns

The generators that emit types rather than schemas described a json column as `unknown`, and the
service generator described it as `any`, while every validator generator beside them said what the
column is. A row type that says `unknown` makes the caller cast to read a value the database
guarantees is json; one that says `any` is worse, since it turns checking off without saying so.

Both now carry a type. `json` becomes a `DrzlJsonValue` alias declared in the module, and a binary
column becomes the `Uint8Array` the driver hands back:

```ts
export interface SelectwRow {
  id: number;
  prefs: DrzlJsonValue;   // was unknown
  blob: Uint8Array;       // was unknown
  custom: unknown;        // a customType, which nothing can type
}
```

The alias text lives in `@drzl/validation-core`, so the four generators that emit it cannot drift,
and it is emitted only into a module that names it: a table with no json column produces the bytes
it produced before. It is verified mutually assignable with zod's own `z.json()` output, which is
what lets a NestJS DTO field use it and still satisfy the `StandardSchema<Dto>` static beside it.

`custom` staying `unknown` is the point of the control: a `customType` with no `$type<T>()` is a
column nothing can type, and `typedColumns` is what recovers it.
