---
'@drzl/generator-express': minor
'@drzl/cli': minor
---

An Express route generator, in Express's own idiom.

`@drzl/generator-express` emits one `Router()` per table: real HTTP routes carrying a
validation middleware, an `index.ts` mounting them all on an `express()` app with the modules
re-exported, and `validation.ts`, a dependency-free middleware over Standard Schema v1.

The middleware is emitted rather than installed, and that is the decision that shapes the
package. Express has no first-party validator ecosystem the way Hono does, and the third-party
middlewares are AJV-based: they validate JSON Schema through a different pipeline from the zod,
valibot and arktype schemas every other DRZL router shares. All three of those libraries
implement Standard Schema v1 (measured on zod 4.4.3, valibot 1.4.2 and arktype 2.2.3), so one
emitted `validate(slot, schema)` covers every library `validation.library` can name: 400 with
`{ error, slot, issues: [{ message, path }] }` on failure, and on success the parsed output
replaces `req.params` or `req.body`, which is the only channel Express has, before `next()`.

Express 5 only, from a measurement rather than a preference. The write stubs throw from async
handlers, as the Hono generator's do, and Express 5 routes the rejected promise to its error
middleware and answers 500. On express 4.22.2 under Node 22 the same stub is an unhandled
promise rejection that kills the process without responding, so the emitted idiom is only honest
on 5. `express@latest` has been the 5.x line since 2024.

The design otherwise follows `@drzl/generator-hono`:

- The key comes from the table's real `primaryKey`, every column of it, at its real type. A
  table with no primary key keeps `GET /` and `POST /` and loses the `/:id` routes rather than
  gaining a fictional numeric `id`. A composite key becomes `/:orgId/:userId`.
- A read-only table gets no write routes and no insert or update schema.
- Path parameters are coerced strictly, with the exact strict forms the Hono generator measured:
  the idiomatic coercions are built on `Number()`, where `Number('')` is `0`, and
  `GET /users/%20` addressing row `0` is the wrong row, not a loose coercion.
- The write stubs throw rather than returning their validated input, which is the insert shape
  where the declared response is the select shape.
- Every emitted module imports only what it uses, `json()` rides on each write route so a single
  router mounted into a consumer's own app still parses its own bodies, and `validation.ts` is
  emitted only when some route validates something.

One thing is stated plainly instead of imitated: there is no Express counterpart of Hono's
`hc<AppType>()`. Nothing infers a client from an Express app, so what a consumer gets is typed
handlers (`Response<T>` on every handler) and the exported `Select<Table>Row` types, not an
inferred client.

On `@drzl/cli`: a new `express` generator kind, wired into both `generate` and `watch` through
one shared options builder, and a `generate-express` pipeline name for `watch --pipeline`.
`databaseInjection` is refused with a warning on this kind, because it is a contract with
`@drzl/generator-service` and these handlers never call one. There is no `validator` option,
unlike the hono kind, because there is exactly one middleware and it is emitted.
`@drzl/generator-express` is an **optional** dependency of the CLI, like the tRPC, Hono, effect
and json-schema generators: a package that has never been published cannot publish through npm's
trusted-publisher OIDC flow, so its first version goes out by hand, and naming it as a hard
dependency in the same release would break `npm i @drzl/cli` for everyone until it exists.
