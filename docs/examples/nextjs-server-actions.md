# Next.js: schema to validated server actions

A whole application, in [`examples/nextjs-server-actions`](https://github.com/use-drzl/drzl/tree/master/examples/nextjs-server-actions):
a Drizzle schema, `drzl generate`, and the emitted zod schemas validating what a form posts to a
server action. It builds and its validation is tested on every commit, in this repository, against
the generators in this repository rather than a published version.

Next.js 16, React 19, zod 4, `drizzle-orm` 0.45. The database is an array in a module.

## The one thing it is showing

A constraint is declared once, in `src/db/schema.ts`, and nothing downstream restates it.

```
src/db/schema.ts          check('author_adult', sql`${t.age} >= 18`)
        │
        │  drzl generate
        ▼
src/validators/zod/       age: z.number().int().gte(18).lte(2147483647)
        │                 authorsConstraints -> { id: 'author_adult', bounds: [...] }
        │
        ▼
src/app/actions.ts        InsertAuthorsSchema.safeParse(...)
        │
        ▼
src/lib/field-errors.ts   constraintForIssue('authors', issue) -> 'author_adult'
        │
        ▼
the form                  "Authors have to be 18 or older." under the age input
```

The last step is the one a validator cannot do alone. A zod issue says a value is wrong and never
says **which constraint** said so: zod's wording for a broken `author_adult` never mentions
`author_adult`, so without the [constraint ledger](/generators/constraints) the form could only
render the library's sentence, and could not tell that failure apart from the column's own `int4`
ceiling.

## The config

```ts
// drzl.config.ts
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: 'src/db/schema.ts',
  outDir: 'src/validators',
  generators: [
    {
      kind: 'zod',
      path: 'src/validators/zod',
      // `preserve` is the default and emits `InsertauthorsSchema`. This app reads the identifiers
      // out loud in a form component, so it takes the cased spelling.
      affix: { tableCase: 'pascal' },
      // The whole payload, `{ ...author, posts: [...] }`, as one schema.
      nestedSchemas: true,
      // `constraints.ts` beside the schemas, plus `constraintForIssue`.
      constraints: true,
    },
  ],
});
```

### One line a Next.js app has to add

```ts
// drzl.config.ts, alongside `schema` and `outDir`
importExtension: 'none',
```

DRZL's barrel defaults to `export * from './authors.zod.js'`, which is the only form that resolves
under every `moduleResolution` TypeScript offers. **Next.js does not resolve it.** Measured on
16.3.0, `next build` fails with `Can't resolve './authors.zod.js'` under Turbopack, which is the
default bundler, and under `--webpack` as well. Webpack can be taught with
`experimental.extensionAlias`; Turbopack has no equivalent, so nothing in `next.config.ts` fixes it
and the specifier has to change instead. With `'none'` the barrel reads
`export * from './authors.zod'` and both bundlers resolve it.

The example's checked-in `drzl.config.ts` carries that line. It is not in the block above because
every whole config on this site is extracted and run by `pnpm verify:packed`, against a project
compiled as ESM under `nodenext`, and `'none'` is the one form that does not resolve there. The two
environments genuinely disagree, which is why `importExtension` exists at all. See
[`importExtension`](/guide/configuration#import-extensions) for the full grid.

## What the schema declares

Each of these lands somewhere different in the emitted schemas, and so comes back from
`constraintForIssue` through a different tier.

| declared                             | in the emitted schema           | matched by |
| ------------------------------------ | ------------------------------- | ---------- |
| `varchar('handle', { length: 20 })`  | a `.refine()` with DRZL wording | `message`  |
| `CHECK (length(handle) >= 3)`        | a `.refine()` with DRZL wording | `message`  |
| `CHECK (age >= 18)`                  | the column's numeric range      | `bound`    |
| `CHECK (status IN ('draft','live'))` | `z.enum(['draft', 'live'])`     | `column`   |
| `UNIQUE (handle)`                    | nothing                         | nothing    |
| `FOREIGN KEY (author_id)`            | nothing                         | nothing    |

The last two are why the ledger is not a second copy of the schemas. Uniqueness and foreign keys
are facts about the table rather than about the row, so no per-row validator can carry them. The
example checks the handle itself, after the parse, and reads the wording out of the ledger under
`authors_handle_key`, so a taken handle is reported in the same vocabulary as everything the schema
did catch.

## The action

```ts
// src/app/actions.ts
'use server';

export async function createAuthor(_prev: FormState, data: FormData): Promise<FormState> {
  const parsed = InsertAuthorsSchema.safeParse({
    handle: textField(data, 'handle'),
    email: textField(data, 'email'),
    age: numberField(data, 'age'),
  });

  if (!parsed.success) {
    return { status: 'rejected', errors: fieldErrorsFor('authors', parsed.error.issues) };
  }

  if (handleIsTaken(parsed.data.handle)) {
    return {
      status: 'rejected',
      errors: { handle: [messageForConstraint('authors', 'authors_handle_key')] },
    };
  }

  return { status: 'created', errors: {}, created: insertAuthor(parsed.data).handle };
}
```

and the mapping it delegates to:

```ts
// src/lib/field-errors.ts
export const MESSAGES: Record<string, string> = {
  author_adult: 'Authors have to be 18 or older.',
  handle_len: 'A handle needs at least 3 characters.',
  authors_handle_maxlength: 'A handle is at most 20 characters.',
  authors_handle_key: 'That handle is taken.',
  status_valid: 'A post is either a draft or live.',
  posts_title_maxlength: 'A title is at most 80 characters.',
};

for (const issue of issues) {
  const hit = constraintForIssue(table, issue);
  const message = hit ? (MESSAGES[hit.constraint.id] ?? hit.constraint.rule) : issue.message;
  ...
}
```

`hit.constraint.id` is the stable key: the SQL constraint name where the declaration has one, and a
derived name (`authors_handle_maxlength`) where SQL leaves it anonymous. An issue no constraint
caused, such as the age field failing to be a number at all, gets no attribution and falls back to
zod's own sentence, which is the correct answer rather than a gap.

## The nested payload

The second form posts an author and their first posts in one submit, and
`NestedInsertAuthorsSchema` is the only thing that describes it:
`db.insert(authors).values({ ..., posts: [...] })` drops the `posts` key silently on both Drizzle
majors, so the children are never written and nothing says so. See
[Nested Relation Schemas](/generators/nested-relations).

`posts[0].authorId` is absent from the schema, because there is no value to supply until the parent
row exists. The action mints it between the two writes.

One thing to know: `constraintForIssue` is told which table to look in by its caller, so an issue
under `posts` has to be looked up in `posts`. Handing a child's issue to the parent's name answers
with whatever the parent happens to have under that column name. The example routes on the relation
key, which is the child table's Drizzle export name.

## How it is tested, without a browser

A server action is a function. Next's contribution is that a form post reaches it, and a test does
not need that: the payload a browser would send is a `FormData`, which is a global.

```ts
const state = await createAuthor(EMPTY_FORM_STATE, form({ ...GOOD, age: '15' }));

expect(state.status).toBe('rejected');
expect(state.errors).toEqual({ age: [MESSAGES.author_adult] });
expect(listAuthors()).toEqual([]);
```

Twenty tests, no Playwright, no server, no Next runtime. Deleting the `constraintForIssue` call and
falling back to zod's wording fails five of them, which is how the suite was checked to be
measuring the mapping rather than the parse.

`src/lib/field-errors.ts` also has a test that every key in `MESSAGES` is a constraint id the
emitted ledger actually carries. Rename a CHECK in the schema, regenerate, and the lookup would
otherwise fall back to the raw SQL rule while still rendering something plausible.

## Why the database is an array

PGlite would give the example a real Postgres in about two and a half seconds, and it was
deliberately not used. What is being demonstrated is a request body validated before anything
touches storage, and every constraint in the schema either lands in the emitted schemas or is
checked against rows the store already holds. A real engine would add a wasm dependency and an
async init to a page render without moving a single assertion. The row types still come from the
Drizzle schema, so a column renamed there stops the store compiling.

## Generated files are checked in

`src/validators/zod` is committed, so `git clone && pnpm install && pnpm build` works with no
generate step in between, and the emitted schemas can be read next to the code that uses them,
which is half the point of an example.

Staleness is the obvious objection, and `--check` answers it. The example's build script is:

```json
"build": "pnpm check:generated && next build"
```

where `check:generated` is `drzl generate --check`. It regenerates, compares against what is on
disk, restores the tree either way, and exits `1` on any difference. A hand-edited generated file
and a schema changed without regenerating both fail the build. See
[`generate --check`](/cli/generate#check-fail-ci-when-generated-output-is-stale).

## Running it

```bash
pnpm install
pnpm --filter @drzl/example-nextjs-server-actions dev
```

`pnpm build` and `pnpm -r test` at the repository root both include it, so there is no separate
command to remember and no separate CI job to keep in step.
