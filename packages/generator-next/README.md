# @drzl/generator-next

Generate [Next.js](https://nextjs.org) server actions from a Drizzle schema: one `'use server'`
module per table, with the `FormData` readers that turn what a browser posts into what the schemas
accept.

## The reason this exists

A schema describes a row and a form posts strings, so between the two sits a conversion per column,
and every one of them has a wrong answer that looks right.

The one that decides it, measured on 2026-08-11 against zod 4.4.3, valibot 1.1 and arktype 2:
`<input type="date">` posts `2026-08-11`, `<input type="datetime-local">` posts `2026-08-11T14:30`,
and `z.iso.datetime()` and `v.isoTimestamp()` **refuse every spelling a form control produces**.
Only a hand-typed `2026-08-11T14:30:00Z` gets through. A form wired straight to a generated schema
cannot submit a date at all, and the failure is a validation message on a field the user filled in
correctly.

Three smaller ones with the same shape: an empty number box posts `\'\'` and must become `NaN` rather
than `0`, because `0` is reported against whatever bound zero happens to break; an unchecked
checkbox is absent from `FormData` rather than posting `false`; and a blank optional text box posts
`\'\'`, which is a value the column would store rather than the absence the user meant.

## Install

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

That is the whole config. This generator emits no schemas of its own, so the CLI turns on
`validation.useShared` and derives the import path from the sibling generator\'s `path`.

## What it emits

Per writable table, a `'use server'` module carrying `create`, `update` and `delete` actions shaped
for `useActionState`: `(prevState, formData) => Promise<FormState>`. `update` reads only the fields
the form actually posted, because an update schema makes every column optional and a field the form
left out has to stay absent rather than arriving blank.

A table with no primary key keeps `create` and loses the two that address a row. A materialized view
gets no module at all: a server action is a mutation, and a Next server component reads directly.

Plus `form-state.ts`, which holds `FormState`, `EMPTY_FORM_STATE`, `fieldErrorsFor` and the readers.
It is deliberately not `'use server'`, because such a file may export only async functions and
`EMPTY_FORM_STATE` is a `const`.

Every message is keyed by the input\'s `name`, so rendering one under its field is an index rather
than a mapping you maintain.

## Timezones

A value from a date input carries no timezone, so `dateField` reads it as UTC. Not the server\'s
local zone: that makes the same submission mean two different instants depending on which region the
server happens to run in. A value that already carries a zone is passed to the schema unchanged.

## Licence

Apache-2.0. Generated output is yours under your own project\'s licence.
