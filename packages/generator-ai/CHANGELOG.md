# @drzl/generator-ai

## 0.1.1

### Patch Changes

- 555524a: Point the README documentation links at a host that resolves.

  Twelve package READMEs linked `https://drzl.dev/generators/<kind>`. That host does not resolve at
  all: curl fails to connect rather than returning a status. The site is published at
  `https://use-drzl.github.io/drzl/`, which every one of the twelve now uses, and each target was
  checked for a 200 before the link was rewritten.

  These are the READMEs npm renders on the package page, so the dead link was the "Full documentation"
  line a reader follows first. A version bump is the only way a corrected README reaches npm, which is
  why a link fix is a release.

  The split was along age: the twelve newest packages used `drzl.dev` and the ten older ones used the
  working form, so the wrong host was copied forward from one new package to the next.

  `@drzl/generator-ts-rest` also carries a version correction. Its source comments, the header it
  writes into every emitted contract, and its test docstring all said `@ts-rest/core` 3.53.0-rc.0 or
  newer, while `package.json` requires `^3.53.0-rc.1`. Both are now rc.1, which is the version the
  package actually pins and tests against. The distinction is real rather than cosmetic: 3.53.0-rc.0
  is published and does carry the Standard Schema support this generator depends on, exporting
  `isStandardSchema`, `validateAgainstStandardSchema` and `parseAsStandardSchema` and no
  `checkZodSchema`. Nothing here has been run against it, so the floor stays at the version the tests
  use and the test file now records why.

## 0.1.0

### Minor Changes

- 26e2ba7: Add `@drzl/generator-ai`: Vercel AI SDK tools generated from a Drizzle schema, five per table, with
  the table's `CHECK` constraints reaching the model as bounds on the arguments it is allowed to send.

  The same thesis as `@drzl/generator-mcp` over a different surface. A tool hands a model a JSON
  Schema and the model writes arguments against it; derive that schema from the column types alone and
  the model learns that `age` is an integer and nothing else, so it guesses, the write reaches the
  database, and the database refuses it.

  One measurement changed what this emits. `tool()` accepts any Standard Schema, and the SDK's adapter
  decides whether a validation passed with `'value' in result`. A valibot failure result is
  `{ value, typed, issues }`: it carries a `value` key **even when it failed**. So every valibot
  validation failure is reported to the AI SDK as a success and the invalid input reaches `execute`.
  Measured on 2026-08-11 against `ai` 7.0.59 and `@ai-sdk/provider-utils` 5.0.26 with a schema
  demanding `age >= 18`: zod and arktype refuse `{ age: 7 }` through the SDK and valibot accepts it,
  because their failure results carry no `value` key and valibot's does.

  A generated valibot tool would therefore have validated nothing at all, silently, and would have
  looked identical to one that worked in the emitted text and in a type check. So valibot tools are
  emitted through `jsonSchema(document, { validate })` with the parse spelled out. zod and arktype are
  passed through, because they work.

  Two smaller findings shaped the emitted code, both caught by compiling it. Every `execute` carries
  an explicit return type, because a stub whose only statement is `throw` returns `Promise<never>` and
  `never` propagates into `tool()`'s inference until the call matches no overload at all, reporting a
  problem about the input schema for something entirely about the output. And the emitted valibot
  adapter is parameterised on input and output separately, because `v.GenericSchema<T>` defaults its
  output to its input and a date column's input is a string while its output is a `Date`.

  `@drzl/cli` gains the `ai` kind. The new package is an `optionalDependency` for this release only,
  for the reason the other two new generators already are.
