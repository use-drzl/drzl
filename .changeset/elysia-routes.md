---
'@drzl/generator-elysia': minor
'@drzl/cli': minor
---

Add `@drzl/generator-elysia`: Elysia routes generated from a Drizzle schema, one mounted module per
table plus an assembled app, validated by the schemas a validation generator already writes.

This is the first DRZL router generator that can use TypeBox, because Elysia's own `t` *is* TypeBox.
Its validator slot is `AnySchema = TSchema | StandardSchemaV1Like`, so it takes a TypeBox schema
natively and anything carrying `~standard` as well. Every other router here types its validators as a
Standard Schema alone, which TypeBox does not implement, so those kinds are limited to three
libraries and this one accepts four. `validation.library` gains `typebox` for it, and a config naming
`typebox` on any other kind is now reported: the schemas would be accepted and never checked, which
is the quietest failure available.

It defaults to zod all the same, and that is measured rather than cautious. `@sinclair/typebox`
ships separate `.d.ts` and `.d.mts` declarations and brands its schema types with `unique symbol`s,
so the two copies are not assignable to each other, and Elysia's own declarations are CommonJS. Under
`moduleResolution: node16` or `nodenext` an ESM consumer resolves TypeBox to the `.d.mts` copy while
Elysia's slot refers to the `.d.ts` one, `TObject` stops matching `TSchema`, and the schema is
rejected for having no `~standard`. Reproduced upstream with a single installed copy of
`@sinclair/typebox@0.34.52`, so it is not a duplicate-install problem and nothing DRZL emits can fix
it. It compiles cleanly under `bundler`, which is what Bun projects use, so the option is worth
having and the default is not. The incompatibility is a must-fire test rather than a comment: if a
later Elysia or TypeBox fixes it, the suite says the default can move.

Unlike every other router generator here, this one has a real runtime spec. Elysia hands out
`app.handle(request) => Promise<Response>`, so the emitted app is driven in-process on plain Node
with no adapter and no server: all four libraries reject an invalid body with a 422, all four convert
a numeric path segment and refuse one that is not a number, and the assembled app routes every
table.

Two things that spec pins which reading the types cannot. A single-label hostname 404s every route,
because Elysia scans the URL string for the path rather than going through `new URL()` and a one-label
host throws off the offset, so `http://x/users` returns `404 NOT_FOUND` for an app that answers
`http://localhost/users` perfectly. And ArkType keeps unknown keys where zod, valibot and TypeBox
strip them, which is a real difference in what reaches a handler.

`t.Numeric()` is Elysia's own coercing spelling for a numeric path segment and does not exist in
`@sinclair/typebox`, where `Type.Numeric` is `undefined`, so the TypeBox dialect imports `t` from
`'elysia'` even though the table schemas beside it come from `@sinclair/typebox`.

`@drzl/cli` gains the `elysia` kind and the `appName` and `prefix` options. `prefix` goes on the
assembled app rather than into each module's own, because Elysia lifts it into the app's type: the
full path is what Eden Treaty reports.
