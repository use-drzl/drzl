---
'@drzl/validation-core': minor
'@drzl/generator-zod': minor
'@drzl/generator-valibot': minor
'@drzl/generator-arktype': minor
'@drzl/generator-orpc': minor
'@drzl/cli': minor
---

Add `affix`, so generated identifiers are not stuck on `Insert<Table>Schema`.

Resolves #16. Set `affix` on a `zod`, `valibot` or `arktype` generator to choose
the prefix and suffix of the exported schema constants and of the type aliases,
separately, and either as one string for all three modes or per mode:

```ts
{
  kind: 'zod',
  path: 'src/validators/zod',
  affix: {
    tableCase: 'pascal',
    schema: { suffix: 'Schema' },
    type: {
      prefix: { insert: 'Create', update: 'Edit', select: '' },
      suffix: { insert: 'Input', update: 'Input', select: '' },
    },
  },
}
```

which emits `InsertUsersSchema`, `CreateUsersInput`, `EditUsersInput` and a bare
`Users` instead of `InsertusersSchema` and `SelectusersOutput`.

`tableCase` addresses the second half of that issue. Generated identifiers
interpolate the Drizzle export name exactly as written, so a table exported as
`users` produces `Insertusers`. `tableCase: 'pascal'` upper-camels it first,
splitting on `_`, `-` and camel boundaries, so `user_profiles` and `userProfiles`
both give `InsertUserProfilesSchema`. The default is `preserve`, which keeps the
existing behaviour; changing the default is a major-version decision.

Naming now comes from one resolver in `@drzl/validation-core`
(`resolveAffix`, `schemaName`, `typeName`, `validateAffix`, `pascalCase`) instead of
template literals repeated in four packages, which is what lets both sides of an
import agree. When an `orpc` generator uses `validation.useShared` and exactly one
sibling generator produces that library, the sibling's `affix` is copied onto it,
so the router imports the names the validation generator actually exported.
A `validation.affix` that is set explicitly and disagrees with that sibling now
fails the run, listing both sets of names, rather than writing a router that does
not compile.

Configs are checked before anything is written: an affix that could not appear in
a TypeScript identifier, or that would put two same-named exports in one file, is
rejected with the path to the offending option.

Nothing changes for existing configs. Omitting `affix` reproduces the previous
output byte for byte, `schemaSuffix` still works and is the default for
`affix.schema.suffix`, and affixes rename identifiers only, never files or module
specifiers.
