# TanStack Form

TanStack Form v1 accepts [Standard Schema v1](https://standardschema.dev) validators natively,
on every validator slot, form-level and field-level, sync and async. Every schema DRZL emits in
zod, valibot or arktype spelling carries that interface
([measured on all twelve combinations](/examples/react-hook-form)), so wiring a table's form is
one property and there is no `@drzl/*` package for it:

```tsx
useForm({ validators: { onChange: InsertusersSchema } });
```

That absence is deliberate and was settled by measurement rather than taste. The three gaps a
package might claim to close are all structural: the validator's type contract wants the
schema's input type assignable to your form state (a one-line cast, measured below), the parsed
output of a schema is discarded by design (`standardSchemaValidators` reads `issues` and
nothing else, so conversion is one `parse` call in your submit handler), and the
submission-wedge below lives in `FormApi`'s submit mechanics, not in anything a generated
wrapper could reach. The rest of this page is the measured TanStack-specific behavior against
real emitted schemas.

Measured 2026-08-08 with `@tanstack/react-form` 1.33.3, `@tanstack/form-core` 1.33.3 (react
peer `^17 || ^18 || ^19`), `zod` 4.4.3, `valibot` 1.1.0, `arktype` 2.1.29, `drizzle-orm`
0.45.2, TypeScript 5.9.3. Every runtime grid below was measured headless on `form-core`'s
`FormApi` and `FieldApi`, no React and no DOM: `useForm` is `new FormApi(opts)` plus a React
binding (read from `useForm.js`), and `@tanstack/react-form` re-exports all of `form-core`.
The v0 `validatorAdapter` layer is gone in v1: no adapter code exists in either package, and
the old `@tanstack/zod-form-adapter` stopped at 0.42.1. Type-grid verdicts were measured with
`tsc` under `strict` against the emitted schemas, through `useForm` and `FormApi` both. Every
tsx snippet below typechecked the same way at authoring time.

## What transfers from the React Hook Form page

The grids on the [React Hook Form page](/examples/react-hook-form) that describe the
**schemas** apply here unchanged and were not re-measured: per-library string handling
(`age: "30"` rejected, `amount: "abc"` accepted), float columns accepting `NaN` by policy,
pg `date` columns accepting `""`, bigint columns wanting real bigints, timestamp handling per
library (zod and valibot coerce the strict string to a `Date` in their *output*, arktype
validates without converting), null-vs-absence on insert, arktype rejecting a present
`undefined` on optional columns, arktype keeping undeclared keys in its output, and all
emitted schemas validating synchronously. What changes in TanStack Form is everything around
them: where values live, where outputs go (nowhere), and where errors land.

## The config

Any of the three validator generators produces form-ready schemas; nothing form-specific goes
in the config:

```ts
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: 'src/db/schema.ts',
  outDir: 'src/validators',
  generators: [
    { kind: 'zod', path: 'src/validators/zod', nestedSchemas: true },
    { kind: 'valibot', path: 'src/validators/valibot', nestedSchemas: true },
    { kind: 'arktype', path: 'src/validators/arktype', nestedSchemas: true },
  ],
});
```

## The wiring

zod, with the whole-table schema on `onChange` (the wedge section below is the reason it is
not on `onSubmit`), the one-line validator cast from the type grid, and conversion done
explicitly at submit:

```tsx
import { useForm } from '@tanstack/react-form';
import type { StandardSchemaV1 } from '@tanstack/react-form';
import { InsertusersSchema } from '../validators/zod/users.zod';

const defaults = {
  name: '', bio: null as string | null, age: 0, price: 0, amount: '',
  views: 0n, publishedAt: '', bornOn: '', status: '',
};

export function NewUserForm() {
  const form = useForm({
    defaultValues: defaults,
    validators: {
      onChange: InsertusersSchema as unknown as StandardSchemaV1<typeof defaults, unknown>,
    },
    onSubmit: ({ value }) => {
      // `value` is the raw form state, never the schema's output (measured below).
      // The parse is where publishedAt becomes a real Date and views a real bigint.
      const row = InsertusersSchema.parse(value);
      console.log(row.publishedAt.toISOString(), row.views + 1n);
    },
  });

  return (
    <form onSubmit={(e) => { e.preventDefault(); form.handleSubmit(); }}>
      <form.Field name="name">
        {(field) => (
          <input
            value={field.state.value}
            onChange={(e) => field.handleChange(e.target.value)}
            onBlur={field.handleBlur}
          />
        )}
      </form.Field>
      <form.Field name="age">
        {(field) => (
          <>
            <input
              type="number"
              value={Number.isNaN(field.state.value) ? '' : field.state.value}
              onChange={(e) => field.handleChange(e.target.valueAsNumber)}
            />
            <p>{field.state.meta.errors[0]?.message}</p>
          </>
        )}
      </form.Field>
      {/* one form.Field per remaining column: the wedge section explains why every
          schema-checked column needs one */}
      <button type="submit">create</button>
    </form>
  );
}
```

valibot is identical apart from the import and the parse spelling (`v.parse(InsertusersSchema,
value)`). arktype drops the cast (its `Type` is callable, so it satisfies the function branch
of the validator union as-is, measured in the type grid) and its "parse" keeps wire spellings:
`const out = InsertusersSchema(value)` returns `ArkErrors` on failure and the (unconverted)
value on success.

## Validation gates, values do not flow

React Hook Form hands your submit handler the resolver's parsed output. TanStack Form does
not: this is the single largest difference and it is by design, measured on 1.33.3:

- `onSubmit: ({ value })` receives `form.state.values`, the raw controlled state. With the zod
  insert schema on `validators.onSubmit` and `publishedAt: '2026-01-02'` in state, the submit
  handler received the **string**, not the `Date` the schema's output carries.
- `form.parseValuesWithSchema(schema)` and `field.parseValueWithSchema(schema)`, despite the
  names, return **issues or `undefined`**, never a parsed value. The sync validator reads
  `result.issues` and discards `result.value` (read from `standardSchemaValidator.js`).
- Type level, same story: `form.state.values` and the `onSubmit` `value` are typed from
  `defaultValues`; `value.publishedAt.toISOString()` does not compile, and the same call on
  the parsed row does (measured by tsc).

So conversion is always your line: `InsertusersSchema.parse(value)` (zod),
`v.parse(InsertusersSchema, value)` (valibot), `InsertusersSchema(value)` (arktype, which
validates but keeps the wire string, [as on the RHF
page](/examples/react-hook-form#dates)). Run it in `onSubmit`, where validation has already
gated, and hand the result to `db.insert`.

## The type grid

TanStack Form infers everything from `defaultValues` and nothing from validators. A form-level
standard schema must satisfy `StandardSchemaV1<TFormData, unknown>`: the schema's **input**
type must be assignable to your state type. Measured under TypeScript 5.9 `strict`, identical
verdicts through `useForm` and `new FormApi`:

| combination | tsc verdict |
| ----------- | ----------- |
| zod insert schema, form-level, wire-typed defaults (`publishedAt: string`) | **rejected**: the constraint wants the schema's input to *be* `{ publishedAt: string }`, and the schema's is `string \| number \| Date`. A wider input is not assignable either: `StandardSchemaV1`'s input sits in a property, so the check is invariant rather than contravariant |
| valibot insert schema, same defaults | **rejected**: input wants `publishedAt: string \| number \| Date` |
| arktype insert schema, same defaults | **compiles, for the wrong reason**: a `Type` is callable with an `unknown` parameter, so it satisfies the *function* branch of the validator union; runtime still takes the standard-schema path, but `errorMap.onChange` is then typed as `ArkErrors \| <output>` while the runtime value is the path-keyed record below |
| zod update schema on a loaded full row (edit form) | **rejected**: all-optional input not assignable to the row type |
| any schema, no `defaultValues` | compiles, and `form.state.values` is `unknown`: **no inference flows from the schema** |
| `defaultValues` cast to the schema's input type (`z.input<...>` / `v.InferInput<...>` / `.inferIn`) | compiles with no validator cast; the timestamp state is `string \| number \| Date` in all three libraries, so a keystroke handler narrows rather than casting. zod used to be the outlier here, reporting `unknown`, until its date columns stopped being a `z.preprocess` |
| validator cast one line: `InsertusersSchema as unknown as StandardSchemaV1<typeof defaults, unknown>` | compiles, keeps wire-typed state, and `errorMap.onSubmit?.['publishedAt']?.[0]?.message` stays typed (`StandardSchemaV1Issue[]` per key) |
| field-level `InsertusersSchema.shape.age` on the `age` field | compiles; `field.state.meta.errors[0]?.message` is issue-typed |
| field-level `.entries.age` (valibot), `.get('age')` (arktype) | compiles, both |
| field-level `InsertusersSchema.shape.publishedAt` on a string-typed field | **rejected**: the field's input is `string \| number \| Date` and the constraint wants `StandardSchemaV1<string, unknown>` exactly, the same invariance as the first row |

The cast recipe in the wiring above is the honest one: it keeps ordinary wire-typed state,
keeps issue-typed error maps, and changes nothing at runtime. Casting `defaultValues` to the
schema input instead is legal, and now costs the same in all three libraries: every keystroke
handler sees `string | number | Date` and narrows.

Worth being plain about why the cast is still here. It is not that the schema's input is vague:
DRZL's date columns state theirs. It is that TanStack's constraint holds the input type in a
property rather than in a parameter, so the check is invariant, and a schema whose input is wider
than the form's state is rejected exactly as one whose input is narrower would be. No schema
shape removes it; this was measured both ways rather than assumed.

## Where errors land

Form-level schema issues are mapped by path into a keyed record; per event, per library,
measured:

- **`form.state.errorMap.<event>` is a path-keyed record**, `{ [path]: issues[] }`, where the
  event key follows the validator slot: `validators.onChange` fills `errorMap.onChange`,
  `onBlur` fills `onBlur`, `onMount` fills `onMount`, `onSubmit` fills `onSubmit` (all
  measured). `form.state.errors` is an array of those records, one per failing event, not a
  flat issue list.
- **The same issues fan out to `fieldMeta`.** A failure on `status` lands at
  `form.state.fieldMeta.status.errors` and on a mounted field at `field.state.meta.errors`,
  with `errorSourceMap` marking it `'form'`. This happens for **every** path in the record,
  including columns with no mounted field (the wedge below).
- **Errors are the libraries' own issue objects, not strings.** zod: `{ code, path, message }`
  (`invalid_type`, `invalid_value`, ...). valibot: full issue objects (`kind`, `type`,
  `expected`, `received`, `message`) whose `path[0].input` embeds the entire form value.
  arktype: `ArkError` instances. All three expose `.message`, so
  `field.state.meta.errors[0]?.message` renders everywhere; arktype's aggregate messages are
  multi-line, same rendering note as [on the RHF
  page](/examples/react-hook-form#how-errors-land-in-formstate).
- **Nested paths use bracket spelling.** With `nestedSchemas`, a failure inside a relation
  array lands at `posts[0].title`, TanStack's own field-name convention, NOT React Hook Form's
  `posts.0.title`. Measured identical in all three libraries. An array-level failure
  (`posts: "nope"`) lands at `posts`.
- **A pathless issue lands under the empty-string key**: a hand-added whole-row `.refine`
  maps to `errorMap.onSubmit['']` and creates a `fieldMeta['']` entry. No field renders it,
  and it wedges submission (next section). DRZL's own emitted schemas produce field-pathed
  issues only ([measured on the RHF page](/examples/react-hook-form#how-errors-land-in-formstate)):
  single-column CHECKs fold into the column and cross-column CHECKs are carried by the
  [constraint ledger](/generators/constraints) instead, so this only bites schemas you extend
  by hand.
- **Field-level validators file issues under the field's own event map** with `path: []`
  (relative to the field's value), and `meta.errors` concatenates across event keys: the same
  schema attached to `onChange` and `onBlur` shows the same message twice after a blur.
  Measured stale-entry detail: fixing a field clears `onChange` immediately, but an `onBlur`
  entry stays until the **next** blur, so a corrected field can keep showing its blur-time
  error. Attach a schema to one event.

## The submission wedge

The sharpest TanStack-specific trap, measured in all three libraries. `handleSubmit` runs
mounted fields first (`validateAllFields`, which skips form validators), then gates on
`isFieldsValid` **before** the form-level validators run. `isFieldsValid` is computed over
every `fieldMeta` entry, including entries created by a form-level schema for columns that
have no mounted field, and only the full form-level pass, which never runs while the gate
fails, would clear those entries:

| scenario (schema on `validators.onSubmit`) | measured result |
| ------------------------------------------ | --------------- |
| every schema-checked column has a mounted `form.Field` | first submit fails, fix values, second submit succeeds: `onSubmit` fired, all three libraries |
| one column failed once and has **no** mounted field | **permanently wedged**: values fixed, `errorMap.onSubmit` cleared, but the stale `fieldMeta` error never clears, `canSubmit` stays `false`, `onSubmit` never fires (zod, valibot, arktype all measured) |
| pathless `.refine` failed once, **every** column mounted | **wedged the same way**: the `fieldMeta['']` entry has no field to clear it |
| same shapes, schema on `validators.onChange` instead | self-heals: the next keystroke on any field re-runs the form validator unfiltered and clears the stale entry; submit then succeeds |
| escape hatch after a wedge | `await form.validate('submit')` runs the full unfiltered pass, clears the stale entries, and the next `handleSubmit` fires |

Practical reading: DRZL schemas validate **whole tables**, so either mount a `form.Field` for
every column the schema checks (including ones you set programmatically), or put the schema on
`onChange`, where the wedge cannot form. If you must validate on submit only, keep
`form.validate('submit')` in reach.

## The value pipeline

TanStack Form is controlled state: no `register`, no `valueAsNumber`/`valueAsDate`/
`setValueAs` layer. What reaches the schema is exactly what your `onChange` handler passes to
`field.handleChange`, so the [RHF string grids](/examples/react-hook-form#the-string-problem)
apply to whatever you forward. Measured through the pipeline:

- A bare `e.target.value` on a numeric column (`age: "30"`) errors with "expected number,
  received string": **immediately** under an `onChange` schema, only at submit under an
  `onSubmit`-only schema. There is no layer that converts it for you.
- `e.target.valueAsNumber` on an empty input is `NaN`: the int column rejects it loudly, and
  the float column **accepts it** (`price: NaN` validated clean and `form.state.isValid`
  stayed `true`), the same [non-finite
  policy](/generators/zod#nan-and-the-infinities-are-values-not-out-of-range-numbers) trap as
  RHF, now flowing into your parse-at-submit. Guard in the handler:

```tsx
<input type="number" step="any" onChange={(e) => {
  const n = e.target.valueAsNumber;
  field.handleChange(Number.isNaN(n) ? undefined : n);
}} />
```

  `undefined` then fails the required check with a clean field error. One typing prerequisite,
  measured: `handleChange(undefined)` only compiles when the column's default carries it
  (`price: 0 as number | undefined`); on a plain `price: 0` state tsc rejects the guard. The
  bigint and empty pg-`date` guards from the RHF page transfer with the same one-line shape:
  run the regex or `''` check in `handleChange` instead of `setValueAs`.
- **Per-column schemas come straight off the emitted objects** for field-level validation:
  `InsertusersSchema.shape.age` (zod), `.entries.age` (valibot), `.get('age')` (arktype) all
  carry `~standard` and validate the single value (measured; issues arrive with `path: []`).
  The zod timestamp column is the exception at the type level (grid above): its per-column
  schema has input `unknown`, so wire it form-level or cast.

## Async debouncing

`asyncDebounceMs` never touches sync validators, and every DRZL schema validates
synchronously ([measured on the RHF page](/examples/react-hook-form#server-side-sync-and-raw),
none of the three `~standard.validate` calls returns a Promise). Measured with a counting
wrapper around the real schema:

| slot | 3 rapid keystrokes | verdict |
| ---- | ------------------ | ------- |
| field `onChange` (sync slot), `asyncDebounceMs: 100` | 3 validate calls, synchronous | sync slots are never debounced |
| form-level `onChange` | exactly 1 whole-table run per keystroke | wrapping costs one schema run per keystroke, nothing more |
| field `onChangeAsync`, `asyncDebounceMs: 100` | 0 calls at t=0, 1 call after the window | debounced to one run |
| form-level `onChangeAsync`, `asyncDebounceMs: 100` | 0 then 1 | same, form-level |

A sync Standard Schema is legal on the async slots (the async runner awaits whatever comes
back, measured), so `onChangeAsync: InsertusersSchema` with `asyncDebounceMs` is the recipe
when one whole-table run per keystroke is too much. The reverse is not true: an async
validator on a sync slot throws `"async function passed to sync validator"` (read from
`standardSchemaValidator.js`); DRZL schemas never trigger it.

## Edit forms: the update schemas

`UpdateusersSchema` is the same patch shape as on the RHF page: every column optional, primary
keys excluded, `{}` a valid patch (measured here through a submit: `onSubmit` fired). The
divergence has more teeth than RHF's, because output never flows:

- **The id rides along in all three libraries.** Spread a loaded row into `defaultValues` and
  submit: validation passes (an undeclared `id` fails nothing) and `onSubmit`'s `value` still
  carries `id: 7`, measured in zod, valibot **and** arktype. On the RHF page zod and valibot
  strip it in the resolver output; here there is no output, so nothing strips anything.
- **`onUndeclaredKey('delete')` does not help.** The RHF fix changes arktype's *output*, which
  TanStack discards: measured, `id` still present in the submitted value. The TanStack fixes
  are upstream or downstream of the form: keep `defaultValues` to the editable columns, or
  destructure in `onSubmit` (`const { id, ...patch } = value`) before `db.update().set(patch)`.
- **Absence is a real state you control.** `defaultValues` decides which keys exist:
  `bio: null` submits `null` (valid on insert and update, [nullable columns are optional and
  nullable](/examples/react-hook-form#null-is-a-value-absence-is-allowed-here)), and
  `form.deleteField('bio')` removes the key entirely: the submitted value had no `bio` key,
  measured. An untouched text input still submits `''`, the same silently-stored empty string
  as RHF; map it in `handleChange` (`v === '' ? null : v`). Map to `null`, not `undefined`,
  if arktype is your library: `handleChange(undefined)` left "bio must be a string or null
  (was undefined)" and `handleChange(null)` cleared it, measured, matching the RHF grid.
- Type level, the loaded-row edit form needs the one-line validator cast (grid above): the
  all-optional update input is not assignable to a full-row state type.

::: tip Need something else?
If this example doesn't cover what you need, DM me on X (https://x.com/omardulaimidev) and we can scope it together.
:::
