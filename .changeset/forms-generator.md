---
'@drzl/generator-forms': minor
'@drzl/validation-core': minor
'@drzl/cli': minor
'@drzl/generator-next': patch
---

Add `@drzl/generator-forms`, which emits form resolvers and per-field input metadata for
[react-hook-form](https://react-hook-form.com) and [TanStack Form](https://tanstack.com/form).

```ts
generators: [
  { kind: 'zod', path: './src/validators/zod' },
  { kind: 'forms', path: './src/forms', target: 'react-hook-form' },
]
```

**The two libraries want different things**, measured against `react-hook-form` 7.85.0,
`@hookform/resolvers` 5.7.1 and `@tanstack/react-form` 1.33.5. react-hook-form needs a resolver, and
`standardSchemaResolver` serves zod, valibot and arktype with one import while TypeBox and Effect
have dedicated ones in the same package. TanStack Form needs none: a Standard Schema goes straight
into `validators: { onChange: schema }`. Asking for the TanStack target with TypeBox or Effect is
refused rather than emitted, because an options object naming a schema the form cannot read is
silently ignored at runtime.

**The field metadata is the half that is hard to get anywhere else**, and the reason it needed a new
shared helper. `Column.min` and `Column.max` are the column's *type* range and a `CHECK` does not
narrow them: measured, a column with `check('adult', age >= 18)` still reports
`min: '-2147483648'`. A form generator reading the column directly would put that on an input for a
column the database restricts to 18, which is worse than emitting nothing, because it looks like a
bound and the schema beside it would reject what the input accepted.

So `fieldFacts` is added to `@drzl/validation-core`, beside `classifyTableChecks` and
`tableConstraints`, performing the same fold every validation generator already does privately. The
emitted `min` on an input and the emitted `.gte()` in the schema now come from one place.

The same holds for length: `varchar(40)` with `CHECK (length(handle) <= 20)` reports
`maxLength: 20`, and an unbounded `text` column with only a length check gets a `maxLength` its type
never declared. A byte-count check is not read, because `octet_length` is not a character count and
`maxlength` on an input counts characters.

`select` is off by default: a select schema describes a row that came out of the database, so
validating user input against it asks for the generated columns a form never supplies.

`@drzl/generator-next` drops `forms` from its keywords. `package-metadata.spec.ts` refuses a package
that describes itself with another package's name, and now that a dedicated forms generator exists,
that term belongs to it.

The package spends this release in `optionalDependencies` of `@drzl/cli`, as every new generator
does.
