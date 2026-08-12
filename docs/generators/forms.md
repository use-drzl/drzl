# Forms

`@drzl/generator-forms` emits form resolvers and per-field input metadata from your Drizzle schema,
for [react-hook-form](https://react-hook-form.com) and
[TanStack Form](https://tanstack.com/form).

Two halves, and the second is the one that is hard to get anywhere else.

## The resolver

The two libraries want different things, measured on 2026-08-12:

| Library | What it needs |
| ------- | ------------- |
| react-hook-form | a resolver. `standardSchemaResolver` serves zod, valibot and arktype with one import; TypeBox and Effect have dedicated ones in the same package |
| TanStack Form | nothing. A Standard Schema goes straight into `validators: { onChange: schema }` |

So all five of DRZL's validation generators can drive a react-hook-form form, and the three that
expose `~standard` can drive a TanStack one. Asking for the TanStack target with TypeBox or Effect
is refused rather than emitted, because an options object naming a schema the form cannot read is
silently ignored at runtime.

## The field metadata, which is the point

```ts
export const usersFields = {
  "handle": { control: "text", required: true, nullable: false, maxLength: 20 },
  "age":    { control: "number", required: true, nullable: false, min: "18", max: "130", integer: true },
  "tier":   { control: "select", required: true, nullable: false, options: ["free", "pro", "max"] },
  "ref":    { control: "text", required: true, nullable: false, pattern: "[0-9a-fA-F]{8}-..." },
  "active": { control: "checkbox", required: false, nullable: false, defaultValue: true },
} as const;
```

Every value there is a fact the database already enforces, so an `<input>` can carry it without a
second source of truth:

```tsx
<input
  type="number"
  {...register('age')}
  min={usersFields.age.min}
  max={usersFields.age.max}
  step={usersFields.age.integer ? 1 : undefined}
  required={usersFields.age.required}
/>
```

## Why the bounds are not read off the column

**A `CHECK` does not narrow `Column.min` and `Column.max`.** Measured: a column declared `integer`
with `check('adult', age >= 18)` still reports `min: '-2147483648'`, the plain int32 range. The
analyzer leaves checks on the table, and each validation generator folds them into its own emitted
bounds at emit time.

A form generator reading the column directly would put `min="-2147483648"` on an input for a column
the database restricts to 18. That is worse than emitting nothing: it looks like a bound and is not
one, and the schema beside it would reject what the input accepted.

So the fold lives in `@drzl/validation-core` as `fieldFacts`, beside `classifyTableChecks` and
`tableConstraints`, which are already the shared home for that question. The metadata above and the
`.gte(18)` in the emitted schema come from the same place rather than from two derivations that
agree until one of them changes.

The same holds for length. `varchar(40)` carrying `CHECK (length(handle) <= 20)` reports
`maxLength: 20`, the tighter of the two, and an unbounded `text` column with only a length check
gets a `maxLength` its type never declared. A byte-count check is **not** read: `octet_length` is
not a character count, and `maxlength` on an input counts characters, so taking one would reject
text the database accepts on every multi-byte character.

## Setup

```bash
npm install -D @drzl/generator-forms
npm install react-hook-form @hookform/resolvers   # or @tanstack/react-form
```

```ts
// drzl.config.ts
export default {
  schema: './src/db/schema.ts',
  outDir: './src/api',
  generators: [
    { kind: 'zod', path: './src/validators/zod' },
    { kind: 'forms', path: './src/forms', target: 'react-hook-form' },
  ],
} as const;
```

A resolver with no schema is nothing, so a validation generator has to be in the config. Its
`importPath` is derived from that entry's own `path`. The generator refuses otherwise.

## Using it

```tsx
import { useForm } from 'react-hook-form';
import { usersFields, usersInsertResolver } from './forms/users.form.js';

function NewUser() {
  const { register, handleSubmit, formState } = useForm({ resolver: usersInsertResolver });
  return (
    <form onSubmit={handleSubmit(save)}>
      <input {...register('handle')} maxLength={usersFields.handle.maxLength} />
      {formState.errors.handle && <span>{formState.errors.handle.message}</span>}
    </form>
  );
}
```

TanStack Form takes the schema directly:

```ts
import { useForm } from '@tanstack/react-form';
import { usersInsertFormOptions } from './forms/users.form.js';

const form = useForm({ defaultValues: { handle: '' }, ...usersInsertFormOptions });
```

## Options

| Option | Default | What it does |
| ------ | ------- | ------------ |
| `path` | `outDir` | Where the modules are written |
| `target` | `react-hook-form` | `react-hook-form`, `tanstack-form` or `both` |
| `modes` | `['insert', 'update']` | Which operations get a resolver |
| `validation.library` | `zod` | Which validation generator's schemas to import |
| `validation.importPath` | derived | Where those schemas are, if the sibling entry's `path` is not it |
| `format` | inherited | Formatter settings |
| `outputHeader` | inherited | The generated-file banner |
| `importExtension` | `js` | How the emitted relative imports spell their extension |

`select` is off by default. A select schema describes a row that came *out* of the database, so
validating a user's input against it asks for the generated columns a form never supplies. It is
offered because a filter form is a form too.

A read-only relation gets a select module only, since it has no insert or update schema to resolve
against.

See also: [Zod](/generators/zod) · [openapi-fetch](/generators/openapi-fetch) ·
[Configuration](/guide/configuration)
