# NestJS Generator

Generates [NestJS](https://nestjs.com) DTO and entity classes per table: plain classes whose
fields state the parsed shape and whose `static schema` carries a Standard Schema v1 validator,
plus a small validation pipe that runs it. They drop into controllers you write yourself.

```bash
npm install -D @drzl/generator-nestjs
```

`@drzl/cli` depends on it, so installing the CLI already brought it along; the line above is for
using the generator on its own. `drzl generate` tells you which package to install if it is ever
missing. The generated code imports `@nestjs/common`, which a Nest app has by definition, and the
validation library you chose (`zod` by default).

## DTOs, not controllers

A controller drags Nest's DI machinery into generated code: modules, providers, guards, and
decorator arguments that belong to your app's own design. A DTO class is the unit Nest itself
scaffolds per resource (`nest g resource` writes `create-user.dto.ts` before anything else), it
drops into any controller signature, and it is the piece a schema generator can actually derive
from a table. So this generator emits the DTOs and the pipe, and the routes stay yours.

::: tip Not a template
DRZL's "templates" are `ORPCTemplateHooks`, and both shipped ones hand back oRPC source text. A
NestJS template written against that interface would emit a file that does not compile, which is
the same reason the Hono, Express and Fastify generators are generators.
:::

## Why plain classes with a schema, not class-validator decorators

Nest's native validation path is class-validator and class-transformer decorators on the DTO,
validated by `ValidationPipe`. This generator deliberately does not emit that, and the decision
was settled from the registry and from measurement rather than taste.

From the registry (checked 2026-08-08): `@nestjs/common` 11.1.28 lists `class-validator` and
`class-transformer` as *optional* peer dependencies, so they are an add-on rather than part of
Nest. `class-validator` is at 0.15.1 and actively released; `class-transformer`, the half that
would have to convert wire values into field types, last published 0.5.1 in November 2021.
`nestjs-zod` 5.5.0 is active and popular, which is evidence that "a class carrying a schema,
validated by a custom pipe" is an established Nest idiom, not something DRZL invented.

From measurement (class-validator 0.15.1, class-transformer 0.5.1, `@nestjs/common` 11.1.28),
four behaviours a DRZL DTO cannot accept:

1. **What a decorator DTO accepts depends on the consumer's pipe options, not on the DTO.**
   `@IsInt()` against string inputs, measured through a real `ValidationPipe`:

   | value    | `enableImplicitConversion: true` | `transform: true` alone | defaults |
   | -------- | -------------------------------- | ----------------------- | -------- |
   | `""`     | accepted as `0`                  | rejected                | rejected |
   | `" "`    | accepted as `0`                  | rejected                | rejected |
   | `"0x10"` | accepted as `16`                 | rejected                | rejected |
   | `"1e5"`  | accepted as `100000`             | rejected                | rejected |
   | `"1.5"`  | rejected                         | rejected                | rejected |
   | `"42"`   | accepted as `42`                 | rejected                | rejected |

   The first column is the `Number('')` family the [Hono](/generators/hono),
   [Express](/generators/express) and [Fastify](/generators/fastify) generators exist to refuse,
   and one flag on someone else's pipe resurrects it. A static schema carries its policy with
   it; no pipe option can loosen it.

2. **`@IsOptional()` treats null and undefined alike**, and it is the only omissible spelling on
   offer. On a `NOT NULL` column with a default, which may be omitted but has no null among its
   values, it accepts an explicit null the database refuses (measured on class-validator 0.15.1:
   `{ role: null }` accepted under `@IsOptional() @IsIn(['admin','member'])`). The enforcing
   spelling exists, and it is a decorator of workaround per defaulted column:
   `@ValidateIf((o) => o.role !== undefined)` ahead of the member check, measured to give exactly
   "omission accepted, null refused".

3. **bigint has no story.** `@Type(() => BigInt)` silently leaves the string untouched (BigInt
   is not newable, so class-transformer skips it; measured), and `@IsInt()` rejects a real
   bigint (measured). There is nothing to decorate a bigint column with.

4. **Date conversion is permissive.** `@Type(() => Date)` runs `new Date()`, and the measured
   grid accepts `"1"` as the year 2001 and a bare epoch number, while rejecting only what
   produces `Invalid Date`. The generated schemas take the strict ISO form instead.

There is also a compiler reason: class-validator decorators require `experimentalDecorators`,
so emitted decorator DTOs would not even typecheck in a project without Nest's tsconfig flags
(measured: TS1240 under a flag-less strict tsconfig). The plain classes emitted here compile
under every tsconfig, including `verbatimModuleSyntax`, and the decorators stay where they
already are: in your controllers, compiled by your app's own flags.

### If you want the class-validator path anyway

It is a legitimate choice when your team already standardises on it. Write the DTO classes by
hand with class-validator decorators, spell omissible-but-not-nullable columns with the
`@ValidateIf` form from point 2, keep `enableImplicitConversion` off and convert path
parameters with `ParseIntPipe` per parameter, and skip this generator: generating those classes
would freeze the measured caveats above into your API. DRZL's zod, valibot and arktype
generators can still validate the same tables elsewhere in the app, and `nestjs-zod` can wrap
DRZL's zod output (`createZodDto(InsertusersSchema)`) if you want schema-backed DTOs with
Swagger integration today; what this generator adds over that is the emitted pipe with no extra
dependency, the params DTOs with the strict segment grid, and classes for all three libraries.

## What it emits

| File            | What it is                                                                  |
| --------------- | --------------------------------------------------------------------------- |
| `<table>.ts`    | the mode schemas plus `Create<T>Dto`, `Update<T>Dto`, `<T>ParamsDto`, `<T>Entity` |
| `validation.ts` | `SchemaValidationPipe`: validates any parameter whose class carries a static schema |
| `index.ts`      | a barrel re-exporting every module, classes, schemas and pipe alike          |

Per table, at most four classes:

- `Create<Table>Dto`: the insert shape. Generated columns are absent, and a column the database
  can fill in is **optional**: one with a default, or a nullable one, since an `INSERT` that omits
  a nullable column stores `NULL`.
- `Update<Table>Dto`: every field optional, **primary key columns excluded** (a PATCH body
  cannot re-key the row; an `id` in the body is an undeclared key and is stripped).
- `<Table>ParamsDto`: the primary key columns, parsed strictly from their string segments. A
  keyless table has none.
- `<Table>Entity`: one row at its select shape. A read-only table (a materialized view) emits
  only this and its params DTO.

Every class pairs with its schema through a typed static,
`static readonly schema: StandardSchema<CreateUsersDto> = InsertusersSchema`, so a schema whose
parsed output drifts from the declared fields is a compile error inside the generated file.

## Using them

```ts
import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { CreateUsersDto, UpdateUsersDto, UsersParamsDto, UsersEntity } from './dto/index.js';

@Controller('users')
export class UsersController {
  @Post()
  create(@Body() body: CreateUsersDto) {
    // body is the parsed output: undeclared keys stripped, types transformed.
  }

  @Patch(':id')
  update(@Param() params: UsersParamsDto, @Body() body: UpdateUsersDto) {
    // params.id is a real number here, parsed by the strict segment schema.
  }
}
```

Bind the pipe globally, or per controller with `@UsePipes`:

```ts
import { SchemaValidationPipe } from './dto/index.js';

app.useGlobalPipes(new SchemaValidationPipe());
```

The pipe validates any parameter whose metatype carries a static Standard Schema, which is
every class in the generated directory, and passes everything else through untouched:
primitives, foreign DTOs, and requests that bind no class at all. On failure it throws
`BadRequestException` with `{ error, slot, issues: [{ message, path }] }`, which Nest answers
as a 400 naming the offending columns.

Nest hands the pipe its metatype through `emitDecoratorMetadata`, so your app needs the
standard Nest tsconfig flags (`experimentalDecorators`, `emitDecoratorMetadata`), which every
`nest new` project already has. The *generated files themselves* need neither flag.

### Beside an existing class-validator ValidationPipe

The generated classes carry no class-validator metadata, and what Nest's own `ValidationPipe`
does with such a class was measured rather than assumed:

| its options                    | effect on these DTOs                                             |
| ------------------------------ | ---------------------------------------------------------------- |
| defaults                       | passes them through unchanged; the two pipes coexist             |
| `whitelist: true`              | strips **every** property before this pipe runs                  |
| `forbidNonWhitelisted: true`   | rejects every request carrying one                               |

So a global `ValidationPipe()` at defaults is fine alongside `SchemaValidationPipe`. With
`whitelist: true`, scope one of the two pipes away from the other's controllers: whitelisting
is already built into these DTOs (their schemas strip undeclared keys, proven in the runtime
suite by an extra property disappearing), so they lose nothing by being excluded from it.

## Path parameters

A URL path segment is always a string. Nest's own per-parameter answer is `ParseIntPipe`, and
its measured grid (11.1.28) is strict where it counts: `"1abc"`, `""`, `" "`, `"0x10"`, `"1e5"`
and `"1.5"` are all rejected. Two things it cannot do: it validates one scalar rather than the
key as a whole, and it accepts `"9007199254740993"` as `9007199254740992`, a silent precision
loss on any bigint-ranged key.

The params DTOs use the strict string spellings the route generators settled on, shared with
the [Hono grid](/generators/hono#path-parameters): `^-?\d+(\.\d+)?$` transformed by `Number`
for a numeric key, digits kept as a string for a bigint key, strict ISO datetime for a Date
key, the member set for an enum key, and a composite key validated whole with every column
named.

## Date and bigint on the wire

A JSON body cannot carry a `Date` instance or a bigint, so the insert and update schemas take
their wire forms and the classes state the parsed result:

- A `Date` column accepts the strict ISO datetime string and hands your controller a real
  `Date`. All three libraries accept the `Z`-suffixed form and reject `"garbage"` and `"1"`
  (the class-validator path accepts the latter, grid above). At the edges the three spellings
  differ, measured: zod's `z.iso.datetime()` is the strictest (UTC `Z` only), valibot's
  `isoTimestamp` also takes a numeric offset, and arktype's `string.date.iso` takes any ISO
  8601 form including a bare date. The runtime suite pins the shared rows for every library and
  the arktype divergence explicitly.
- A `bigint` column accepts its decimal digits and **stays a string on both sides**, because
  `JSON.stringify` throws on a real bigint the moment you return one (pinned in the runtime
  suite as a 500). Convert at the database boundary; the digits survive exactly, with no
  `Number()` rounding of values past 2^53.
- The `<T>Entity` select shape states what a handler returns: `Date` for date columns (Nest
  serializes it to its ISO string), digit strings for bigint.

## Presence, the inherited rule

A column is optional on insert exactly when the database can produce a row without it: it has a
default, or it is nullable, because an `INSERT` that omits a nullable column stores `NULL`. Put to
a real Postgres, omitting such a column is accepted and the stored row reads `NULL`, while omitting
a `NOT NULL` column with no default is refused by the server. Every generator answers this the same
way. An `IS NOT NULL` `CHECK` still makes a column required, because the shared column reader
reports it as not nullable before any schema is built. The runtime suite pins both directions:
`{ "email": "a@b.c" }` is accepted with `bio` absent and no null invented for it, and a body
missing `email` is rejected naming the field.

## Options

| Option                   | Default | Meaning                                                            |
| ------------------------ | ------- | ------------------------------------------------------------------ |
| `path`                   | `outDir` | where to write                                                    |
| `validation.library`     | `'zod'` | which library's schemas to emit: `zod`, `valibot` or `arktype`     |
| `naming.routerSuffix`    | `''`    | appended to the table name for the file name (`'Dto'` writes `usersDto.ts`) |
| `naming.procedureCase`   |         | casing for file names (`kebab` writes `users-dto.ts`)              |
| `importExtension`        | `'js'`  | how relative specifiers spell their extension                      |
| `format`, `outputHeader` |         | as every other generator                                           |

The numeric parameter spelling is the one all three libraries agree on row for row, so
switching `validation.library` does not change which numeric segments are accepted; the Date
edge cases differ per library as measured above. arktype objects take
`.onUndeclaredKey('delete')` so all three strip undeclared keys the way zod and valibot do by
default.

`validation.useShared`, `validation.importPath`, `validation.schemaSuffix` and
`validation.affix` are not read on this kind and the config warns if you set them: the DTO
modules are self-contained, because the class fields and the schema are generated from the same
columns and wrapping a schema another generator wrote would let the two drift.
`databaseInjection` and `includeRelations` warn too. There are no handlers here to inject a
database into, and relation lookups are routes, which this generator does not emit.

## A runnable config

```ts
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: 'src/db/schema.ts',
  outDir: 'src/dto',
  generators: [{ kind: 'nestjs', path: 'src/dto' }],
});
```

```bash
npx drzl generate
npx drzl watch --pipeline generate-nestjs
```

## See also

- [Hono Generator](/generators/hono), which carries the measured path-parameter grid the params
  DTOs are held to
- [Express Generator](/generators/express), whose emitted Standard Schema middleware is this
  pipe's older sibling
- [Fastify Generator](/generators/fastify), which shares the presence rule
- [Adapters (Overview)](/adapters/overview)
