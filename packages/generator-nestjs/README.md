# @drzl/generator-nestjs

Generate [NestJS](https://nestjs.com) DTO and entity classes from a Drizzle schema: per table,
the insert, update, select and params shapes as plain classes whose fields state the parsed
result and whose `static schema` carries a Standard Schema v1 validator, plus a small emitted
`SchemaValidationPipe` that runs it. The controllers stay yours.

## Why plain classes, not class-validator decorators

Settled from the registry and from measurement rather than taste. `@nestjs/common` lists
class-validator and class-transformer as optional peers, and class-transformer, the half that
would convert wire values, last published in 2021. Measured on class-validator 0.15.1: what a
decorator DTO accepts depends on the consumer's pipe options rather than the DTO
(`enableImplicitConversion` reads `""` as 0, `"0x10"` as 16 and `"1e5"` as 100000, the exact
family DRZL's route generators refuse); `@IsOptional()` cannot tell `{ bio: null }` from `{}`;
bigint has no story at all; and `@Type(() => Date)` accepts `"1"` as the year 2001. A static
schema carries its policy with it, and no pipe option can loosen it.

The plain classes also compile under every tsconfig: no `experimentalDecorators` needed in the
generated files (class-validator decorators fail TS1240 without it, measured). Your app keeps
its standard Nest flags; the generated code does not require them.

## Install

```bash
npm install -D @drzl/generator-nestjs
```

The generated code imports `@nestjs/common` (which a Nest app has by definition) and the
validation library you chose: zod by default, valibot or arktype via `validation.library`.

## Configure

```ts
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: 'src/db/schema.ts',
  outDir: 'src/dto',
  generators: [{ kind: 'nestjs', path: 'src/dto' }],
});
```

## Consume

```ts
import { Body, Controller, Param, Patch, Post } from '@nestjs/common';
import { CreateUsersDto, UpdateUsersDto, UsersParamsDto } from './dto/index.js';

@Controller('users')
export class UsersController {
  @Post()
  create(@Body() body: CreateUsersDto) {
    // body is the parsed output: undeclared keys stripped, wire forms transformed.
  }

  @Patch(':id')
  update(@Param() params: UsersParamsDto, @Body() body: UpdateUsersDto) {
    // params.id is a real number, parsed by the strict segment schema.
  }
}
```

```ts
import { SchemaValidationPipe } from './dto/index.js';

app.useGlobalPipes(new SchemaValidationPipe());
```

## The shape of the DTOs

- `Create<T>Dto` is the insert shape: generated columns absent, defaulted columns optional, and
  a nullable column with no default required, null spelled out. Null is a value; omitting the
  key is not sending null.
- `Update<T>Dto` is all-optional with the primary key columns excluded, so an `id` in a PATCH
  body is an undeclared key and is stripped.
- `<T>ParamsDto` parses key segments strictly: `^-?\d+(\.\d+)?$` into a number, digits kept as
  a string for bigint, strict ISO datetime into a Date, the member set for an enum. The
  `Number('')` family (`""`, `" "`, `"0x10"`, `"1e5"`) is refused; Nest's own ParseIntPipe is
  nearly as strict but silently rounds `"9007199254740993"` (measured).
- `<T>Entity` is one row at its select shape. Date columns are `Date`; bigint columns stay
  digit strings on both sides, because `JSON.stringify` throws on a real bigint.
- Every class pairs with its schema through a typed static, so schema-vs-field drift is a
  compile error inside the generated file. The pipe validates any class carrying one and passes
  everything else through untouched.

## Docs

https://use-drzl.github.io/drzl/generators/nestjs

## License

Apache-2.0
