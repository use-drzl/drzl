---
'@drzl/cli': minor
'@drzl/generator-zod': minor
'@drzl/validation-core': minor
---

Two things no runtime-derived validator can do.

### `typedJson`: json columns typed from your schema

`.$type<T>()` is a compile-time cast. Drizzle implements it as `$type() { return this }`, so
nothing about the declared type survives to runtime and every runtime-derived validator is blind
to it. `drizzle-orm/zod` types a json column as its generic `Json` whatever you wrote, and that
is the highest-reaction open issue on the repository.

A generator does not have to resolve the type itself, because Drizzle already did:

```ts
prefs: z.custom<(typeof settings.$inferSelect)["prefs"]>(),
```

`typeof settings.$inferSelect['prefs']` *is* the declared type, resolved by TypeScript at the
point of use. So generics, unions and imported interfaces all work, which are exactly the cases
that defeat approaches that parse the source and rebuild the type. Insert and select reference
their own inference, since a defaulted json column is optional on insert and its type differs.

Enable per generator:

```ts
{ kind: 'zod', path: 'src/validators/zod', typedJson: true }
```

Off by default: it adds an `import type` of your schema module to the generated file. That import
is erased at build time, so it adds no runtime dependency and cannot create a runtime cycle, but
the coupling should still be a choice.

Verified by compiling the result: `z.infer<typeof SelectsettingsSchema>['prefs']` is the declared
type, a wrong shape is a type error, and it is assignable back to the original interface.

### `drzl generate --check`: drift detection for CI

```bash
drzl generate --check
```

Regenerates and fails if the result differs from what is committed, naming every file:

```
Generated output is out of date (2 file(s)):
  ~ changed  src/validators/zod/people.zod.ts
  + added    src/validators/zod/extra.zod.ts
```

Exits 1 on drift and 0 when current. It catches the two things that actually happen, someone
editing generated files by hand and someone changing the schema without regenerating, and it
catches them in CI rather than in review.

This is only available to a code generator. Runtime modules derive their schemas in memory at
import time, so there is nothing on disk to have drifted and nothing to compare.

**It never modifies your working tree.** Redirecting output to a temporary directory would not
work, since generated files contain paths computed relative to their own location and every file
would report as drifted. So the real directories are snapshotted, regeneration is allowed to
overwrite them, and the snapshot is restored either way, including deleting anything the run
created.
