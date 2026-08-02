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
  tier: Type.Literal("gold"),
  bio: Type.Union([Type.String(), Type.Null()]),
});

export type SelectpeopleOutput = Static<typeof SelectpeopleSchema>;
```

`age`, `score` and `tier` there are all CHECK constraints from the schema, folded into the type.

## Column constraints

| Column | Emitted |
|---|---|
| `varchar(255)` | `Type.String({ maxLength: 255 })` |
| `uuid()` | `Type.String({ pattern: '...' })` |
| `smallint()` | `Type.Integer({ minimum: -32768, maximum: 32767 })` |
| `doublePrecision()` | `Type.Number()` |

### Why uuid is a pattern and not a format

TypeBox does not validate `format` unless the consuming project has registered it on
`FormatRegistry` first. In a project that has not, `Type.String({ format: 'uuid' })` rejects every
valid uuid. A pattern needs no setup and behaves the same everywhere, so that is what is emitted.

## CHECK constraints

**No official Drizzle validator module enforces these**, in any library. TypeBox states them
declaratively:

| Constraint | Emitted |
|---|---|
| `CHECK (age >= 18)` | `minimum: 18` |
| `CHECK (n > 0)` | `exclusiveMinimum: 0` |
| `CHECK (score BETWEEN 0 AND 100)` | `minimum: 0, maximum: 100` |
| `CHECK (tier = 'gold')` | `Type.Literal("gold")` |

An equality becomes `Type.Literal`, not a `const` option. TypeBox accepts a `const` option on
`Type.String` and `Type.Integer` and then ignores it: `Type.String({ const: 'gold' })` validates
`'silver'` quite happily. Only `Type.Literal` actually enforces.

Nullability wraps the constrained type, so `Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])`
lets `null` through. That matches SQL, where a CHECK passes when it evaluates to TRUE **or NULL**.

Only unambiguous comparisons are translated; see
[Zod → CHECK constraints](/generators/zod#check-constraints) for what is skipped and why.

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

## Peer dependency

`@sinclair/typebox` >= 0.32, which your project provides.
