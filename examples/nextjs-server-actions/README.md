# Next.js: schema to validated server actions

A Drizzle schema, `drzl generate`, and the emitted zod schemas validating what a form posts to a
server action.

Written up at [DRZL docs: Next.js Server Actions](https://use-drzl.github.io/drzl/examples/nextjs-server-actions).

## Run it

From the repository root:

```bash
pnpm install
pnpm --filter @drzl/example-nextjs-server-actions dev
```

`pnpm build` and `pnpm -r test` at the root both include this package, so its `next build` and its
tests run on every commit. Nothing about it is wired into CI separately.

## Layout

| path                      | what it is                                                    |
| ------------------------- | ------------------------------------------------------------- |
| `src/db/schema.ts`        | an ordinary Drizzle schema; nothing in it knows DRZL exists   |
| `src/db/store.ts`         | the database, which is an array in a module                   |
| `drzl.config.ts`          | one zod generator, with `nestedSchemas` and `constraints` on  |
| `src/validators/zod/`     | **generated and checked in**; regenerate with `pnpm generate` |
| `src/app/actions.ts`      | the two server actions, parsing with the emitted schemas      |
| `src/lib/field-errors.ts` | `constraintForIssue` to a message under the right input       |
| `src/app/author-form.tsx` | the form, which knows the field names and nothing else        |
| `test/`                   | the validation path, exercised by calling the actions         |

## Scripts

| script                 | what it does                                                    |
| ---------------------- | --------------------------------------------------------------- |
| `pnpm generate`        | rewrite `src/validators/zod` from the schema                    |
| `pnpm check:generated` | `drzl generate --check`: fail if the checked-in output is stale |
| `pnpm build`           | the check above, then `next build`                              |
| `pnpm test`            | the action tests, with no browser and no server                 |
| `pnpm dev`             | the app, on `http://localhost:3000`                             |

## Two things worth knowing before you copy this

**`importExtension: 'none'`.** DRZL's barrel defaults to `export * from './authors.zod.js'`, and
Next.js does not resolve it. Measured on 16.3.0, `next build` fails with
`Can't resolve './authors.zod.js'` under Turbopack, which is the default bundler, and under
`--webpack` as well. Webpack can be taught with `experimental.extensionAlias`; Turbopack has no
equivalent, so the specifier has to change instead.

**The generated files are committed.** So a clone builds with no generate step in between, and the
emitted schemas can be read next to the code that uses them. `pnpm build` runs
`drzl generate --check` first, which regenerates, compares, restores the tree either way, and exits
`1` on any difference, so a stale file cannot ship.
