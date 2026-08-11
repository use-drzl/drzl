# @drzl/generator-h3

Generate [h3](https://h3.dev) route handlers from a Drizzle schema, for [Nitro](https://nitro.build)
and [Nuxt](https://nuxt.com): one module per table, every payload validated through h3's own
validation helpers.

## The version split

Established from the registry on 2026-08-11: `nitropack` 2.13.4 depends on `h3: ^1.15.11`, while
h3's own `latest` tag is `2.0.1-rc.26`, a release candidate. So `npm install h3` gets a version no
released Nitro uses, and every real Nuxt application is on v1. **`h3: 'v1'` is the default.**

The two differ in a way that reaches the emitted code. v2 takes a Standard Schema directly. v1 takes
a `ValidateFunction<T>`, which is `(data: unknown) => T | true | false | void`, with no Standard
Schema overload at all: h3's own documentation suggests passing `objectSchema.safeParse`, a
zod-shaped idiom valibot and arktype do not have. So a v1 module carries a small adapter and a v2
module carries none.

One line of that adapter is load-bearing: the failure test is `result.issues` and **not**
`'value' in result`, because valibot's failure result carries a `value` key alongside its issues and
the second form would report every valibot failure as a success. The Vercel AI SDK makes exactly
that mistake, which is why `@drzl/generator-ai` ships a workaround for it.

## Install

```bash
npm install -D @drzl/generator-h3
```

```ts
// drzl.config.ts
export default {
  schema: './src/db/schema.ts',
  generators: [
    { kind: 'zod', path: 'src/validators/zod' },
    { kind: 'h3', path: 'server/generated' },
  ],
};
```

Set `h3: 'v2'` when your project is on the 2.x line.

## What it emits

`GET /users`, `GET /users/:id`, `POST /users`, `PATCH /users/:id` and `DELETE /users/:id` per table.
A numeric path segment is converted rather than declared, because a segment is always a string and
`z.number()` against `"1"` refuses every request.

The barrel is a route table rather than a mounted app: Nitro discovers handlers by file path, Nuxt
by a different one, and a bare h3 project mounts them by hand, so any single choice would be wrong
for the other two.

Full documentation: https://drzl.dev/generators/h3

## Licence

Apache-2.0. Generated output is yours under your own project's licence.
