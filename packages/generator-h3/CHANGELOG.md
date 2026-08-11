# @drzl/generator-h3

## 0.1.0

### Minor Changes

- 7a2c8ae: Add `@drzl/generator-h3`: h3 route handlers generated from a Drizzle schema, for Nitro and Nuxt, one
  module per table with every payload validated through h3's own validation helpers.

  The version split is the whole design, and it is the opposite call from the MCP generator's.
  Established from the registry on 2026-08-11: `nitropack` 2.13.4 depends on `h3: ^1.15.11`, while
  h3's own `latest` tag is `2.0.1-rc.26`, a release candidate. So `npm install h3` gets a version no
  released Nitro uses, and every real Nuxt application is on v1. `h3: 'v1'` is therefore the default
  here, where the MCP generator defaults to its newer SDK: there the older SDK could not carry two of
  the three validation libraries at all, and here the older major is simply what people have.

  The two differ in a way that reaches the emitted code. v2's `readValidatedBody` takes a Standard
  Schema directly and adds `defineValidatedHandler`. v1's takes a `ValidateFunction<T>`, which is
  `(data: unknown) => T | true | false | void`, with no Standard Schema overload at all: h3's own
  documentation suggests passing `objectSchema.safeParse`, a zod-shaped idiom valibot and arktype do
  not have. So a v1 module carries a small adapter and a v2 module carries none. Both are compiled
  against the real h3 of their major, and a case asserts that handing a schema straight to v1 still
  fails, so the adapter cannot quietly become dead weight.

  One line of that adapter is load-bearing: the failure test is `result.issues` and not
  `'value' in result`, because valibot's failure result carries a `value` key alongside its issues and
  the second form would report every valibot failure as a success. The Vercel AI SDK makes exactly
  that mistake, which is why `@drzl/generator-ai` ships a workaround for it. `issues` is the
  discriminator the Standard Schema specification defines.

  A numeric path segment is converted rather than declared, because a segment is always a string and
  `z.number()` against `"1"` refuses every request. Not `z.coerce.number()` either, which accepts an
  empty string as `0`.

  The barrel is a route table rather than a mounted app, deliberately: Nitro discovers handlers by
  file path under `server/routes`, Nuxt under `server/api`, and a bare h3 project mounts them on a
  router by hand, so any one choice would be wrong for the other two.
