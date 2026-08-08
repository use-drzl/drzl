import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: 'src/db/schema.ts',
  outDir: 'src/validators',
  // The default is `js`, which emits `export * from './authors.zod.js'` and is the only form that
  // resolves under every `moduleResolution` tsc offers. Next.js resolves neither: measured on
  // 16.3.0, `next build` fails with `Can't resolve './authors.zod.js'` under Turbopack, which is
  // the default bundler, and under `--webpack` as well. Webpack can be taught with
  // `experimental.extensionAlias`; Turbopack has no equivalent, so nothing in next.config.ts fixes
  // it and the specifier has to change instead.
  importExtension: 'none',
  generators: [
    {
      kind: 'zod',
      path: 'src/validators/zod',
      // `preserve` is the default and would emit `InsertauthorsSchema`. This app reads the
      // identifiers out loud in a form component, so it takes the cased spelling.
      affix: { tableCase: 'pascal' },
      // The whole payload, `{ ...author, posts: [...] }`, as one schema. `db.insert` drops the
      // relation key silently rather than refusing it, so this is the only thing that describes
      // what the second form posts.
      nestedSchemas: true,
      // `constraints.ts` beside the schemas, plus `constraintForIssue`, which is what turns a
      // parse failure into a message on the right field.
      constraints: true,
    },
  ],
});
