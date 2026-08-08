# @drzl/generator-nestjs

## 0.1.0

### Minor Changes

- 4c0128b: A NestJS DTO generator: plain classes carrying a Standard Schema, and a pipe that runs them.

  `@drzl/generator-nestjs` emits one module per table with the insert, update, select and params
  schemas in the configured library's spelling (zod by default, valibot or arktype via
  `validation.library`) and four plain classes around them: `Create<T>Dto`, `Update<T>Dto`,
  `<T>ParamsDto` and `<T>Entity`, each pairing its fields with its schema through
  `static readonly schema: StandardSchema<Dto>`, so schema-vs-field drift is a compile error
  inside the generated file. A `validation.ts` module carries `SchemaValidationPipe`, which
  validates any parameter whose metatype carries such a static and passes everything else
  through untouched, and an `index.ts` barrel re-exports it all. Deliberately DTOs and not
  controllers: routes, modules and providers belong to the consumer's app, and the DTO class is
  the unit Nest itself scaffolds per resource.

  The plan left "class-validator or plain schemas" open, and it was settled from the registry and
  a measured grid rather than taste. Registry: `@nestjs/common` 11.1.28 lists class-validator and
  class-transformer as optional peers; class-validator is active at 0.15.1, while
  class-transformer, the half that would convert wire values, last published 0.5.1 in November
  2021; `nestjs-zod` 5.5.0 is active, evidence the schema-carrying-class idiom is established in
  Nest. Measured, four behaviours the decorator path cannot square with DRZL's settled policies:
  what `@IsInt()` accepts depends on the consumer's ValidationPipe rather than the DTO
  (`enableImplicitConversion: true` reads `""` and `" "` as 0, `"0x10"` as 16, `"1e5"` as 100000,
  the exact `Number('')` family the route generators refuse); `@IsOptional()` cannot tell
  `{ bio: null }` from `{}`, where the enforcing spelling costs three decorators of `@ValidateIf`
  workaround per nullable column; `@Type(() => BigInt)` silently does nothing and `@IsInt()`
  rejects a real bigint; and `@Type(() => Date)` accepts `"1"` as the year 2001. There is a
  compiler reason besides: decorator DTOs fail TS1240 without `experimentalDecorators`, while the
  emitted plain classes compile under every tsconfig including `verbatimModuleSyntax`, with the
  decorator flags needed only where they already are, in the consumer's controllers. The docs
  carry the full grids, including Nest's `ParseIntPipe` (strict on the junk spellings, but it
  silently rounds `"9007199254740993"`) and the coexistence table for a global class-validator
  ValidationPipe beside these DTOs (defaults coexist; `whitelist: true` strips every property of
  a metadata-less class first, measured). The honest paragraph for a consumer who wants the
  class-validator path anyway is in the docs too.

  The presence rule is inherited from the shared builders rather than re-decided: a nullable
  column with no default is required on insert, null spelled out, matching the JSON Schema
  builder the Fastify generator inlines and diverging, documented, from the Hono and Express
  inline schemas. Update DTOs exclude the primary key columns via the shared `updateColumns`, so
  an `id` in a PATCH body is an undeclared key and is stripped. All three libraries strip
  undeclared keys (arktype via an emitted `.onUndeclaredKey('delete')`, measured against its
  default of preserving them), which is `whitelist: true` semantics carried by the schema instead
  of by pipe options. Wire shapes with no JSON form are transformed at the boundary: a Date
  column takes the strict ISO string and hands the controller a real `Date`, and a bigint column
  crosses as its decimal digits and stays a string on both sides, because `JSON.stringify`
  throws on a real bigint (pinned as a 500 in the runtime suite).

  The runtime suite compiles a consumer tree (generated DTOs plus controllers written the docs
  way) with a real `tsc` under the standard Nest flags, boots the compiled JavaScript with
  `NestFactory.create`, and drives it over HTTP for all three libraries, because a
  vitest-transpiled controller would have no decorator metadata and the metatype would silently
  be undefined. Every rejection is paired with an acceptance whose echoed body proves the pipe
  was in the loop: the stripped extra key, the numeric segment arriving as a real number, the
  exact digits of `9007199254740993` surviving.

  On `@drzl/cli`: a new `nestjs` generator kind, wired into both `generate` and `watch` through
  one shared options builder with a byte-for-byte branch-parity spec, and a `generate-nestjs`
  pipeline name for `watch --pipeline`. `databaseInjection` is refused with a warning (there are
  no handlers at all), and so are `includeRelations` (relation lookups are routes) and every
  `validation` key except `library` (the DTO modules are self-contained on purpose).
  `@drzl/generator-nestjs` is an **optional** dependency of the CLI, like the tRPC, Hono,
  Express, Fastify, effect and json-schema generators: a package that has never been published
  cannot publish through npm's trusted-publisher OIDC flow, so its first version goes out by
  hand, and naming it as a hard dependency in the same release would break `npm i @drzl/cli` for
  everyone until it exists.

### Patch Changes

- Updated dependencies [9939e4c]
- Updated dependencies [0e295da]
- Updated dependencies [1218361]
- Updated dependencies [45bb6f5]
- Updated dependencies [cc26f38]
- Updated dependencies [f29bff7]
  - @drzl/validation-core@3.21.0
  - @drzl/analyzer@1.20.1
