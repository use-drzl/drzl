---
'@drzl/cli': minor
'@drzl/validation-core': minor
---

A JSON Schema for `drzl.config.json`, and a config scaffold that completes

`drzl.config.json` has been a supported config form since the loader was written, and it was the
one form with no completion of any kind: a `.ts` config gets the shape from `defineConfig`, a JSON
config got nothing. `@drzl/cli` now ships `dist/drzl.config.schema.json`, generated at build time
from the same zod schema that validates the config, so the two cannot describe different things.
Point at it with a `$schema` key (`./node_modules/@drzl/cli/dist/drzl.config.schema.json`), or map
`drzl.config.json` to it in VS Code's `json.schemas`. The same file is published at
`https://use-drzl.github.io/drzl/drzl.config.schema.json`. `$schema` is stripped by the loader, so
the key is safe to leave in the file.

Two properties of `z.toJSONSchema` decide whether a generated schema is worth shipping, and both
are now measured rather than assumed. Its `io` option defaults to `'output'`, which marks every key
carrying a `.default()` as `required`: `outDir`, `importExtension`, `analyzer` and `generators` are
all defaulted, so that schema rejects all 34 configs in the documentation and every minimal config
a reader writes. The generator passes `io: 'input'`, which rejects none of them. Refinements are
also dropped silently, and `ConfigSchema`'s single `.superRefine` is the affix rule, so the
generated schema would have accepted `affix: { schema: { suffix: 'my-schema' } }` and the CLI would
then have refused to generate from it. The character half of that rule is re-encoded as a JSON
Schema `pattern`, built from the same string `validateAffix` compiles its regex from, and a test
fuzzes the two against each other over every printable ASCII codepoint in three positions. The
collision half, two modes resolving to the same identifier, is a comparison between sibling values
that JSON Schema cannot express; it stays a CLI-only error and is documented as one. Every other
verdict matches the CLI, including unknown keys: permissive where `ConfigSchema` strips them,
`additionalProperties: false` where the zod object is `.strict()`.

`drzl watch` never reloaded a JSON config. `computeWatchTargets` carried its own copy of the config
filenames and the copy was missing `drzl.config.json`, so the file loaded on the initial build and
no later edit to it ever fired an event. Its test spelled the same four names a third time and
agreed with the bug. The loader, the watcher and the test now read one exported
`CONFIG_FILE_NAMES`.

`drzl init` scaffolded a bare `export default { ... } as const`, so the first config a new user
sees was the one with no type attached and no completion. It now emits
`import type { DrzlConfigInput } from '@drzl/cli/config'` and `satisfies DrzlConfigInput`. The
import is type-only on purpose: `drzl init` also runs under `npx` in a project with no local
`@drzl/cli` to resolve, and a type-only import is erased before the config executes, where the
`defineConfig` value import the docs use would have made the first `generate` fail on a missing
module.

`@drzl/validation-core` exports `AFFIX_PREFIX_PATTERN` and `AFFIX_SUFFIX_PATTERN`, the affix
character rule in JSON Schema `pattern` form, beside the regexes that enforce it.
