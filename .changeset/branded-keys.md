---
'@drzl/validation-core': minor
'@drzl/generator-zod': minor
'@drzl/generator-valibot': minor
'@drzl/generator-arktype': minor
'@drzl/generator-typebox': minor
'@drzl/generator-effect': minor
'@drzl/cli': minor
---

Emitted validators can now give every key a nominal type, so a `users.id` cannot be passed where a
`posts.id` is wanted.

`{ kind: 'zod', path: 'src/validators/zod', branded: true }`, on all five validation generators.

```ts
export const SelectpostsSchema = z.object({
  id: z.number().int().brand<'posts.id'>(),
  authorId: z.number().int().brand<'users.id'>(),
});

export type PostsId = z.output<typeof SelectpostsSchema>['id'];
```

```ts
loadUser(post.authorId); // fine
loadUser(post.id); // Type 'number & $brand<"posts.id">' is not assignable to
//                    parameter of type 'number & $brand<"users.id">'
```

**Nothing happens at runtime.** Measured on zod 4.4.3, `.brand()` returns the same schema object it
was called on, by identity, and `parse(1)` is `1`; valibot 1.4.2, arktype 2.2.3 and effect 3.x all
hand the value back unchanged, and TypeBox's marker is a cast that leaves the schema object
byte-identical. So this cannot change what a schema accepts, and the whole feature is what `tsc`
prints. It is proved that way: the test suite compiles generated modules and asserts that
`@ts-expect-error` on each rejection is used, that the same file without the directives produces
exactly those errors, and that the identical calls against unbranded output produce none.

**Foreign keys carry the brand of the column they reference**, resolved transitively, and that beats
the column being part of its own table's key. `posts.authorId` is a `users.id`; a join table keyed
on `(orgId, userId)` is `orgs.id` and `users.id`, not two brands nothing else produces. Without this
the feature would only stop you swapping two tables' own ids, while every id actually flowing
between your tables stayed a plain number.

**The brand token is `<export name>.<column>`, verbatim.** Nothing is transformed, so the token is
unique by construction and two tables cannot collide after a transformation. The exported alias has
to be an identifier and is `PascalCase(table) + PascalCase(column)`; `user_accounts` and
`userAccounts` do collide there, and when they do neither alias is emitted and the run says so. The
schemas are unaffected, because they carry the token and never the alias.

**The brand goes inside the `nullable` and `optional` wrappers**, and that is the one decision that
could be wrong while still compiling. A brand is an intersection and `null & { ... }` is `never`, so
`z.number().nullable().brand<'users.id'>()` infers `number & $brand<"users.id">` with the null arm
silently gone while `.parse(null)` still returns null. The same trap is in valibot, effect and
TypeBox. All five emit `(number & brand) | null`.

**`typedColumns` is not emitted for a branded column.** Both narrow the same column's static type and
whichever runs second wins, and applying the brand to the reference hits the null problem above. The
brand wins outright rather than the two being emitted to fight; nothing is lost for an ordinary key,
whose branded type is Drizzle's inferred type plus a marker. A key declared with `.$type<T>()` is the
one case that costs something, and it is documented.

**TypeBox has no brand at all** and still expresses one. There is no `Type.Brand` and nothing
brand-shaped on `Type`, measured on 0.34.52 by enumerating its keys. What it has is `TUnsafe<T>`, its
own primitive for "this schema, that static type", which the generator already uses for
`typedColumns`. A branded file declares one helper whose value is the schema itself, so `Value.Check`,
`TypeCompiler` and the JSON Schema `JSON.stringify` produces are all unchanged. The marker is a
string-keyed property rather than a `unique symbol` on purpose: a `unique symbol` is unique per
declaration, so two generated files would produce two unrelated brands and a foreign key would not be
assignable to the key it points at.

**Which types change differs by library, and branding only makes it visible.** zod, valibot and effect
name their insert type from the schema's _input_ type, which a brand does not touch, so writes stay
plain and only rows read back carry brands. ArkType and TypeBox name theirs from the output type, so
an insert payload there wants a branded id.

Off by default: it changes the inferred type of every consumer of the select schemas, which is the
point, but it is a change to existing call sites rather than an addition. A full generated project,
validators for all five libraries plus a service and both routers, typechecks with it on under
`nodenext` with `noUnusedLocals`: the generated service types its key as `id: number` from Drizzle,
and a branded id is still a number, so every call into it still compiles. Emitted source grows about
10%, all of it text, none of it reaching runtime.
