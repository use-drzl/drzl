# Next.js server actions

`@drzl/generator-next` emits a `'use server'` module per table: `create`, `update` and `delete`
actions shaped for `useActionState`, each reading the posted form and parsing it with the schemas a
validation generator wrote.

## The half that is worth generating

DRZL already documents this pattern and ships a runnable app under
[Next.js server actions](/examples/nextjs-server-actions). What neither a doc nor an example can do
is the mechanical half: **a schema describes a row and a form posts strings**, so between the two
sits a conversion per column, and every one of them has a wrong answer that looks right.

The one that decides it, measured on 2026-08-11 against zod 4.4.3, valibot 1.1 and arktype 2:

| What the browser posts        | From                            | `z.iso.datetime()` |
| ----------------------------- | ------------------------------- | ------------------ |
| `2026-08-11`                  | `<input type="date">`           | **rejected**       |
| `2026-08-11T14:30`            | `<input type="datetime-local">` | **rejected**       |
| `2026-08-11T14:30:00`         | `<input type="datetime-local">` | **rejected**       |
| `2026-08-11T14:30:00.500`     | `step="any"`                    | **rejected**       |
| `2026-08-11T14:30:00Z`        | nothing a form control produces | accepted           |

`v.isoTimestamp()` refuses the same four. So a form wired straight to a generated schema **cannot
submit a date at all**, and the failure is a validation message on a field the user filled in
correctly. `dateField` is what closes it, and it is the same class of defect the
[Hono generator's](/generators/hono) `dateInput` closed for JSON bodies.

The other three are smaller and have the same shape:

- An empty number box posts `''`. Converted to `0` it is reported against whatever bound zero
  happens to break: "you have to be 18" for a box nobody typed in. `numberField` produces `NaN`,
  which is refused as a number, which is the truth about an empty box.
- An unchecked checkbox is **absent** from `FormData` rather than posting `false`, so the question
  is presence and not value.
- A blank optional text box posts `''`, which is a value the column would store rather than the
  absence the person leaving it empty meant. `nullableTextField` produces `null`.

## Setup

```bash
npm install -D @drzl/generator-next
```

```ts
// drzl.config.ts
export default {
  schema: './src/db/schema.ts',
  generators: [
    { kind: 'zod', path: 'src/validators/zod' },
    { kind: 'next', path: 'src/app/actions' },
  ],
};
```

That is the whole config. This generator emits no schemas of its own, so `validation.useShared` is
not a choice and the CLI turns it on; the import path is derived from the sibling generator's own
`path`. Set `validation.importPath` if the schemas live somewhere DRZL does not generate.

A config naming `next` with no validation generator beside it is reported, rather than left to fail
as an import of nothing in the emitted tree.

## What is emitted

Per writable table, `<table>.ts`:

```ts
'use server';

export async function createUsers(_prev: FormState, data: FormData): Promise<FormState> {
  const input = {
    email: textField(data, 'email'),
    bio: nullableTextField(data, 'bio'),
    age: numberField(data, 'age'),
    bornOn: dateField(data, 'bornOn'),
  };

  const result = InsertusersSchema.safeParse(input);
  if (!result.success) {
    return { status: 'rejected', errors: fieldErrorsFor(result.error.issues) };
  }

  // The validated row is at `result.data`. Write it, then revalidate.
  throw new Error('Not implemented: create users.');
}
```

The directive is on line 1, ahead of the licence banner. `update` and `delete` come with it when
the table has a primary key, which the form carries in a hidden input.

`update` reads **only the fields the form actually posted**:

```ts
const input: Record<string, unknown> = {};
if (data.has('email')) input['email'] = textField(data, 'email');
```

An update schema makes every column optional, so a field the form left out has to be absent rather
than present and blank. Reading every column unconditionally would send the empty string for each
box the form does not render, and overwrite those columns with it.

A table with no primary key keeps `create` and loses the two that address a row. A materialized
view gets **no module at all**, because a server action is a mutation and there is no read half to
generate: a Next server component queries directly.

Plus two files at the top level:

- `form-state.ts` holds `FormState`, `EMPTY_FORM_STATE`, `fieldErrorsFor` and the readers. It is
  deliberately not `'use server'`, because such a file may export only async functions and
  `EMPTY_FORM_STATE` is a `const`.
- `index.ts` re-exports everything. It carries no directive either, and does not need one: the
  directive belongs to the file that *defines* an action.

## Wiring a form to one

```tsx
'use client';
import { useActionState } from 'react';
import { createUsers } from './actions';
import { EMPTY_FORM_STATE } from './actions/form-state';

export function UserForm() {
  const [state, action] = useActionState(createUsers, EMPTY_FORM_STATE);
  return (
    <form action={action}>
      <input name="email" />
      {state.errors.email?.map((m) => <p key={m}>{m}</p>)}
      <input name="bornOn" type="date" />
      <button>Create</button>
    </form>
  );
}
```

Every message is keyed by the input's `name`, so rendering one under its field is an index rather
than a mapping you maintain. An issue with no field to blame, which is what a row-level `CHECK`
produces, lands under `form`.

## Timezones

A value from `<input type="date">` or `<input type="datetime-local">` carries no timezone, so one
has to be chosen, and `dateField` reads it as **UTC**. Not the server's local zone, which is the
other candidate: that makes the same submission mean two different instants depending on which
region the server happens to run in.

A value that already carries a zone is passed to the schema unchanged, so the schema stays the
thing that decides what is valid.

## Options

| Option                 | Default  | What it does                                                |
| ---------------------- | -------- | ----------------------------------------------------------- |
| `path`                 | `outDir` | Where the modules are written                                |
| `validation.library`   | `zod`    | Which sibling generator's schemas the actions parse          |
| `validation.importPath`| derived  | Where those schemas live, when it is not the sibling's `path` |
| `naming.routerSuffix`  | none     | Appended to each module name and action name                 |
| `naming.procedureCase` | none     | Casing for file names and identifiers                        |
