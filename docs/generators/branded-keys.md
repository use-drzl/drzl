# Branded Keys

Give every primary key, and every foreign key pointing at one, a nominal type, so a `users.id`
cannot be passed where a `posts.id` is wanted.

```ts
{ kind: 'zod', path: 'src/validators/zod', branded: true }
```

Available on all five validation generators, off by default. With it off the emitted output is
byte-for-byte what it was before.

A whole config, with every generator that takes the option:

```ts
export default {
  schema: 'src/db/schema.ts',
  outDir: 'src/api',
  generators: [
    { kind: 'zod', path: 'src/validators/zod', branded: true },
    { kind: 'valibot', path: 'src/validators/valibot', branded: true },
    { kind: 'arktype', path: 'src/validators/arktype', branded: true },
    { kind: 'typebox', path: 'src/validators/typebox', branded: true },
    { kind: 'effect', path: 'src/validators/effect', branded: true },
  ],
};
```

## What it changes

For `users(id)` and `posts(id, authorId -> users.id)`, with zod:

```ts
export const SelectpostsSchema = z.object({
  id: z.number().int().brand<'posts.id'>(),
  authorId: z.number().int().brand<'users.id'>(),
  title: z.string(),
});

/** The nominal type of posts.id. */
export type PostsId = z.output<typeof SelectpostsSchema>['id'];
```

and then, in your own code:

```ts
declare function loadUser(id: UsersId): void;

loadUser(post.authorId); // fine: a post's author is a user's id
loadUser(post.id); // Type 'number & $brand<"posts.id">' is not assignable to
//                    parameter of type 'number & $brand<"users.id">'
loadUser(1); // Type 'number' is not assignable to ...
```

## Nothing happens at runtime

A brand is a marker in the type system and has no runtime existence whatever. Measured on zod
4.4.3, `.brand()` returns **the same schema object** it was called on, by identity, and
`schema.parse(1)` is `1`; valibot 1.4.2, arktype 2.2.3 and effect 3.x each hand the value back
unchanged too, and TypeBox's marker is a cast that leaves the schema object byte-identical. Two
branded ids holding `1` are still `===`.

So this option cannot change what a schema accepts or rejects, it adds nothing to your bundle
beyond the text of the call, and every check the schema already carried still runs. Everything it
buys is in the errors `tsc` prints.

## The brand name

`<export name>.<column>`, verbatim: `users.id`, `orgMembers.orgId`. Nothing is transformed,
singularised or re-cased, and that is the point. Two Drizzle tables cannot share an export name in
one schema module and two columns cannot share a name in one table, so the token is unique by
construction and there is no case where two tables collide after a transformation. It also reads
back as the thing you wrote, which is what makes the compiler error above legible.

The exported alias is the one thing that has to be a TypeScript identifier, and it is
`PascalCase(table) + PascalCase(column)`: `users.id` becomes `UsersId`. Two exports **can** collide
there, since `user_accounts` and `userAccounts` both pascal-case to `UserAccounts`. When they do,
neither alias is emitted and the run says so by name. The schemas are unaffected, because they
carry the token and never the alias; refer to the type as `SelectusersOutput['id']` instead, or
rename one of the tables.

`{ branded: { aliases: false } }` turns the aliases off and leaves the brands.

## What carries a brand

- **Every column of a primary key**, single or composite. A composite key's parts are branded
  one at a time, because one column at a time is what gets passed around.
- **Every foreign key column**, with the brand of the column it points at, resolved transitively.
  `posts.authorId` is a `users.id`, not a `posts.authorId`. This is where nearly all of the value
  is: without it, branding only stops you swapping two tables' own ids, and the ids actually
  flowing between your tables stay plain numbers.
- A column that is **both** a key of its own table and a foreign key gets the foreign one, which
  is what makes a join table keyed on two foreign keys come out right: `orgMembers(orgId, userId)`
  is `orgs.id` and `users.id`, not two brands nothing else in the schema produces.

`{ branded: { foreignKeys: false } }` brands only the keys themselves.

Nothing is branded when the answer is not certain, because a wrong brand compiles: it either makes
two unrelated ids interchangeable or two related ones incompatible, both worse than a plain number.
A brand is withheld, with a line on stderr naming the column, when the reference points outside the
analysis, at a column that is not a key, at a table name that is ambiguous across database schemas,
or around a cycle, and when the two ends of the chain disagree about their type.

## Which types actually change

The brand is on the **output** side of a schema, in every library that separates the two:

| library | insert type | select type |
| ------- | ----------- | ----------- |
| zod     | plain       | branded     |
| valibot | plain       | branded     |
| effect  | plain       | branded     |
| arktype | branded     | branded     |
| typebox | branded     | branded     |

