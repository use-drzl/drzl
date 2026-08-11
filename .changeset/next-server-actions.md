---
'@drzl/generator-next': minor
'@drzl/cli': minor
---

Add `@drzl/generator-next`: Next.js server actions generated from a Drizzle schema, one
`'use server'` module per table, with the `FormData` readers that turn what a browser posts into
what the schemas accept.

DRZL already documented this pattern and shipped a runnable example. What neither could do is the
mechanical half: a schema describes a row and a form posts strings, so between the two sits a
conversion per column, and every one of them has a wrong answer that looks right.

The one that decided it, measured on 2026-08-11 against zod 4.4.3, valibot 1.1 and arktype 2:
`<input type="date">` posts `2026-08-11`, `<input type="datetime-local">` posts `2026-08-11T14:30`,
and `z.iso.datetime()` and `v.isoTimestamp()` refuse every spelling a form control produces. Only a
hand-typed `2026-08-11T14:30:00Z` gets through, which nothing in a form emits. A form wired
straight to a generated schema therefore could not submit a date at all, and the failure surfaced
as a validation message on a field the user had filled in correctly. `dateField` closes that, and
it is the same class of defect the Hono generator's `dateInput` closed for JSON bodies.

Three smaller ones with the same shape: an empty number box posts `''` and becomes `NaN` rather
than `0`, because `0` is reported against whatever bound zero happens to break; an unchecked
checkbox is absent from `FormData` rather than posting `false`, so presence is the question; and a
blank optional text box becomes `null` rather than the empty string the column would have stored.

Per writable table: `create`, `update` and `delete` shaped for `useActionState`. `update` reads
only the fields the form actually posted, because an update schema makes every column optional and
a field the form left out has to stay absent rather than arriving blank and overwriting its column.
A keyless table keeps `create`. A materialized view gets no module at all: a server action is a
mutation, and a Next server component reads directly. Plus `form-state.ts`, which is deliberately
not `'use server'` because such a file may export only async functions and `EMPTY_FORM_STATE` is a
`const`.

The directive is emitted on line 1, ahead of the licence banner.

`@drzl/cli` gains the `next` kind. It is the one generator with a single mode: it emits no schemas
of its own, so `nextOptions` forces `validation.useShared` and derives `validation.importPath` from
the sibling validation generator's own `path`, which makes a two-entry config complete. A config
naming `next` with no validation generator beside it is reported rather than left to fail as an
import of nothing.

That derivation carries one fix worth naming, because the same trap cost a round trip on the MCP
generator: a generator's `path` is project-relative and an `importPath` beginning with `./` is
relative to the *output* directory, so a sibling `path` of `./out/schemas` copied straight across
resolved to `out/next/out/schemas`. The builder strips the prefix, and the branch-parity spec
points its fixture at a non-default directory so a dropped derivation changes the bytes.

The new package is an `optionalDependency` of `@drzl/cli` for this release only, for the reason
`@drzl/generator-mcp` already is: a package name that has never existed cannot publish through npm
trusted publishing.
