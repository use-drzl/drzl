# @drzl/generator-forms

Form resolvers and per-field input metadata, generated from your Drizzle schema, for
[react-hook-form](https://react-hook-form.com) and [TanStack Form](https://tanstack.com/form).

Part of [DRZL](https://github.com/use-drzl/drzl). Full documentation:
[Generators → Forms](https://use-drzl.github.io/drzl/generators/forms).

## Install

```bash
npm install -D @drzl/generator-forms
npm install react-hook-form "@hookform/resolvers@>=5.0.0 <=5.4.0"   # or @tanstack/react-form
```

## Use

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

The cap on `@hookform/resolvers` is measured: from 5.4.1 it declares `@typeschema/main` as an
optional peer, whose chain pins zod 3 and valibot 0.39, so `npm install` fails beside the zod 4 and
valibot 1 DRZL emits. See the docs for the full trace.

## What it does

Emits one module per table carrying two things.

**A resolver**, wired to whichever validation generator the config names. react-hook-form needs one;
TanStack Form does not, and gets the schema passed straight into `validators.onChange`.

**The field metadata**: the `min`, `max`, `maxlength`, `pattern`, options, `required` and default the
column really carries, so an input element states them without a second source of truth.

Those bounds are the ones the database enforces, not the column's type range. A `CHECK` does not
narrow `Column.min`, so a generator reading the column directly would put `min="-2147483648"` on an
input for a column restricted to 18. The fold lives in `@drzl/validation-core` as `fieldFacts`, in
the same place the emitted schemas get their bounds, so the input and the schema cannot disagree.

## License

Apache-2.0