zod, valibot and effect name their insert type from the schema's input type (`z.input`,
`InferInput`, `Schema.Encoded`), which a brand does not touch, so a caller building a write payload
writes plain numbers and only rows read back carry brands. ArkType and TypeBox name theirs from the
output type, arktype because `["infer"]` is the only inference the generator uses and TypeBox
because `Static<T>` is one type rather than two, so an insert payload there wants a branded id.
That difference is not caused by branding; branding is what makes it visible.

## Where the brand attaches, and why it matters

Innermost: on the column's own schema, **inside** the `nullable` and `optional` wrappers.

A brand is an intersection, and `null & { ... }` is `never`. So branding a schema that already
admits null silently deletes the null arm from the inferred type while the schema keeps parsing
null at runtime. Measured on zod 4.4.3:

```ts
z.number().nullable().brand<'users.id'>(); // infers number & $brand<"users.id">, no null
z.number().brand<'users.id'>().nullable(); // infers (number & $brand<"users.id">) | null
```

Only the second is true about a nullable foreign key, and no runtime test can tell them apart.
The same trap exists in valibot, effect and TypeBox, and DRZL emits the second form in all five.

Unlike `.meta()`, the position is otherwise free: `.brand()` is not a clone or a wrap, so nothing
after it can lose it.

## Interaction with `typedColumns`

They cannot both apply to one column, and branding wins.

[`typedColumns`](/generators/zod#typedcolumns) narrows a column's static type to
`typeof users.$inferSelect['id']`. Branding narrows the same type. Whichever is applied second
wins, and applying the brand to the reference instead runs into the null problem above, since a
nullable column's inferred type is `T | null` and intersecting that with a marker deletes the null.

So on a branded column the `typedColumns` reference is **not emitted at all**, rather than emitted
and overwritten. Nothing is lost for an ordinary key, whose branded type is Drizzle's inferred type
plus a marker. A key column declared with `.$type<T>()` is the one case where it costs something:
leave that column unbranded if you need `T`.

Every other column keeps its `typedColumns` reference as before.

## What TypeBox does

TypeBox has no brand. There is no `Type.Brand`, and nothing brand-shaped on `Type` at all, measured
by enumerating its keys on 0.34.52.

It can still express one, through `TUnsafe<T>`, TypeBox's own primitive for "this schema, that
static type", which the generator already uses for `typedColumns`. A branded file declares one
helper:

```ts
const drzlBrand = <T extends TSchema, B extends string>(schema: T, _brand: B) =>
  schema as unknown as TUnsafe<Static<T> & { readonly __drzlBrand: B }>;

export const SelectpostsSchema = Type.Object({
  id: drzlBrand(Type.Integer(), 'posts.id'),
  authorId: drzlBrand(Type.Integer(), 'users.id'),
});
```

The value handed back is the schema itself, so `Value.Check`, `TypeCompiler` and the JSON Schema
`JSON.stringify` produces are all unchanged, byte for byte.

The marker is a plain string-keyed property rather than a `unique symbol`, and that is not a
detail. A `unique symbol` is unique per _declaration_, so two generated files declaring one would
produce two brands TypeScript considers unrelated, and `posts.authorId` would not be assignable to
the `users.id` it points at. A structural marker is the same type in every file that writes it,
which is what lets the brands line up across modules with no import between them. The same property
makes the other four work without a shared module too.

## What it costs

Measured on a two-table schema with three branded columns, emitted source, per generator:

| generator | plain | branded |
| --------- | ----- | ------- |
| zod       | 3150  | 3834    |
| valibot   | 4724  | 5285    |
| arktype   | 2880  | 3203    |
| typebox   | 4634  | 5726    |
| effect    | 5326  | 5953    |

TypeBox pays most because it carries the helper declaration; the rest is the text of the calls.
None of it survives to runtime beyond what the module already shipped.

## What it does not reach

The oRPC and tRPC routers build their own key inputs, `z.object({ id: z.number() })`, from the
analysis rather than from your validator modules, so `input.id` inside a handler is a plain number
even with branding on. Point a router at the shared schemas with
`validation: { useShared: true, importPath: '../zod/index.js' }` and its `.input()` and `.output()`
become the branded ones, which is the configuration a generated project should use if it wants the
brands at its edges.

A generated project compiles either way. The generated service types its key as `id: number`, from
Drizzle rather than from the analysis, and a branded id is still a number, so every call into it
still typechecks. The direction a brand refuses is a plain number arriving where a branded one is
wanted, and no generated code does that: `.output()` is checked against a schema's _input_ type,
which is unbranded in zod, valibot and effect.
