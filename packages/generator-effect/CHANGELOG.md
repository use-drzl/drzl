# @drzl/generator-effect

## 0.2.0

### Minor Changes

- 3b53229: Add `@drzl/generator-effect`: Effect Schema validators from a Drizzle schema.

  `{ kind: 'effect', path: 'src/validators/effect' }` emits an insert, update and select schema per
  table, built on `effect/Schema` from `effect` core 3.x. Everything the other validation generators
  handle is handled here: every column type the analyzer produces, nullable against optional, CHECK
  constraints through `parseCheck` including the array and JSON guards, declared numeric precision
  and bounds, `maxLength`/`maxBytes`, `applyDefaults`, `typedJson`, `typedColumns`, `duplicateFinder`,
  `coerceDates`, affixes and nested relation schemas.

  Three things differ from the existing four, each measured rather than assumed:

  - **Both a bare and a Standard Schema form are emitted.** A bare `Schema.Struct` carries no
    `~standard` key, so `Standard<Name>` is exported beside every schema as
    `Schema.standardSchemaV1(<Name>)`. The bare form is the one that composes, since the wrapper drops
    `.fields`. This is the difference from TypeBox, which has no route to Standard Schema at all.
  - **`Schema.Number` accepts `NaN` and both infinities**, which is the opposite of `z.number()` and
    `Type.Number()`. Numeric columns therefore build on `Schema.Finite`, unconditionally rather than
    relying on the range, since `Infinity >= 0` is true.
  - **`effect` is an optional peer**, unlike the required validator peers of the other four.
    `drizzle-orm@1.0.0-rc.4` declares its own optional peer on `effect` as
    `>=4.0.0-beta.83 || >=4.0.0`, and npm auto-installs a required peer, so declaring one made
    `npm install @drzl/cli drizzle-orm@1.0.0-rc.4` fail with `ERESOLVE` for every consumer. Install
    `effect` yourself; the floor is 3.13.0, where `Schema.standardSchemaV1` first appears.

  Character limits are counted in code points rather than UTF-16 units, so a `varchar(10)` accepts ten
  astral-plane characters exactly as the database does.

  `ValidationLibrary` in `@drzl/validation-core` gains `'effect'`, and the CLI wires the new kind into
  both the `generate` and `watch` dispatch loops and into `computeGeneratorOutputDirs`.

### Patch Changes

- Updated dependencies [3b53229]
  - @drzl/validation-core@3.18.0
