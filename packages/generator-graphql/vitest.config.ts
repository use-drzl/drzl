import { defineConfig } from 'vitest/config';

/**
 * Inline the graphql-tools family so its `import 'graphql'` is resolved by vite with the same
 * conditions as the specs' own. graphql 17 publishes a `development` condition pointing at
 * `__dev__/index.mjs` beside the default `index.mjs`; vite resolves the development build for
 * transformed test files while node-native externals load the default one, and two builds of
 * one version are two realms to graphql-js ("Cannot use GraphQLSchema from another module or
 * realm", seen the moment this suite handed a tools-built schema to its own assertValidSchema).
 */
export default defineConfig({
  test: {
    server: {
      deps: {
        inline: [/@graphql-tools\//, /@graphql-typed-document-node\//, /value-or-promise/],
      },
    },
  },
});
