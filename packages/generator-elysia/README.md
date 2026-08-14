# @drzl/generator-elysia

Generate [Elysia](https://elysiajs.com) routes from a Drizzle schema: one mounted module per table
plus an assembled app, validated by the schemas a validation generator already writes.

## The one generator that takes TypeBox

Every other DRZL router types its validators as a Standard Schema, which TypeBox does not implement,
so those kinds are limited to zod, valibot and arktype. Elysia's slot is
`AnySchema = TSchema | StandardSchemaV1Like`, because Elysia's own `t` *is* TypeBox. This is the one
generator that accepts all four.

It defaults to zod all the same. TypeBox ships separate `.d.ts` and `.d.mts` declarations and brands
its schema types with `unique symbol`s, and Elysia's declarations are CommonJS, so under
`moduleResolution: node16` or `nodenext` the two resolve to different copies and a `TObject` stops
matching `TSchema`. Reproduced upstream with a single installed copy of `@sinclair/typebox@0.34.52`,
so nothing DRZL emits can fix it. It compiles cleanly under `bundler`, which is what Bun projects
use, so set `validation.library` to `typebox` there.

## Install

```bash
npm install -D @drzl/generator-elysia
npm install elysia
```

```ts
// drzl.config.ts
export default {
  schema: './src/db/schema.ts',
  generators: [
    { kind: 'zod', path: 'src/validators/zod' },
    { kind: 'elysia', path: 'src/routes' },
  ],
};
```

## Three details worth knowing

`t.Numeric()` comes from `elysia`, not from `@sinclair/typebox`, where `Type.Numeric` is `undefined`.
It is one of fifteen types Elysia adds, and it is the right spelling for a path segment that should
be a number, since a segment is always a string.

ArkType keeps unknown keys where zod, valibot and TypeBox strip them. Elysia accepts the body either
way; the difference is what reaches your handler.

Test with a multi-label hostname. `app.handle(new Request('http://x/users'))` returns `404` for an
app whose routes work, because Elysia scans the URL string for the path rather than using `new URL()`
and a one-label host throws off the offset. Use `http://localhost/users`.

## Serving it

`app.listen(3000)` under Bun, or hand `app.handle` a `Request` anywhere else. The second form is what
this package's tests use, which is why they run on plain Node with no adapter and no server.

Full documentation: https://use-drzl.github.io/drzl/generators/elysia

## Licence

Apache-2.0. Generated output is yours under your own project's licence.
