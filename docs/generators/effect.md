# Effect Generator

Generates [Effect Schema](https://effect.website/docs/schema/introduction/) validators per table
(insert/update/select) and an index barrel.

```ts
{ kind: 'effect', path: 'src/validators/effect' }
```

A runnable configuration:

```ts
export default {
  schema: 'src/db/schema.ts',
  outDir: 'src/api',
  generators: [{ kind: 'effect', path: 'src/validators/effect' }],
};
```

## Which Effect

`effect` 3.x, imported as `effect/Schema` from the core package.

Not `@effect/schema`. That standalone package stopped at 0.75.5 and predates Schema moving into
core, so it is not a target.

Not the 4.0 beta either. `effect@4` exists only as `4.0.0-beta.*`, and everything this generator
emits was measured against 3.x. The floor is **3.13.0**, which is where `Schema.standardSchemaV1`
first appears; 3.12.0 does not have it.

::: warning `effect` is an optional peer
It is the one validation generator here whose validator peer is optional, and that is deliberate.
`drizzle-orm@1.0.0-rc.4` declares its own optional peer on `effect` as
`>=4.0.0-beta.83 || >=4.0.0`, so drizzle's first-party effect module targets the 4.0 beta while
this generator targets 3.x, and the two ranges do not overlap. npm installs a _required_ peer
automatically, so declaring one made `npm install @drzl/cli drizzle-orm@1.0.0-rc.4` fail with
`ERESOLVE` for everyone, not only for users of this generator.

Install `effect` yourself alongside it:

```sh
npm install effect
```

:::

## Example output

```ts
import * as Schema from 'effect/Schema';

export const SelectpeopleSchema = Schema.Struct({
  id: Schema.Int.pipe(
    Schema.greaterThanOrEqualTo(-2147483648),
    Schema.lessThanOrEqualTo(2147483647)
  ),
  name: Schema.String.pipe(
    Schema.filter((v) => [...v].length <= 50, { description: 'at most 50 characters' })
  ),
  age: Schema.NullOr(Schema.Int.pipe(Schema.greaterThanOrEqualTo(18))),
  bio: Schema.NullOr(Schema.String),
});

export type SelectpeopleOutput = Schema.Schema.Type<typeof SelectpeopleSchema>;

export const StandardSelectpeopleSchema = Schema.standardSchemaV1(SelectpeopleSchema);
```

`age >= 18` there is a CHECK constraint from the schema, folded into the column's lower bound.

## Two forms per schema, and why

Every schema is exported twice.

`SelectpeopleSchema` is a plain `Schema.Struct`. It is the one that composes: `Schema.pick`,
`Schema.omit` and spreading into a wider `Schema.Struct` all go through `.fields`, and it is the
one `Schema.Schema.Type<typeof …>` names the row from.

`StandardSelectpeopleSchema` is `Schema.standardSchemaV1(…)` of the same thing. A bare
`Schema.Struct` carries no `~standard` key, so it cannot be handed to a tRPC or oRPC route
directly. The wrapper carries a real Standard Schema v1 with vendor `effect`, and it is what an
adapter wants. It does **not** keep `.fields`, so it is not a replacement for the bare form.

Neither substitutes for the other, so both are emitted rather than one being chosen or put behind
an option. The wrapper costs one call per schema, measured at 24 microseconds per thousand, and
255 bytes across the three schemas of a table.

TypeBox reaches the same place by a different road. Nothing in `@sinclair/typebox` implements the
spec, so DRZL implements it: [`standardSchema`](/generators/typebox#standardschema) attaches a
`~standard` to the schema in place rather than exporting a second form, which it can do because a
TypeBox schema is a plain object and nothing is lost by adding a key to it. Effect cannot, since
`Schema.standardSchemaV1` returns an object that has dropped `.fields`.

Neither library is wired into `validation.library` on the tRPC and oRPC generators yet. That is a
separate change: those generators write the router for you and have no dialect for either.

## Column constraints

| Column              | Emitted                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------- |
| `varchar(255)`      | `Schema.String.pipe(Schema.filter(...))`, a code-point cap, see below                   |
| `uuid()`            | `Schema.UUID`                                                                           |
| `smallint()`        | `Schema.Int.pipe(Schema.greaterThanOrEqualTo(-32768), Schema.lessThanOrEqualTo(32767))` |
| `doublePrecision()` | `Schema.Finite`, inside a union, see below                                              |
| `bigint()`          | `Schema.BigIntFromSelf` with `…Bigint` bounds, so a 64 bit bound stays exact            |
| `timestamp()`       | `Schema.ValidDateFromSelf`, in a union where `coerceDates` applies                      |
| `jsonb()`           | a recursive `DrzlJsonValue` emitted once per file                                       |
| `bytea()`           | `Schema.Uint8ArrayFromSelf`                                                             |
| `text().array()`    | `Schema.Array(<element>)`                                                               |

### Character limits count characters

`Schema.maxLength` counts UTF-16 code units, and both Postgres and MySQL count a `varchar(n)` in
characters. Ten thumbs-up characters are a valid row in a `varchar(10)` and `Schema.maxLength(10)`
refuses it. So a cap is emitted as a `Schema.filter` over `[...v].length`, which counts code
points, and it agrees with the database at 10 and at 11 alike.

MySQL's TEXT family is a byte budget rather than a character count, and that is emitted as a
`TextEncoder` predicate for the same reason: no keyword counts either measurement.

The cost is that a cap does not survive serialisation through `effect/JSONSchema`, which drops a
filter carrying no `jsonSchema` annotation. Emitting a number that means a different measurement in
a form that serialises is not a better trade.

### `NaN` and the infinities run the other way here

`z.number()` and `Type.Number()` refuse `NaN` and both infinities, so the Zod and TypeBox
generators only ever _add_ branches for a column that stores them.

`Schema.Number` **accepts** all three. So this generator builds on `Schema.Finite`, which refuses
all three, and does it unconditionally rather than leaving it to the column's range: `Infinity >= 0`
is true, so a lower bound alone excludes nothing.

Where the analyzer says a column really does store them, the branches are added back beside the
range, because no range can hold either value:

```ts
score: Schema.Union(
  Schema.Finite,
  Schema.Number.pipe(
    Schema.filter((v) => Number.isNaN(v), { description: 'NaN, which this column stores' })
  ),
  Schema.Literal(Infinity, -Infinity)
),
```

`Schema.Literal` holds an infinity because Effect compares a literal with `===`. It cannot hold
`NaN`, which is not equal to itself, so that branch is a predicate.

### CHECK constraints

A comparison against a literal folds into the column's bound. Everything else the shared parser
understands becomes a `Schema.filter`:

| CHECK                    | Emitted                                       |
| ------------------------ | --------------------------------------------- |
| `age >= 18`              | folded into `Schema.greaterThanOrEqualTo(18)` |
| `status IN ('a','b')`    | `Schema.Literal('a', 'b')`                    |
| `kind = 'fixed'`         | `Schema.Literal('fixed')`                     |
| `kind <> 'banned'`       | a `Schema.filter`                             |
| `length(name) >= 3`      | a `Schema.filter` counting code points        |
| `cardinality(tags) >= 2` | a `Schema.filter` on the array                |
| `start_date < end_date`  | a `Schema.filter` on the `Schema.Struct`      |

`<>` is one place this says more than the TypeBox generator, which leaves it unstated for want of a
JSON Schema keyword. A filter states it exactly.

A check sits on the base type, inside the nullable wrapper, so `null` skips it. That reproduces
SQL, where a CHECK passes when it evaluates to TRUE **or NULL**.

### Nullable is not optional

`Schema.NullOr` takes `null` and still requires the key. `Schema.optional` lets the key go missing
and refuses `null`. A nullable column on select gets the first; on insert and update it gets both.

### A column the analyzer cannot type

A `customType`, a column whose type nothing can name, and a json column without
[`typedJson`](/guide/configuration) all emit `Schema.Unknown`.

One limitation is worth stating outright, because no arrangement here removes it: a
`Schema.Unknown` field **accepts a missing key**, since a missing key reads as `undefined` and
`Schema.Unknown` accepts `undefined`. So such a column is optional in practice even on select.
TypeBox is in the same position. Run [`drzl doctor`](/cli/doctor) to see which columns those are.

## `typedJson` and `typedColumns`

`.$type<T>()` is a compile-time cast, so no runtime-derived validator can see it. Both options make
the emitted module import your schema back and reference what Drizzle inferred.

Effect has no `Type.Unsafe` to hang that on, so the reference goes on as a cast:

```ts
role: Schema.UUID as unknown as Schema.Schema<(typeof users.$inferSelect)['role']>,
```

The cast exists only at compile time, so every runtime check the wrapped schema carried still runs.
`typedJson` covers only the columns with no runtime type, where the reference _replaces_ the schema;
`typedColumns` narrows every column and implies `typedJson`.

## `duplicateFinder`

Uniqueness is the one constraint a per-row validator structurally cannot check: whether a value is
unique is a fact about the table, not about the row. No first-party validator attempts it, and
neither does a schema here.

What needs no database is whether a **batch collides with itself**, and that is the half you can
fix before sending anything. It matters for a bulk insert, where a thousand rows fail whole on one
collision and the error names a constraint rather than a row.

```ts
{ kind: 'effect', path: 'src/validators/effect', duplicateFinder: true }
```

emits, for a table with a primary key or unique constraints:

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

The emitted function is plain TypeScript with no Effect import, identical to what the other four
validator generators emit. Three details it follows:

- **The primary key counts.** The database enforces it with a unique index and its own error says
  so: two rows sharing an explicit key fail with `duplicate key value violates unique constraint
  "users_pkey"` (23505, measured on Postgres 17). Seed fixtures carry explicit keys so that
  foreign keys can point at known rows, which makes this the collision bulk data actually has.
  Rows that leave a generated key to the database report nothing on it.
- **Null is not equal to null.** A constraint is skipped for any row where one of its columns is
  null or absent, because a unique index accepts any number of NULLs. Reporting those would send
  you chasing rows the database is perfectly happy with.
- **Composite keys compare by value.** The key is JSON, so `[1, '2']` never collides with
  `['1', 2]`, which a separator-joined key would.

A batch that passes can still collide with rows already stored. This checks the half that needs no
round trip. The [seeding recipe](/examples/seed) composes the finder with the emitted schemas into
a checked bulk-insert pipeline: validate, dedupe, order by foreign keys, chunk, commit.

Off by default: generated code ships in your bundle.
