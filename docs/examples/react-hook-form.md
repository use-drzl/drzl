# React Hook Form

Every schema DRZL emits in zod, valibot or arktype spelling carries [Standard Schema
v1](https://standardschema.dev): `InsertusersSchema['~standard']` is present on insert, update,
select and nested exports alike (measured on all twelve combinations). React Hook Form's own
resolver package understands that interface directly, so wiring a table's form is one line and
there is no `@drzl/*` package for it:

```tsx
useForm({ resolver: zodResolver(InsertusersSchema) });
```

That absence is deliberate and was settled by measurement rather than taste. A per-table
resolver export would wrap one call. It could not close the real gaps either, because the work
a form actually needs sits in `register()`, and React Hook Form applies `valueAsNumber`,
`valueAsDate` and `setValueAs` to the input's string **before any resolver runs**. The rest of
this page is the measured behavior of that pipeline against real emitted schemas, and the
handful of traps worth knowing about.

Measured 2026-08-08 with `react-hook-form` 7.85.0, `@hookform/resolvers` 5.7.1, `zod` 4.4.3,
`valibot` 1.1.0, `arktype` 2.1.29, `drizzle-orm` 0.45.2, TypeScript 5.9.3. Every snippet below
typechecks under `strict` against the emitted schemas. The resolver contract is a plain function
`(values, context, options) => Promise<{ values, errors }>`, so everything here was measured by
running the real resolver implementations headless, plus one end-to-end pass through React Hook
Form's own `createFormControl` with no DOM present.

## Which resolver import

`@hookform/resolvers` ships one resolver per library and a generic `standardSchemaResolver`
that accepts any of the three. At runtime they agree on every case in the grids below. Their
**types** do not agree, measured under TypeScript 5.9:

| library | import | `useForm` infers with no generics? | `errors.x.type` |
| ------- | ------ | ---------------------------------- | ---------------- |
| zod | `zodResolver` from `@hookform/resolvers/zod` | yes: submit values, `register` paths, error messages | zod issue code (`invalid_type`, ...) |
| valibot | `valibotResolver` from `@hookform/resolvers/valibot` | yes | valibot issue kind (`number`, ...) |
| arktype | `standardSchemaResolver` from `@hookform/resolvers/standard-schema` | no: pass explicit generics (below) | always `""` |

`standardSchemaResolver` works with all three libraries at runtime, but under it `useForm`
inferred nothing at all (submit values were `unknown`, and `register('nonexistent')` was
accepted), and it erases issue codes: `errors.x.type` is always the empty string, and under
`criteriaMode: 'all'` the `types` object is keyed `"0"`, `"1"` instead of by code. So: use the
dedicated resolver for zod and valibot, and for arktype use `standardSchemaResolver` with
explicit generics, since `arktypeResolver` measured identically (no inference, empty types) and
buys nothing over the generic one.

## The config

Any of the three validator generators produces form-ready schemas; nothing form-specific goes in
the config:

```ts
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: 'src/db/schema.ts',
  outDir: 'src/validators',
  generators: [
    { kind: 'zod', path: 'src/validators/zod' },
    { kind: 'valibot', path: 'src/validators/valibot' },
    { kind: 'arktype', path: 'src/validators/arktype' },
  ],
});
```

## The wiring

zod, with the register recipes from the grid below:

```tsx
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { InsertusersSchema } from '../validators/zod/users.zod';

export function NewUserForm() {
  const { register, handleSubmit, formState } = useForm({
    resolver: zodResolver(InsertusersSchema),
  });

  // handleSubmit receives the schema's OUTPUT, not the form state: publishedAt is a real
  // Date here and views a real bigint, ready for db.insert.
  const onSubmit = handleSubmit((values) => {
    console.log(values.publishedAt.toISOString(), values.views + 1n);
  });

  return (
    <form onSubmit={onSubmit}>
      <input {...register('name')} />
      <input type="number" {...register('age', { valueAsNumber: true })} />
      <input type="date" {...register('publishedAt')} />
      <p>{formState.errors.age?.message}</p>
      <button type="submit">create</button>
    </form>
  );
}
```

valibot is identical apart from the import:

```tsx
import { valibotResolver } from '@hookform/resolvers/valibot';

useForm({ resolver: valibotResolver(InsertusersSchema) });
```

arktype needs the explicit generics, and one conversion caveat covered below:

```tsx
import { useForm } from 'react-hook-form';
import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import { InsertusersSchema } from '../validators/arktype/users.arktype';

export function NewUserForm() {
  const { register, handleSubmit } = useForm<
    typeof InsertusersSchema.inferIn,
    unknown,
    typeof InsertusersSchema.infer
  >({ resolver: standardSchemaResolver(InsertusersSchema) });

  // With arktype, values.publishedAt is still the wire string here (measured below).
  return null;
}
```

## The string problem

HTML inputs produce strings and DRZL schemas are wire-shaped: an `integer` column wants a
number, a `timestamp` column wants a Date or the strict ISO string. React Hook Form owns the
conversion, and its 7.85.0 implementation is exactly this, read from the dist: `valueAsNumber`
maps `''` to `NaN` and any other input string through `+value`; `valueAsDate` maps the string through
`new Date(value)`, so an **empty date input under `valueAsDate` is an Invalid Date, not
`null`**; `setValueAs` runs your function; a checkbox registers as a real boolean with no
option needed. When several are set, `valueAsNumber` wins over `valueAsDate`, which wins over
`setValueAs`.

What the schemas then said, per value, measured on the insert schemas of a table with
`age integer`, `price real`, `amount numeric`, `views bigint`, `published_at timestamp`,
`born_on date`, `status text CHECK (status IN ('draft', 'live'))`:

### Numbers

| value reaching the schema | zod | valibot | arktype |
| ------------------------- | --- | ------- | ------- |
| `age: "30"` (plain register) | rejected: "Invalid input: expected number, received string" | rejected | rejected: "age must be a number (was a string)" |
| `age: 30` (`valueAsNumber`) | accepted | accepted | accepted |
| `age: NaN` (`valueAsNumber` on `""` or junk) | rejected: "Invalid input: expected number, received NaN" | rejected: "Invalid type: Expected number but received NaN" | rejected: "age must be a number (was NaN)" |
| `price: NaN` (float column!) | **accepted, value is `NaN`** | **accepted** | **accepted** |
| `price: "19.99"` | rejected | rejected | rejected |
| `amount: "19.99"` (`numeric` is string-typed) | accepted as the string | accepted | accepted |
| `amount: "abc"` | **accepted** (no format check by default) | **accepted** | **accepted** |

Two traps. An integer column under `valueAsNumber` fails loudly on an empty input, which is
fine. A **float column does not**: DRZL's float schemas accept `NaN` on purpose, because
Postgres `real` stores it ([non-finite policy](/generators/zod#nan-and-the-infinities-are-values-not-out-of-range-numbers)), so an untouched price input
under `valueAsNumber` validates and hands your insert a `NaN`. Register float columns with a
guard instead:

```tsx
<input type="number" step="any" {...register('price', {
  setValueAs: (v: string) => (v === '' || Number.isNaN(+v) ? undefined : +v),
})} />
```

`undefined` then fails the required check with a clean field error. The same applies to
string-typed `numeric` columns, which accept any string at the schema by default: the schema
is honest about the wire, so the format either comes from
[constraints](/generators/constraints) in the schema or belongs to your input.

### Dates

| value reaching the schema | zod | valibot | arktype |
| ------------------------- | --- | ------- | ------- |
| `publishedAt: "2026-01-02"` (date input, plain register) | accepted, **output is a real `Date`** | accepted, real `Date` | accepted, **output stays the string** |
| `publishedAt: ""` (empty input, plain register) | rejected | rejected | rejected |
| `publishedAt:` Invalid Date (`valueAsDate` on `""`) | rejected | rejected | rejected: "(was an invalid Date)" |
| `publishedAt:` epoch ms number (`valueAsNumber`) | accepted, real `Date` | accepted, real `Date` | accepted, **stays a number** |
| `bornOn: "2026-01-02"` (pg `date`, string mode) | accepted as the string | accepted | accepted |
| `bornOn: ""` | **accepted** | **accepted** | **accepted** |

A `timestamp` column works with a bare `<input type="date" {...register('publishedAt')} />`:
the emitted zod and valibot schemas coerce the strict date string on insert and hand your
submit handler a real `Date`. The arktype schema validates the same strings but performs no
conversion, so with arktype the submitted value keeps its wire spelling (the `infer` type says
so too: `Date | number | string`); convert it yourself before `db.insert`.

A pg `date` column is string-typed all the way through, and that includes accepting `""`,
which Postgres will then refuse. Map empties out:

```tsx
<input type="date" {...register('bornOn', {
  setValueAs: (v: string) => (v === '' ? undefined : v),
})} />
```

### bigint

`views: "123"` and `views: 123` are both rejected by all three libraries (a `bigint` column
wants a real bigint), and React Hook Form has no `valueAsBigInt`. Two JS facts shape the
recipe: `BigInt('')` is `0n`, silently, and `BigInt('abc')` throws, which inside an event
handler is a crash rather than a field error. So guard before converting:

```tsx
<input {...register('views', {
  setValueAs: (v: string) => (/^-?\d+$/.test(v) ? BigInt(v) : undefined),
})} />
```

### Strings, enums, booleans

- A required `text` column accepts `""` (measured, all three): an empty string is a real SQL
  value. If your product wants non-empty, that rule belongs to you, not the wire schema.
- `status: ""` from a select with no choice fails cleanly everywhere; the messages differ in
  quality: zod "Invalid option: expected one of \"draft\"|\"live\"", arktype "status must be
  \"draft\" or \"live\" (was \"\")", valibot names the expected union.
- A checkbox registered with no options submits a real boolean and passes `boolean` columns.
  A `"true"` string (from a select) fails them, all three libraries.

## Absence and null are both allowed

These three generators emit a nullable column as optional **and** nullable on insert:
`{ bio: null }`, `{ bio: "text" }` and `{}` are all valid (measured). Every DRZL generator now
answers this the same way, including [Fastify](/generators/fastify) and
[NestJS](/generators/nestjs), because a database accepts an `INSERT` that omits a nullable column
and stores `NULL` for it.

The form-side wrinkle is that an untouched text input submits `""`, not null, and `""` is a
valid string for the column: your bio column quietly stores an empty string. If you want
"untouched means null", say so at registration, and pick the spelling per library:

```tsx
<textarea {...register('bio', { setValueAs: (v: string) => (v === '' ? null : v) })} />
```

Map to `null`, not to `undefined`, if arktype is your library: a **present** key holding
`undefined` is rejected by arktype's optional properties ("bio must be a string or null (was
undefined)", measured), while zod and valibot accept it. `''` to `null` measured green on all
three.

## Edit forms: the update schemas

`UpdateusersSchema` is the patch shape: every column optional, primary key columns excluded.
Measured: `{}` validates in all three libraries (an empty patch is a legal PATCH), a wrong
value on any present field fails exactly like insert, and the string problem is identical, so
the register recipes above carry over.

One divergence with teeth. Spread a loaded row into `defaultValues` and the form state carries
`id`. On submit, zod and valibot **strip** it (not in the schema's shape), so the resolver
output is a clean patch. arktype **keeps undeclared keys** in its output (measured: `{ id: 7,
age: 31 }` came back with `id: 7` still present), and the same applies to any stray key on
insert. If your update handler spreads the patch into `db.update().set(...)`, that id rides
along. The one-line fix, measured green through the resolver:

```ts
const UpdateusersForm = UpdateusersSchema.onUndeclaredKey('delete');
```

or keep `defaultValues` to the registered fields instead of spreading the row.

## How errors land in formState

- **Paths map exactly.** A failure on a column lands at `errors.<column>`. With
  [`nestedSchemas`](/generators/nested-relations), a failure inside a relation array lands at
  the dotted path React Hook Form uses for field arrays: `posts.0.title`, measured identical
  in all three libraries.
- **Array-level errors follow RHF's root rule.** `posts: "nope"` lands at `errors.posts`
  normally, but if any registered name matches `posts.<index>...` (a mounted `useFieldArray`),
  the resolver files it under `errors.posts.root` instead. Measured both ways, all three
  libraries.
- **Row-level rules land at `errors.root`.** A schema-level `.refine` with no path maps to
  `errors.root` (measured with a hand-added refine; render it from `formState.errors.root`).
  DRZL's own emitted schemas produce field-pathed issues only: single-column CHECKs fold into
  the column, and a cross-column CHECK lands in **no** emitted schema (measured; it is a fact
  about the table, carried by the [constraint ledger](/generators/constraints) for the server
  to enforce, as in the [server actions example](/examples/nextjs-server-actions)).
- **`criteriaMode: 'all'` is only as multi as the library.** For a value breaking two rules of
  one column (`age: 2147483648.5`, non-integer and over the int4 ceiling): valibot reports
  both issues (`types` carries two entries), zod reported only the integer failure on this
  value, and arktype folds both into one message with bullet points, so `types` still has one
  entry.
  arktype's aggregate messages are multi-line; render them in a `white-space: pre-line`
  element if you want the bullets visible.
- **`type` is only meaningful with the dedicated resolvers.** `zodResolver` fills
  `errors.x.type` with the zod issue code and keys `types` by code under `'all'`;
  `valibotResolver` uses valibot's issue kind the same way (measured: `types` came back keyed
  `integer` and `max_value`); `standardSchemaResolver` and `arktypeResolver` always produce
  `type: ""` and index-keyed `types`.

## Server side, sync, and `raw`

The resolver contract has no DOM in it. The whole pipeline, `createFormControl` included, ran
headless in the measurements, so the same one-liner validates in a server action with no jsdom
involved. All emitted schemas validate synchronously (none of the three `~standard.validate`
calls returned a Promise), but the resolver itself always hands React Hook Form a Promise, so
treat validation as async regardless.

`standardSchemaResolver(schema, undefined, { raw: true })` returns the untouched input as
`values` instead of the parsed output (measured: `publishedAt` stays the wire string), which is
the shape to reach for when your submit handler wants to forward the original form payload.

::: tip Need something else?
If this example doesn't cover what you need, DM me on X (https://x.com/omardulaimidev) and we can scope it together.
:::
