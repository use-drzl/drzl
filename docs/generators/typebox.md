# TypeBox Generator

Generates [TypeBox](https://github.com/sinclairzx81/typebox) schemas per table (insert/update/select)
and an index barrel.

```ts
{ kind: 'typebox', path: 'src/validators/typebox' }
```

TypeBox is JSON Schema, so what the column declares becomes a schema keyword rather than a
chained call or an opaque predicate. That makes the output the most directly readable of the four
validators, and it means the schemas can be handed to anything that speaks JSON Schema.

## Example output

```ts
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

export const SelectpeopleSchema = Type.Object({
  id: Type.Integer({ minimum: -2147483648, maximum: 2147483647 }),
  age: Type.Integer({ minimum: 18, maximum: 2147483647 }),
  score: Type.Union([Type.Integer({ minimum: 0, maximum: 100 }), Type.Null()]),
  tier: Type.Literal('gold'),
  bio: Type.Union([Type.String(), Type.Null()]),
});

export type SelectpeopleOutput = Static<typeof SelectpeopleSchema>;
```

`age`, `score` and `tier` there are all CHECK constraints from the schema, folded into the type.

## Column constraints

| Column              | Emitted                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `varchar(255)`      | `Type.String({ maxLength: 255 })`                                      |
| `uuid()`            | `Type.String({ pattern: '...' })`                                      |
| `smallint()`        | `Type.Integer({ minimum: -32768, maximum: 32767 })`                    |
| `real()`            | `Type.Number({ minimum: -8388608, maximum: 8388607 })`                 |
| `doublePrecision()` | `Type.Number({ minimum: -140737488355328, maximum: 140737488355327 })` |

### Why uuid is a pattern and not a format

TypeBox does not validate `format` unless the consuming project has registered it on
`FormatRegistry` first. In a project that has not, `Type.String({ format: 'uuid' })` rejects every
valid uuid. A pattern needs no setup and behaves the same everywhere, so that is what is emitted.

## CHECK constraints

**No official Drizzle validator module enforces these**, in any library. TypeBox states them
declaratively:

| Constraint                        | Emitted                    |
| --------------------------------- | -------------------------- |
| `CHECK (age >= 18)`               | `minimum: 18`              |
| `CHECK (n > 0)`                   | `exclusiveMinimum: 0`      |
| `CHECK (score BETWEEN 0 AND 100)` | `minimum: 0, maximum: 100` |
| `CHECK (tier = 'gold')`           | `Type.Literal("gold")`     |

An equality becomes `Type.Literal`, not a `const` option. TypeBox accepts a `const` option on
`Type.String` and `Type.Integer` and then ignores it: `Type.String({ const: 'gold' })` validates
`'silver'` quite happily. Only `Type.Literal` actually enforces.

Nullability wraps the constrained type, so `Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])`
lets `null` through. That matches SQL, where a CHECK passes when it evaluates to TRUE **or NULL**.

Only unambiguous comparisons are translated; see
[Zod → CHECK constraints](/generators/zod#check-constraints) for what is skipped and why.

## Arrays and structured columns

A column declared with `.array()` becomes `Type.Array` of the element, with the element's own
constraints intact:

```ts
tags:   Type.Array(Type.String({ maxLength: 50 })),
scores: Type.Array(Type.Integer({ minimum: -32768, maximum: 32767 })),
```

| Column                      | Emitted                                                           |
| --------------------------- | ----------------------------------------------------------------- |
| `point()`, `geometry()`     | `Type.Tuple([Type.Number(), Type.Number()])`                      |
| `line()`                    | `Type.Tuple([...three...])`                                       |
| `vector({ dimensions: 3 })` | `Type.Array(Type.Number(), { minItems: 3, maxItems: 3 })`         |
| `bit({ dimensions: 3 })`    | `Type.String({ pattern: '^[01]*$', minLength: 3, maxLength: 3 })` |
| `bytea()`                   | `Type.Uint8Array()`                                               |
| `json()`, `jsonb()`         | a `Type.Recursive` `DrzlJsonValue`, declared once per file        |

A `bigint` column carries its range as bigint literals, `Type.BigInt({ minimum: -9223372036854775808n, maximum: 9223372036854775807n })`.
Written as plain numbers the bound would be wrong, since `9223372036854775807` rounds up the
moment it becomes a JS number.

## `typedJson`

```ts
{ kind: 'typebox', path: 'src/validators/typebox', typedJson: true }
```

Types `json` and `jsonb` columns from your schema using `Type.Unsafe<T>`, TypeBox's own escape
hatch for a static type it cannot narrow at runtime:

```ts
prefs: Type.Unsafe<(typeof settings.$inferSelect)["prefs"]>(Type.Unknown()),
```

See [Zod → typedJson](/generators/zod#typedjson) for why referencing Drizzle's inference works
where rebuilding the type does not.

## Why it cannot back an oRPC router

`validation.library` on an `orpc` generator takes `zod`, `valibot` or `arktype`, and not `typebox`.
oRPC types `.input()` and `.output()` as a [Standard Schema](https://standardschema.dev), and
neither `@sinclair/typebox` nor the newer `typebox` package implements that spec, while the other
three all do. A router handed a TypeBox schema would compile and then fail at runtime, so the
config rejects it rather than emitting one.

This is a limit of TypeBox, not of `drizzle-orm`: its own `drizzle-orm/typebox-legacy` module
works fine with `@sinclair/typebox`, and DRZL's output is measured against it on every CI run.

The generator itself is unaffected: TypeBox schemas are the right choice wherever you consume them
yourself, or hand them to something that speaks JSON Schema. Pair it with a `zod` generator if you
also want oRPC routers in the same project.

## Peer dependency

`@sinclair/typebox` >= 0.32, which your project provides.
