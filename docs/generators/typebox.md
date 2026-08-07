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

| Column              | Emitted                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `varchar(255)`      | `Type.Intersect([Type.String(), <code-point cap>])`, see below                                                          |
| `uuid()`            | `Type.String({ pattern: '...' })`                                                                                       |
| `smallint()`        | `Type.Integer({ minimum: -32768, maximum: 32767 })`                                                                     |
| `real()`            | `Type.Number({ minimum: -3.4028235677973366e38, maximum: 3.4028235677973366e38 })`, written out in full, inside a union |
| `doublePrecision()` | `Type.Number()`, with no magnitude bound, inside a union                                                                |

The two float rows are the database's answer rather than `drizzle-orm/typebox`'s. Postgres accepts
every double up to `3.4028235677973366e38` in a `real` and answers `out of range for type real` to
the next one, and it stored `Number.MAX_VALUE` in a `double precision` and handed it back unchanged.
On MySQL a `float()` is bounded lower, at `3.4028234663852886e38`, because a real MySQL 8.4 refuses
the next double after that one. See
[Zod → What the column declares](/generators/zod#what-the-column-declares-is-what-the-schema-enforces).

### `NaN` and the infinities

Postgres stores `NaN` and both infinities in either float width and returns them on SELECT, and
`Type.Number()` refuses all three: TypeBox's number check is `Number.isFinite`, and
`minimum`/`maximum` refuse an infinity whatever the numbers are. Those columns emit a union whose
second branch is a registered kind, the same `DrzlRowCheck` the character caps use, because TypeBox
has no `.refine` and `Type.Literal(NaN)` cannot work: it compares with `===` and `NaN === NaN` is
false.

```ts
c_real: Type.Union([
  Type.Number({ minimum: -3.4028235677973366e38, maximum: 3.4028235677973366e38 }),
  Type.Unsafe<number>({
    [Kind]: 'DrzlRowCheck',
    type: 'number',
    description: 'NaN, Infinity or -Infinity, which this column stores',
    assert: (v: any) => typeof v === 'number' && !Number.isFinite(v),
  }),
]),
```

Both `Value.Check` and `TypeCompiler` honour the registered kind. The cost is in serialisation: JSON
Schema has no `NaN` and no `Infinity`, so the branch carries a bare `type: 'number'` and a
`JSON.stringify` of the schema describes a number that may sit outside the stated range. A
`numeric({ mode: 'number' })` column emits the same shape with a `Number.isNaN` predicate, since
Postgres refuses an infinity in any `numeric` carrying a precision.

### Why uuid is a pattern and not a format

TypeBox does not validate `format` unless the consuming project has registered it on
`FormatRegistry` first. In a project that has not, `Type.String({ format: 'uuid' })` rejects every
valid uuid. A pattern needs no setup and behaves the same everywhere, so that is what is emitted.

## CHECK constraints

**No official Drizzle validator module enforces these**, in any library. TypeBox states them
declaratively:

| Constraint                        | Emitted                     |
| --------------------------------- | --------------------------- |
| `CHECK (age >= 18)`               | `minimum: 18`               |
| `CHECK (n > 0)`                   | `exclusiveMinimum: 0`       |
| `CHECK (score BETWEEN 0 AND 100)` | `minimum: 0, maximum: 100`  |
| `CHECK (tier = 'gold')`           | `Type.Literal("gold")`      |
| `CHECK (cardinality(tags) >= 2)`  | `minItems: 2`               |
| `CHECK (status IN ('a', 'b'))`    | `Type.Union([...literals])` |

A bound **replaces** the end of the declared range it narrows rather than sitting beside it: a
CHECK can only narrow, never widen, since the range is the column's type.

### What goes on the object

Two constraints have no keyword at all, and both become branches of an intersection carrying a
registered kind:

```ts
export const SelecttSchema = Type.Intersect([
  Type.Object({ ... }),
  Type.Unsafe<unknown>({
    [Kind]: 'DrzlRowCheck',
    description: 'order: lo < hi',
    assert: (o: any) => o == null || o['lo'] == null || o['hi'] == null || o['lo'] < o['hi'],
  }),
]);
```

- **`CHECK (lo < hi)`** compares two columns, so no field can decide it. Both sides are
  null-guarded, matching SQL.
- **`CHECK (length(name) >= 3)`** counts characters, and `minLength` counts UTF-16 code units.

Intersecting is what keeps the properties checked. Setting the kind on the object itself parses,
enforces the predicate, and **silently stops validating the fields**, so `{ lo: 'x' }` passes.
Both `Value.Check` and `TypeCompiler` honour the intersection.

Serialising to JSON Schema stays valid: the branch carries no keywords, so it renders as a schema
that accepts everything, keeping its `description` so a reader still learns the rule.

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
// varchar(50).array(): the cap limits each entry, so it is intersected onto the element.
tags:   Type.Array(Type.Intersect([Type.String(), /* at most 50 characters */])),
scores: Type.Array(Type.Integer({ minimum: -32768, maximum: 32767 })),
```

| Column                      | Emitted                                                           |
| --------------------------- | ----------------------------------------------------------------- |
| `point()`, `geometry()`     | `Type.Tuple([Type.Number(), Type.Number()])`                      |
| `point({ mode: 'xy' })`     | `Type.Object({ x: Type.Number(), y: Type.Number() })`             |
| `line()`                    | `Type.Tuple([...three...])`                                       |
| `line({ mode: 'abc' })`     | `Type.Object({ a, b, c })`                                        |
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

## `standardSchema`

```ts
{ kind: 'typebox', path: 'src/validators/typebox', standardSchema: true }
```

Gives every emitted schema a `~standard` key, so it can be handed straight to a tRPC or oRPC
route. Off by default: generated code ships in your bundle, and a project that never builds a
router should not carry a validator nothing calls.

tRPC and oRPC both recognise an input parser by way of
[Standard Schema](https://standardschema.dev). zod, valibot, arktype and Effect all put a
`~standard` on what they build; `@sinclair/typebox` does not, and exports nothing that would add
one. That is the whole of the gap, and this option closes it.

### What it emits

One extra module, `standard-schema.ts`, is written beside your schemas and exported from the
barrel. Each table module imports one function from it and calls it around each schema:

```ts
import { toStandardSchema } from './standard-schema.js';

export const InsertusersSchema = toStandardSchema(
  Type.Object({
    id: Type.Integer({ minimum: -2147483648, maximum: 2147483647 }),
    email: Type.Intersect([
      Type.String(),
      Type.Unsafe<unknown>({
        [Kind]: 'DrzlRowCheck',
        description: 'at most 254 characters',
        assert: (v: any) => typeof v !== 'string' || [...v].length <= 254,
      }),
    ]),
  })
);
```

The key is defined **non-enumerably on the schema itself**, so nothing you already do with these
schemas changes. `Value.Check`, `TypeCompiler`, `Static<typeof X>` and `Object.keys` all see
exactly what they saw before, and `JSON.stringify` still produces the same JSON Schema document
byte for byte. There is no second export to import and no name to learn.

The `vendor` is `drzl/typebox`, not `typebox`. DRZL implements this, not TypeBox, and a tool that
special-cases a vendor should not mistake one for the other.

### Backing a tRPC router

```ts
import { initTRPC } from '@trpc/server';
import { InsertusersSchema, SelectusersSchema } from './validators/typebox/index.js';

const t = initTRPC.create();

export const appRouter = t.router({
  createUser: t.procedure
    .input(InsertusersSchema)
    .output(SelectusersSchema)
    .mutation(({ input }) => createUser(input)),
});

export type AppRouter = typeof appRouter;
```

`inferRouterInputs<AppRouter>['createUser']` comes back as the real shape, not `unknown`:

```ts
{
  id: number;
  email: string;
  displayName?: string | null | undefined;
  active?: boolean | undefined;
  bio?: string | null | undefined;
}
```

That matters more than the runtime half. A wrapper with a working `validate` and no `types` gives
a router that validates correctly and infers `unknown` on the client, which is worse than useless
in tRPC, where the whole client API is inferred from the router type.

oRPC is the same call: `os.input(InsertusersSchema).output(SelectusersSchema).handler(...)`, and
`RouterClient<typeof router>` infers the same shape.

### The errors you get

A rejected value becomes `issues`, each with a message and a path array. Constraints TypeBox can
only express as a registered kind, which is how DRZL states a character cap or a row-level CHECK,
report what the constraint says rather than `Expected kind 'DrzlRowCheck'`:

| input                                 | first issue                                                      |
| ------------------------------------- | ---------------------------------------------------------------- |
| `{ id: 7, email: 123 }`               | `Expected string` at `["email"]`                                 |
| `{ id: 7, email: 'x'.repeat(255) }`   | `at most 254 characters` at `["email"]`                          |
| `{ id: 1.5, email: 'a@b.co' }`        | `Expected integer` at `["id"]`                                   |
| `{ id: 3000000000, email: 'a@b.co' }` | `Expected integer to be less or equal to 2147483647` at `["id"]` |

Array indices are reported as numbers, matching zod, valibot and arktype, so code that switches on
`typeof segment` behaves the same whichever generator produced the schema.

### Using it with an `orpc` or `trpc` generator

`validation.library` on an `orpc` or `trpc` generator still takes `zod`, `valibot` or `arktype`.
Those generators write the router **for** you and have no TypeBox dialect: they need to emit
`z.object({ id: z.number() })` for a lookup argument, and there is no TypeBox spelling of that in
their tables. `standardSchema` closes the Standard Schema gap, which was the stated reason TypeBox
was excluded, but wiring it into the router generators is separate work.

Until then, a TypeBox router is one you write yourself, as above, against schemas DRZL generated.

### The runnable config

```ts
export default {
  schema: 'src/db/schema.ts',
  generators: [{ kind: 'typebox', path: 'src/validators/typebox', standardSchema: true }],
};
```

## Character limits count characters

A `varchar(n)` limit is n **characters**, in both Postgres and MySQL. TypeBox's `maxLength` counts
UTF-16 code units, which is a different measurement: a `varchar(10)` column accepts ten emoji and
`maxLength: 10` refuses eight of them. JSON Schema defines the keyword in code points, so this is
TypeBox's implementation rather than the spec, but the effect is the same.

That is the direction that breaks working code, so the keyword is not used. The cap is intersected
onto the field as a registered kind, which counts code points:

```ts
name: Type.Intersect([
  Type.String(),
  Type.Unsafe<unknown>({
    [Kind]: 'DrzlRowCheck',
    description: 'at most 255 characters',
    assert: (v: any) => v == null || [...v].length <= 255,
  }),
]),
```

For an array column it goes on the element, since `varchar(50).array()` limits each entry rather
than the list.

The trade is that this cap does not survive `JSON.stringify` into a JSON Schema, where a bare
`maxLength` would. Emitting a number that means something else in a form that serialises is not a
better trade. If you want the document, the
[JSON Schema generator](/generators/json-schema) emits one directly.

MySQL's TEXT family is a byte budget rather than a character count, and gets a branch counting
encoded bytes. Both are honoured by `Value.Check` and by `TypeCompiler`, and all four generators
agree on every one of them, checked against Postgres, SQLite and MySQL on every commit.

See [Zod, character limits](/generators/zod#character-limits-count-characters) for the
measurements against the databases.

## `applyDefaults`

Drizzle knows what a column defaults to, and `drizzle-orm` reproduces none of them.

```ts
{ kind: 'typebox', path: 'src/validators/typebox', applyDefaults: true }
```

```ts
country: Type.Optional(Type.String({ default: 'GB' })),
```

Only **literal** defaults. `defaultNow()`, `defaultRandom()` and any `sql` default are evaluated
by the database, and `$defaultFn` is called by Drizzle at insert time, so those stay optional: a
schema guessing at them would produce a different value than the one actually stored.

Insert only, and off by default, because it changes what parsing _returns_ rather than only what
it accepts.

`Value.Check` deliberately does **not** materialise a default, only `Value.Parse` and
`Value.Default` do: TypeBox separates validating from defaulting where zod and valibot fold the
two together.

## `typedColumns`

`.$type<T>()` is a compile-time cast on any column, so `text().$type<'admin' | 'member'>()` is an
ordinary string to anything reading it at runtime and the narrowing is lost.

```ts
{ kind: 'typebox', path: 'src/validators/typebox', typedColumns: true }
```

```ts
role: Type.Unsafe<(typeof users.$inferSelect)['role']>(
  Type.Intersect([Type.String(), /* at most 50 characters */])
),
```

`Type.Unsafe<T>` wraps the existing schema, so every check it carried still runs and only the
inferred type is replaced. Implies `typedJson`. Off by default.

## Peer dependency

`@sinclair/typebox` >= 0.32, which your project provides.

## `duplicateFinder`

Uniqueness is the one constraint a per-row validator structurally cannot check: whether a value is
unique is a fact about the table, not about the row. No first-party validator attempts it, and
neither does a schema here.

What needs no database is whether a **batch collides with itself**, and that is the half you can
fix before sending anything. It matters for a bulk insert, where a thousand rows fail whole on one
collision and the error names a constraint rather than a row.

```ts
{ kind: 'typebox', path: 'src/validators/typebox', duplicateFinder: true }
```

emits, for a table with unique constraints:

```ts
export function findDuplicateusers(
  rows: readonly InsertusersInput[]
): Array<{ index: number; constraint: string; firstIndex: number }> { ... }
```

```ts
findDuplicateusers([
  { email: 'a@b.co', org: 'x', handle: 'h' },
  { email: 'a@b.co', org: 'y', handle: 'h' },
]);
// [{ index: 1, constraint: 'email', firstIndex: 0 }]
```

Two details it follows:

- **Null is not equal to null.** A constraint is skipped for any row where one of its columns is
  null or absent, because a unique index accepts any number of NULLs. Reporting those would send
  you chasing rows the database is perfectly happy with.
- **Composite keys compare by value.** The key is JSON, so `[1, '2']` never collides with
  `['1', 2]`, which a separator-joined key would.

A batch that passes can still collide with rows already stored. This checks the half that needs no
round trip.

Off by default: generated code ships in your bundle.

## Nested relation schemas

`nestedSchemas: true` also emits `NestedInsert<Table>` and `NestedSelect<Table>`, the table plus one
key per relation, so `{ ...user, posts: [...] }` can be validated whole. Nothing in the Drizzle
ecosystem describes that payload, and `db.insert` drops the relation key silently rather than
refusing it. See [Nested Relation Schemas](/generators/nested-relations).
